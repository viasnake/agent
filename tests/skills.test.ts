import assert from "node:assert/strict";
import test from "node:test";
import { link, mkdir, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  Application,
  inferAccess,
  inferKind,
  fileReferences,
} from "../src/application.js";
import {
  loadPreparedInput,
  maxSkillBytes,
  parseDocumentToken,
  prepareDocument,
} from "../src/documents.js";
import {
  listSkills,
  listSkillReferences,
  readSkill,
  skillAttachments,
} from "../src/skills.js";
import { call, fixture, gitWorkspace, ScriptedRuntime } from "./helpers.js";

const entry = "skills/write/SKILL.md";
const resource = "skills/write/references/style.md";
const body = "# 日本語の確認\n数値を変えず、出典を確認する。\n";

test("skills are explicit bounded whole-file inputs with immutable identity, not auto-loaded plugins", async () => {
  const runtime = new ScriptedRuntime(async () =>
    assert.fail("No inference during selection"),
  );
  const f = await fixture(runtime);
  try {
    const workspace = await gitWorkspace(f.root, {
      [entry]: `\ufeff${body}`,
      [resource]: "明示した補足資料",
      "skills/write/scripts/run.sh": "exit 99",
    });
    assert.deepEqual(
      (await listSkills(workspace)).files.map((file) => file.path),
      [entry],
    );
    assert.deepEqual(
      (await listSkillReferences(workspace, entry)).files.map(
        (file) => file.path,
      ),
      [resource],
    );
    assert.equal((await readSkill(workspace, entry)).text, `\ufeff${body}`);
    assert.deepEqual(fileReferences(skillAttachments(entry, [resource])), [
      `skill:${entry}`,
      resource,
    ]);
    const prepared = await prepareDocument(
      f.p,
      join(workspace, entry),
      `skill:${entry}`,
      1000,
    );
    assert.equal(prepared.reference.format, "skill");
    assert.equal(prepared.reference.partial, false);
    assert.equal(
      prepared.reference.rawSha256,
      prepared.reference.selectedSha256,
    );
    const document = await prepareDocument(
      f.p,
      join(workspace, entry),
      entry,
      1000,
    );
    assert.notEqual(document.reference.id, prepared.reference.id);
    await unlink(join(workspace, entry));
    assert.equal(
      (await loadPreparedInput(f.p, prepared.reference)).text,
      `\ufeff${body}`,
    );
    assert.equal(runtime.requests.length, 0);
  } finally {
    await f.cleanup();
  }
});

test("skill selection rejects linked, protected, oversized, partial and malformed entrypoints", async () => {
  const f = await fixture(
    new ScriptedRuntime(async () => assert.fail("No provider")),
  );
  try {
    const workspace = await gitWorkspace(f.root, {
      [entry]: body,
      [resource]: "reference",
    });
    await mkdir(join(workspace, "skills/linked"));
    await symlink(
      join(workspace, entry),
      join(workspace, "skills/linked/SKILL.md"),
    );
    await mkdir(join(workspace, "skills/hard"));
    await link(join(workspace, entry), join(workspace, "skills/hard/SKILL.md"));
    await assert.rejects(
      readSkill(workspace, "skills/linked/SKILL.md"),
      /Links|linked/,
    );
    await assert.rejects(
      readSkill(workspace, "skills/hard/SKILL.md"),
      /Links|linked/,
    );
    await unlink(join(workspace, "skills/hard/SKILL.md"));
    for (const path of [
      "../outside/SKILL.md",
      ".agents/skills/example/SKILL.md",
      ".env/SKILL.md",
      join(workspace, entry),
    ])
      await assert.rejects(readSkill(workspace, path));
    assert.throws(() => parseDocumentToken(`skill:${entry}::lines=1-2`));
    assert.throws(() => parseDocumentToken("skill:README.md"));
    assert.throws(() =>
      skillAttachments(entry, ["skills/write/references/../scripts/run.sh"]),
    );
    await assert.rejects(
      prepareDocument(f.p, join(workspace, entry), `skill:${entry}`, 2),
      /fit in full/,
    );
    await writeFile(
      join(workspace, entry),
      Buffer.alloc(maxSkillBytes + 1, 65),
    );
    await assert.rejects(readSkill(workspace, entry));
    await writeFile(join(workspace, entry), Buffer.from([0xff, 0x00]));
    await assert.rejects(readSkill(workspace, entry));
    const catalog = await listSkills(workspace);
    assert.ok(catalog.skipped > 0);
  } finally {
    await f.cleanup();
  }
});

