import assert from "node:assert/strict";
import { readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { Application } from "../src/application.js";
import {
  fixture,
  gitWorkspace,
  ScriptedRuntime,
  testConfig,
} from "./helpers.js";
import { searchLocal } from "../src/search.js";

async function setup() {
  const runtime = new ScriptedRuntime(async () => "unused");
  const f = await fixture(runtime, testConfig());
  const workspace = await gitWorkspace(f.root, { "README.md": "fixture\n" });
  const app = new Application(
    f.config,
    f.p,
    f.store,
    workspace,
    async () => runtime,
  );
  await app.initialize();
  return { ...f, app, runtime, workspace };
}

test("search paginates literal message matches without executing runtime", async () => {
  const f = await setup();
  try {
    for (let index = 0; index < 110; index++)
      f.app.conversations.message(f.app.session, "user", `unrelated ${index}`);
    for (let index = 0; index < 35; index++)
      f.app.conversations.message(
        f.app.session,
        "user",
        `日本語 [literal]*? ${index}`,
      );
    const first = await f.app.search({
        kind: "messages",
        text: "日本語 [literal]*?",
      }),
      second = await f.app.search({
        kind: "messages",
        text: "日本語 [literal]*?",
        cursor: first.cursor,
      }),
      third = await f.app.search({
        kind: "messages",
        text: "日本語 [literal]*?",
        cursor: second.cursor,
      });
    assert.equal(first.hits.length, 0);
    assert.equal(first.scanned, 100);
    assert.ok(first.cursor);
    assert.equal(second.hits.length, 30);
    assert.ok(second.cursor);
    assert.equal(third.hits.length, 5);
    assert.equal(third.cursor, undefined);
    assert.equal(f.runtime.requests.length, 0);
    assert.match(
      (await f.app.readSearchResult(second.hits[0]!)).text,
      /日本語/,
    );
    await assert.rejects(
      f.app.search({ kind: "messages", text: "   " }),
      (error: { code?: string }) => error.code === "SEARCH_INPUT",
    );
  } finally {
    await f.app.close();
    await f.cleanup();
  }
});

test("search enforces workspace ownership and rejects forged IDs", async () => {
  const f = await setup();
  try {
    const other = f.app.conversations.create(f.app.session.workspace, {
      dataClass: "private",
      checks: [],
    });
    f.app.conversations.message(other, "user", "same workspace text");
    f.app.conversations.release(other.id);
    const foreign = f.app.conversations.create(join(f.root, "foreign"), {
      dataClass: "private",
      checks: [],
    });
    f.app.conversations.message(foreign, "user", "foreign text");
    f.app.conversations.release(foreign.id);
    const page = await f.app.search({
      kind: "messages",
      text: "same workspace",
    });
    assert.equal(page.hits.length, 1);
    const forged = { ...page.hits[0]!, conversationId: foreign.id };
    await assert.rejects(
      f.app.readSearchResult(forged),
      (error: { code?: string }) => error.code === "SEARCH_SCOPE",
    );
    await assert.rejects(
      f.app.readSearchResult({
        ...page.hits[0]!,
        runId: "00000000-0000-4000-8000-000000000000",
      }),
      (error: { code?: string }) => error.code === "SEARCH_STALE",
    );
    await assert.rejects(
      f.app.search({
        kind: "messages",
        text: "foreign",
        conversationId: foreign.id,
      }),
      (error: { code?: string }) => error.code === "SEARCH_SCOPE",
    );
  } finally {
    await f.app.close();
    await f.cleanup();
  }
});

test("search reads runs, events and artifacts while omitting raw and bounded bodies", async () => {
  const f = await setup();
  try {
    const run = await f.harness.create({
      kind: "coding",
      objective: "find this task objective",
      workspace: f.workspace,
      conversationId: f.app.session.id,
      includeUntracked: true,
    });
    f.app.conversations.link(f.app.session, run);
    const owner = f.store.claim(run.id);
    owner.tasks = [
      {
        id: "task-1",
        objective: "task body marker",
        role: "worker",
        dependsOn: [],
        write: false,
        state: "succeeded",
        attempts: 1,
      },
    ];
    f.store.save(owner, "fixture_event", { body: "event body marker" });
    const artifact = await f.store.artifact(
      owner,
      "report.txt",
      "report",
      "artifact body marker",
    );
    await f.store.artifact(owner, "raw.txt", "source-raw", "raw hidden marker");
    await f.store.artifact(
      owner,
      "binary.bin",
      "document",
      Buffer.from([0, 1, 2, 3]),
    );
    await f.store.artifact(
      owner,
      "large.txt",
      "document",
      Buffer.alloc(1_100_001, 65),
    );
    f.store.release(owner);
    const runPage = await f.app.search({
        kind: "runs",
        text: "task body marker",
      }),
      eventPage = await f.app.search({
        kind: "events",
        text: "event body marker",
      }),
      artifactPage = await f.app.search({
        kind: "artifacts",
        text: "artifact body marker",
      }),
      rawPage = await f.app.search({
        kind: "artifacts",
        text: "raw hidden marker",
      }),
      binaryPage = await f.app.search({
        kind: "artifacts",
        text: "binary.bin",
      }),
      largePage = await f.app.search({ kind: "artifacts", text: "large.txt" });
    assert.equal(runPage.hits.length, 1);
    assert.equal(eventPage.hits.length, 1);
    assert.equal(artifactPage.hits[0]?.id, artifact.id);
    assert.equal(rawPage.hits.length, 0);
    assert.match(binaryPage.warnings.join("\n"), /バイナリ/);
    assert.match(largePage.warnings.join("\n"), /大きな/);
    assert.match(
      (await f.app.readSearchResult(artifactPage.hits[0]!)).text,
      /artifact body marker/,
    );
    const artifactPath = join(
      f.store.runDir(run.id),
      "artifacts",
      artifact.sha256,
    );
    await writeFile(artifactPath, "corrupt");
    await assert.rejects(
      f.app.readSearchResult(artifactPage.hits[0]!),
      (error: { code?: string }) => error.code === "ARTIFACT_CORRUPT",
    );
  } finally {
    await f.app.close();
    await f.cleanup();
  }
});

test("search centers late body matches and keeps conversation names independent", async () => {
  const f = await setup();
  try {
    const body = "前".repeat(30_000) + "😀late needle";
    f.app.conversations.message(f.app.session, "user", body);
    const messagePage = await f.app.search({
      kind: "messages",
      text: "late needle",
    });
    assert.equal(messagePage.hits.length, 1);
    assert.ok((messagePage.hits[0]?.matchOffset ?? 0) > 20_000);
    assert.match(messagePage.hits[0]!.excerpt, /late needle/);
    const message = await f.app.readSearchResult(messagePage.hits[0]!);
    assert.match(message.text, /1: .*late needle/);
    assert.ok(Buffer.byteLength(message.text) <= 32_000);
    await assert.rejects(
      f.app.readSearchResult({
        ...messagePage.hits[0]!,
        matchOffset: messagePage.hits[0]!.matchOffset! - 1,
      }),
      { code: "SEARCH_INPUT" },
    );

    const named = f.app.conversations.create(f.app.session.workspace, {
      dataClass: "private",
      checks: [],
    });
    named.name = "tiny searchable conversation";
    named.handoff = "x".repeat(1_100_000);
    f.app.conversations.save(named);
    f.app.conversations.release(named.id);
    const namePage = await f.app.search({
      kind: "conversations",
      text: "tiny searchable",
    });
    assert.equal(namePage.hits.length, 1);
    assert.equal(
      (await f.app.readSearchResult(namePage.hits[0]!)).title,
      named.name,
    );
    const longNamed = f.app.conversations.create(f.app.session.workspace, {
      dataClass: "private",
      checks: [],
    });
    longNamed.name = "前".repeat(15_000) + "名前末尾";
    f.app.conversations.save(longNamed);
    f.app.conversations.release(longNamed.id);
    const longNamePage = await f.app.search({
      kind: "conversations",
      text: "名前末尾",
    });
    const longNameResult = await f.app.readSearchResult(longNamePage.hits[0]!);
    assert.match(longNameResult.text, /名前末尾/);
    assert.ok(Buffer.byteLength(longNameResult.text) <= 32_000);
    assert.ok(Buffer.byteLength(longNameResult.title) <= 400);
  } finally {
    await f.app.close();
    await f.cleanup();
  }
});

test("search reserves complete run payloads before continuing on the page budget", async () => {
  const f = await setup();
  try {
    for (let index = 0; index < 9; index++) {
      const run = await f.harness.create({
        kind: "coding",
        objective: `budget marker ${index}`,
        workspace: f.workspace,
        conversationId: f.app.session.id,
        includeUntracked: true,
      });
      f.app.conversations.link(f.app.session, run);
      const owner = f.store.claim(run.id);
      owner.context = "x".repeat(1_000_000);
      f.store.save(owner, "fixture_event", { index });
      f.store.release(owner);
    }
    const first = await f.app.search({ kind: "runs", text: "budget marker" });
    assert.equal(first.hits.length, 8);
    assert.ok(first.cursor);
    const second = await f.app.search({
      kind: "runs",
      text: "budget marker",
      cursor: first.cursor,
    });
    assert.equal(second.hits.length, 1);
    assert.equal(second.cursor, undefined);
  } finally {
    await f.app.close();
    await f.cleanup();
  }
});

test("search reports a limit when the clock expires before its first candidate", async () => {
  const f = await setup();
  try {
    f.app.conversations.message(f.app.session, "user", "clock marker");
    let tick = 0;
    await assert.rejects(
      searchLocal(
        {
          store: f.store,
          workspace: f.app.session.workspace,
          currentConversationId: f.app.session.id,
          currentWorkRunId: undefined,
          maxWorkspaceBytes: f.config.limits.maxWorkspaceBytes,
          now: () => (tick++ === 0 ? 0 : 5_001),
        },
        { kind: "messages", text: "clock marker" },
      ),
      (error: { code?: string }) => error.code === "SEARCH_LIMIT",
    );
  } finally {
    await f.app.close();
    await f.cleanup();
  }
});

test("file search reports lines and rejects stale work copies", async () => {
  const f = await setup();
  try {
    const run = await f.harness.create({
      kind: "coding",
      objective: "file search",
      workspace: f.workspace,
      conversationId: f.app.session.id,
      includeUntracked: true,
    });
    f.app.conversations.link(f.app.session, run);
    f.app.session.latestRunId = run.id;
    f.app.session.workRunId = run.id;
    f.app.conversations.save(f.app.session);
    const path = join(f.store.runDir(run.id), "work", "notes.txt");
    await writeFile(path, "first line\nneedle here\n");
    for (let index = 0; index < 31; index++)
      await writeFile(
        join(f.store.runDir(run.id), "work", `match-${index}.txt`),
        `needle ${index}\n`,
      );
    const original = await readFile(join(f.workspace, "README.md"));
    const page = await f.app.search({
      kind: "files",
      text: "needle",
      conversationId: f.app.session.id,
      runId: run.id,
    });
    assert.equal(page.hits.length, 30);
    assert.ok(page.cursor);
    assert.equal(page.scanned, 31);
    const notes = await f.app.search({
      kind: "files",
      text: "notes.txt",
      conversationId: f.app.session.id,
      runId: run.id,
    });
    assert.equal(notes.hits.length, 1);
    assert.equal(notes.hits[0]?.line, undefined);
    const linePage = await f.app.search({
      kind: "files",
      text: "needle here",
      conversationId: f.app.session.id,
      runId: run.id,
    });
    assert.equal(linePage.hits[0]?.line, 2);
    const before = await readFile(path);
    assert.match(
      (await f.app.readSearchResult(linePage.hits[0]!)).text,
      /needle/,
    );
    assert.deepEqual(await readFile(path), before);
    await writeFile(
      join(f.store.runDir(run.id), "work", "match-30.txt"),
      "changed\n",
    );
    await assert.rejects(
      f.app.search({
        kind: "files",
        text: "needle",
        conversationId: f.app.session.id,
        runId: run.id,
        cursor: page.cursor,
      }),
      (error: { code?: string }) => error.code === "SEARCH_STALE",
    );
    await writeFile(path, "changed\n");
    await assert.rejects(
      f.app.readSearchResult(linePage.hits[0]!),
      (error: { code?: string }) => error.code === "SEARCH_STALE",
    );
    assert.deepEqual(await readFile(join(f.workspace, "README.md")), original);
  } finally {
    await f.app.close();
    await f.cleanup();
  }
});

test("file search rejects protected and linked workspace entries", async () => {
  const f = await setup();
  try {
    const run = await f.harness.create({
      kind: "coding",
      objective: "file safety",
      workspace: f.workspace,
      conversationId: f.app.session.id,
      includeUntracked: true,
    });
    f.app.conversations.link(f.app.session, run);
    f.app.session.latestRunId = run.id;
    f.app.session.workRunId = run.id;
    f.app.conversations.save(f.app.session);
    const work = join(f.store.runDir(run.id), "work");
    await writeFile(join(work, ".env"), "do not read");
    await assert.rejects(
      f.app.search({
        kind: "files",
        text: "do not read",
        conversationId: f.app.session.id,
        runId: run.id,
      }),
      (error: { code?: string }) => error.code === "WORKSPACE_CONTENT",
    );
    await rm(join(work, ".env"));
    await symlink(join(work, "README.md"), join(work, "linked.txt"));
    await assert.rejects(
      f.app.search({
        kind: "files",
        text: "fixture",
        conversationId: f.app.session.id,
        runId: run.id,
      }),
      (error: { code?: string }) => error.code === "WORKSPACE_CONTENT",
    );
  } finally {
    await f.app.close();
    await f.cleanup();
  }
});
