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

test("failed citations retain validation and provenance after repair and later source inheritance", async () => {
  const f = await fixture(new ScriptedRuntime(async () => "unused"));
  const app = new Application(f.config, f.p, f.store, f.root, async () => {
    throw new Error("No provider should be created");
  });
  try {
    await app.initialize();
    const run = await f.harness.create({
      kind: "research",
      access: "change",
      objective: "Write a sourced report",
      conversationId: app.session.id,
      dataClass: "private",
    });
    app.conversations.link(app.session, run);
    const owner = f.store.claim(run.id);
    const source = await f.store.artifact(
      owner,
      "facts.txt",
      "source",
      "One fact\nSecond fact\n",
    );
    const missing = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const work = join(f.store.runDir(run.id), "work");
    await mkdir(work, { recursive: true });
    const invalid = `[source:${source.id}:L0-L1]\n[source:${missing}:L1]\n[source:${source.id}:L999999999999999999999999999999999999]\n`;
    await writeFile(join(work, "report.md"), invalid);
    owner.tasks = [
      {
        id: "fixture-worker",
        objective: "Report",
        role: "worker",
        dependsOn: [],
        model: "worker",
        write: true,
        state: "succeeded",
        attempts: 1,
        result: {
          outcome: "completed",
          summary: "synthetic report",
          artifacts: ["report.md"],
          unresolved: [],
        },
      },
    ];
    f.store.save(owner, "fixture_output");
    const evaluator = new Evaluator(
      f.config,
      f.store,
      new Sandbox(f.config.execution),
    );
    const failed = await evaluator.validate(
      owner,
      new AbortController().signal,
    );
    assert.equal(failed.filter((check) => !check.passed).length, 3);
    const first = (await app.artifactHistory("report.md"))[0]!.artifact;
    const firstProvenance = await app.artifactProvenance(first.id);
    assert.equal(firstProvenance.status, "available");
    if (firstProvenance.status !== "available")
      throw new Error("Missing failed provenance");
    assert.deepEqual(firstProvenance.unavailableCitedSourceIds, [missing]);
    assert.equal(firstProvenance.citedSourceRanges[0]!.startLine, 0);
    assert.equal(firstProvenance.citedSourceRanges[2]!.startLine, null);
    assert.ok(
      firstProvenance.citedSourceRanges[2]!.rawCitation?.includes(
        "999999999999",
      ),
    );
    assert.equal(
      firstProvenance.validation.checks.filter((check) => !check.passed).length,
      3,
    );
    await writeFile(
      join(work, "report.md"),
      `Corrected report [source:${source.id}:L1-L2]\n`,
    );
    const passed = await evaluator.validate(
      owner,
      new AbortController().signal,
    );
    assert.ok(passed.every((check) => check.passed));
    f.store.release(owner);
    const later = await f.harness.create({
      kind: "chat",
      objective: "Continue",
      conversationId: app.session.id,
      sourceRunIds: [run.id],
      dataClass: "private",
    });
    app.conversations.link(app.session, later);
    const history = await app.artifactHistory("report.md");
    assert.equal(history.length, 2);
    assert.equal(history[1]!.artifact.id, first.id);
    assert.deepEqual(await app.artifactProvenance(first.id), firstProvenance);
    const corrected = await app.artifactProvenance(history[0]!.artifact.id);
    assert.equal(corrected.status, "available");
    if (corrected.status === "available")
      assert.ok(corrected.validation.checks.every((check) => check.passed));
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
