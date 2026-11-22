import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { skillsFixture } from "./skills-fixture.js";
import { answer, call, fixture, until } from "./support.js";

const idle = async (
  service: Awaited<ReturnType<typeof fixture>>["service"],
  id: string,
) => until(async () => (await service.conversation(id)).status === "idle");
const draft = (name: string, body: string) => ({
  name,
  content: `---\nname: ${name}\ndescription: Verified instructions\n---\n${body}`,
  summary: "手順を整理",
});

test("ordinary work can create a Skill, but never overwrite a manual Skill", async () => {
  const s = await skillsFixture();
  await s.add("manual");
  const newSkill = draft("new-skill", "Checked the steps");
  const f = await fixture(
    [
      call("skill_save", draft("manual", "Unauthorized")),
      call("skill_save", newSkill),
      answer("Prepared"),
    ],
    { root: s.root, skills: s.loader },
  );
  try {
    const { id } = await f.service.create(randomUUID(), "Work");
    const request = randomUUID();
    await f.service.send(id, request, "再利用できる手順を確認して");
    await until(async () => !!(await f.service.conversation(id)).skillNotice);
    assert.match(
      (await f.service.conversation(id)).skillNotice!,
      /登録しました：手順を整理/,
    );
    await f.service.send(id, request, "再利用できる手順を確認して");
    assert.equal(
      (await s.loader.detail("new-skill")).content,
      newSkill.content,
    );
    assert.match(
      (await s.loader.detail("manual")).content,
      /PRIVATE SKILL BODY/,
    );
    const view = await f.service.skillsManagement();
    assert.equal(
      view.skills.find((skill) => skill.name === "new-skill")?.autoUpdate,
      true,
    );
    assert.equal(
      view.skills.find((skill) => skill.name === "manual")?.autoUpdate,
      false,
    );
  } finally {
    await f.service.close();
    await rm(s.root, { recursive: true });
  }
});

test("a user can cancel a pending auto-update without stopping the terminal and resume later", async () => {
  const s = await skillsFixture();
  const directory = await s.add("existing");
  const resource = join(directory, "reference.txt");
  await writeFile(resource, "unchanged");
  const update = draft("existing", "New body");
  const f = await fixture(
    [
      call("skill_save", update),
      answer("Prepared"),
      call("skill_save", update),
      answer("Prepared again"),
    ],
    { root: s.root, skills: s.loader },
  );
  const toggle = async (enabled: boolean) =>
    f.service.changeSkill({
      kind: "auto-update",
      name: "existing",
      enabled,
      revision: (await s.loader.detail("existing")).revision,
    });
  let closeTerminal!: () => void;
  const terminalClosed = new Promise<void>((resolve) => {
    closeTerminal = resolve;
  });
  let terminalReady = false;
  f.service.runner.terminal = async () => {
    terminalReady = true;
    await terminalClosed;
  };
  const terminal = f.service.terminal(
    { ready() {}, output() {} },
    new AbortController().signal,
  );
  try {
    await until(async () => terminalReady);
    await toggle(true);
    const previous = await s.loader.discover();
    const { id } = await f.service.create(randomUUID(), "Update");
    await f.service.send(id, randomUUID(), "今日確認した手順を反映して");
    await idle(f.service, id);
    assert.equal((await f.service.conversation(id)).skillNotice, undefined);
    assert.match(
      (await s.loader.detail("existing")).content,
      /PRIVATE SKILL BODY/,
    );
    await toggle(false);
    assert.deepEqual(
      (await s.loader.discover()).versions(),
      previous.versions(),
    );
    assert.deepEqual((await previous.activate("existing")).resources, [
      "reference.txt",
    ]);
    closeTerminal();
    await terminal;
    assert.match(
      (await f.service.conversation(id)).skillNotice!,
      /保存できませんでした/,
    );
    assert.match(
      (await s.loader.detail("existing")).content,
      /PRIVATE SKILL BODY/,
    );
    await toggle(true);
    await f.service.send(id, randomUUID(), "検証済みの修正を適用して");
    await until(async () => !!(await f.service.conversation(id)).skillNotice);
    assert.match(
      (await f.service.conversation(id)).skillNotice!,
      /更新しました/,
    );
    assert.equal((await s.loader.detail("existing")).content, update.content);
    assert.equal(await readFile(resource, "utf8"), "unchanged");
  } finally {
    closeTerminal();
    await terminal;
    await f.service.close();
    await rm(s.root, { recursive: true });
  }
});