test("confirmed skill snapshots survive source edits and only the current request selects a procedure", async () => {
  const runtime = new ScriptedRuntime(async (request, index) => {
    const objective = JSON.parse(request.objective);
    assert.match(request.system, /untrusted reference documents/);
    assert.ok(
      !request.tools.some((tool) =>
        ["write_file", "run_command", "shell"].includes(tool.name),
      ),
    );
    if (index === 0) {
      assert.equal(objective.selectedSkills.length, 1);
      const selected = objective.selectedSkills[0];
      assert.match(selected.locator, /skills\/write\/SKILL\.md/);
      const source = await call(request, "read_source", {
        id: selected.sourceId,
      });
      assert.match(source, /出典を確認/);
      assert.doesNotMatch(source, /REPLACED/);
    } else assert.deepEqual(objective.selectedSkills, []);
    return "確認しました。";
  });
  const f = await fixture(runtime);
  const workspace = await gitWorkspace(f.root, {
    [entry]: body,
    [resource]: "補足",
  });
  let app = new Application(
    f.config,
    f.p,
    f.store,
    workspace,
    async () => runtime,
  );
  try {
    await app.initialize();
    const text = `手順を説明して\n${skillAttachments(entry, [resource])}`;
    app.setDraft(text);
    const sessionId = app.session.id;
    await app.close();
    app = new Application(
      f.config,
      f.p,
      f.store,
      workspace,
      async () => runtime,
    );
    await app.initialize();
    app.openSession(sessionId);
    assert.equal(app.session.id, sessionId);
    assert.equal(app.session.draft, text);
    const preview = await app.previewInput(text);
    assert.equal(preview.access, "read-only");
    assert.equal(preview.documents[0]!.format, "skill");
    assert.equal(preview.documents.length, 2);
    assert.equal(runtime.requests.length, 0);
    await writeFile(join(workspace, entry), "REPLACED");
    await app.submit(text, "instruction", preview);
    await app.waitForIdle();
    assert.equal(
      app.currentRun()?.state,
      "succeeded",
      app.currentRun()?.reason,
    );
    assert.equal(runtime.requests.length, 1);
    const skill = app
      .currentRun()!
      .preparedInputs!.find((input) => input.format === "skill")!;
    assert.equal(skill.selectedSha256, preview.documents[0]!.selectedSha256);
    await app.submit("ありがとう");
    await app.waitForIdle();
    assert.equal(
      app.currentRun()?.state,
      "succeeded",
      app.currentRun()?.reason,
    );
    assert.equal(runtime.requests.length, 2);
    await writeFile(join(workspace, entry), body);
    app.session.context!.excludedSourceHashes = [skill.rawSha256];
    await assert.rejects(app.previewInput(text), /excluded/i);
  } finally {
    await app.close();
    await f.cleanup();
  }
});

test("skill paths cannot authorize changes and CLI skill inputs cannot escape the workspace", async () => {
  assert.equal(inferAccess(`@"skill:${entry}"`), "read-only");
  assert.equal(inferKind(`@"skill:${entry}"`), "chat");
  assert.equal(inferAccess(`実装して @"skill:${entry}"`), "change");
  const f = await fixture(
    new ScriptedRuntime(async () => assert.fail("Prepare only")),
  );
  try {
    const workspace = await gitWorkspace(f.root, { [entry]: body });
    await assert.rejects(
      f.harness.create({
        objective: "Explain",
        kind: "chat",
        inputs: [`skill:${entry}`],
      }),
      /workspace/,
    );
    await assert.rejects(
      f.harness.create({
        objective: "Explain",
        kind: "chat",
        workspace,
        inputs: ["skill:../SKILL.md"],
      }),
    );
    const run = await f.harness.create({
      objective: "Explain",
      kind: "chat",
      workspace,
      inputs: [`skill:${entry}`],
    });
    assert.equal(run.preparedInputs?.[0]?.format, "skill");
    assert.equal(run.preparedInputs?.[0]?.partial, false);
  } finally {
    await f.cleanup();
  }
});
