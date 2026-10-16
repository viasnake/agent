import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Application } from "../src/application.js";
import { Conversations } from "../src/conversations.js";
import { Sandbox } from "../src/sandbox.js";
import { AgentError, type Task } from "../src/types.js";
import { Evaluator } from "../src/validation.js";
import { fixture, ScriptedRuntime } from "./helpers.js";

async function writeValidatedDocument(
  app: Application,
  f: Awaited<ReturnType<typeof fixture>>,
  content: string,
) {
  const run = await f.harness.create({
    kind: "writing",
    access: "change",
    objective: "Write an article",
    dataClass: "private",
    conversationId: app.session.id,
  });
  new Conversations(f.store).link(app.session, run);
  const work = join(f.store.runDir(run.id), "work");
  await mkdir(work, { recursive: true });
  await writeFile(join(work, "article.md"), content);
  const owned = f.store.claim(run.id);
  const task: Task = {
    id: "fixture-task",
    objective: "Write the article",
    role: "worker",
    dependsOn: [],
    model: "worker",
    write: true,
    state: "succeeded",
    attempts: 1,
    result: {
      outcome: "completed",
      summary: "Wrote the requested article",
      artifacts: ["article.md"],
      unresolved: [],
    },
  };
  owned.tasks = [task];
  owned.mustKeep = ["required phrase"];
  f.store.save(owned, "fixture_output");
  const checks = await new Evaluator(
    f.config,
    f.store,
    new Sandbox(f.config.execution),
  ).validate(owned, new AbortController().signal);
  assert.ok(checks.every((check) => check.passed));
  f.store.release(owned);
  return run;
}

test("history, provenance and diffs are authorized and linked to actual validation artifacts", async () => {
  const f = await fixture(new ScriptedRuntime(async () => "unused"));
  const app = new Application(f.config, f.p, f.store, f.root, async () => {
    throw new Error("No provider should be created");
  });
  try {
    await app.initialize();
    const firstRun = await writeValidatedDocument(
      app,
      f,
      "required phrase\nFirst version\n",
    );
    await new Promise((resolve) => setTimeout(resolve, 2));
    const secondRun = await writeValidatedDocument(
      app,
      f,
      "required phrase\nSecond version\n",
    );
    const history = await app.artifactHistory("article.md");
    assert.equal(history.length, 2);
    assert.equal(history[0]!.run.id, secondRun.id);
    assert.equal(history[1]!.run.id, firstRun.id);
    assert.ok(history.every((entry) => entry.provenanceId));

    const provenance = await app.artifactProvenance(history[0]!.artifact.id);
    assert.equal(provenance.status, "available");
    if (provenance.status !== "available") throw new Error("legacy provenance");
    assert.equal(provenance.artifactSha256, history[0]!.artifact.sha256);
    assert.equal(provenance.producingRunId, secondRun.id);
    assert.equal(provenance.semanticCorrectness, "not-established");
    const validation = f.store
      .artifacts(secondRun.id)
      .find((artifact) => artifact.id === provenance.validation.artifactId);
    assert.equal(validation?.kind, "check");

    const diff = await app.artifactDiff(
      history[1]!.artifact.id,
      history[0]!.artifact.id,
    );
    assert.match(diff.patch, /First version/);
    assert.match(diff.patch, /Second version/);

    const legacyOwner = f.store.claim(secondRun.id, true);
    const legacy = await f.store.artifact(
      legacyOwner,
      "legacy.txt",
      "document",
      "legacy text",
    );
    f.store.release(legacyOwner);
    const legacyProvenance = await app.artifactProvenance(legacy.id);
    assert.equal(legacyProvenance.status, "unknown");

    await app.newSession();
    await assert.rejects(
      app.artifactProvenance(history[0]!.artifact.id),
      (error) => error instanceof AgentError && error.code === "ARTIFACT",
    );
    await assert.rejects(
      app.artifactDiff(history[1]!.artifact.id, history[0]!.artifact.id),
      (error) => error instanceof AgentError && error.code === "ARTIFACT",
    );
    assert.deepEqual(await app.artifactHistory("article.md"), []);
  } finally {
    await app.close();
    await f.cleanup();
  }
});

test("history preserves failed and repaired document versions saved in one run", async () => {
  const f = await fixture(new ScriptedRuntime(async () => "unused"));
  const app = new Application(f.config, f.p, f.store, f.root, async () => {
    throw new Error("No provider should be created");
  });
  try {
    await app.initialize();
    const run = await f.harness.create({
      kind: "writing",
      access: "change",
      objective: "Repair a document",
      dataClass: "private",
      conversationId: app.session.id,
    });
    new Conversations(f.store).link(app.session, run);
    const owned = f.store.claim(run.id);
    const failed = await f.store.artifact(
      owned,
      "article.md",
      "document",
      "failed draft\n",
    );
    const repaired = await f.store.artifact(
      owned,
      "article.md",
      "document",
      "repaired draft\n",
    );
    f.store.release(owned);
    const history = await app.artifactHistory("article.md");
    assert.deepEqual(
      history.map((entry) => entry.artifact.id),
      [repaired.id, failed.id],
    );
  } finally {
    await app.close();
    await f.cleanup();
  }
});

test("artifact diffs reject invalid UTF-8 and enforce byte limits", async () => {
  const f = await fixture(new ScriptedRuntime(async () => "unused"));
  const app = new Application(f.config, f.p, f.store, f.root, async () => {
    throw new Error("No provider should be created");
  });
  try {
    await app.initialize();
    const run = await f.harness.create({
      kind: "writing",
      access: "change",
      objective: "Write an article",
      dataClass: "private",
      conversationId: app.session.id,
    });
    new Conversations(f.store).link(app.session, run);
    const owned = f.store.claim(run.id);
    const invalid = await f.store.artifact(
      owned,
      "invalid.txt",
      "document",
      Buffer.from([0xff]),
    );
    const valid = await f.store.artifact(
      owned,
      "valid.txt",
      "document",
      "valid text",
    );
    const binary = await f.store.artifact(
      owned,
      "binary.txt",
      "document",
      Buffer.from("text\0with binary data"),
    );
    f.store.release(owned);
    await assert.rejects(
      app.artifactDiff(invalid.id, valid.id),
      (error) => error instanceof AgentError && error.code === "DIFF_ENCODING",
    );
    await assert.rejects(
      app.artifactDiff(valid.id, binary.id),
      (error) => error instanceof AgentError && error.code === "DIFF_ENCODING",
    );
  } finally {
    await app.close();
    await f.cleanup();
  }
});

test("provenance reads enforce the configured size limit", async () => {
  const f = await fixture(new ScriptedRuntime(async () => "unused"));
  f.config.limits.maxFileBytes = 10;
  const app = new Application(f.config, f.p, f.store, f.root, async () => {
    throw new Error("No provider should be created");
  });
  try {
    await app.initialize();
    const run = await f.harness.create({
      kind: "writing",
      access: "change",
      objective: "Write an article",
      dataClass: "private",
      conversationId: app.session.id,
    });
    new Conversations(f.store).link(app.session, run);
    const owned = f.store.claim(run.id);
    const document = await f.store.artifact(
      owned,
      "article.md",
      "document",
      "x",
    );
    await f.store.artifact(
      owned,
      `provenance/${document.id}.json`,
      "report",
      "x".repeat(11),
      { type: "provenance", documentId: document.id },
    );
    f.store.release(owned);
    await assert.rejects(
      app.artifactProvenance(document.id),
      (error) => error instanceof AgentError && error.code === "ARTIFACT_SIZE",
    );
  } finally {
    await app.close();
    await f.cleanup();
  }
});
