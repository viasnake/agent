import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { Application } from "../src/application.js";
import {
  assertContextReady,
  confirmContextReview,
  previewContextReview,
  recordContextIssue,
} from "../src/context-review.js";
import { AgentError, type Task } from "../src/types.js";
import { runProcess, cleanEnvironment } from "../src/process.js";
import {
  call,
  completed,
  fixture,
  gitWorkspace,
  ScriptedRuntime,
} from "./helpers.js";

const task: Task = {
  id: "work",
  objective: "fixture",
  role: "worker",
  dependsOn: [],
  write: false,
  state: "pending",
  attempts: 0,
};

test("context issues pause a run and require an explicit bound acknowledgement", async () => {
  const f = await fixture({
    contract: {
      version: 1,
      context: "messages-v1",
      tools: true,
      images: false,
    },
    async run() {
      return "unused";
    },
    async close() {},
  });
  try {
    const run = await f.harness.create({
      objective: "fixture",
      kind: "writing",
      mode: "single",
      model: "worker",
      localOnly: true,
    });
    run.tasks = [structuredClone(task)];
    run.state = "waiting_input";
    const leased = f.store.claim(run.id);
    leased.tasks = [structuredClone(task)];
    leased.state = "waiting_input";
    f.store.save(leased);
    const issue = recordContextIssue(
      f.store,
      leased,
      leased.tasks[0]!,
      {
        kind: "contradiction",
        detail: "The retained condition conflicts with new evidence.",
        evidence: "literal fixture evidence",
        sourceIds: [],
        archiveIds: [],
        operationIds: [],
      },
      "host",
    );
    f.store.release(leased);
    assert.throws(() => assertContextReady(leased), {
      code: "CONTEXT_REVIEW_REQUIRED",
    });
    const preview = previewContextReview(f.store, run.id);
    assert.equal(preview.issues[0]!.id, issue.id);
    const acknowledged = confirmContextReview(
      f.store,
      preview,
      "I reviewed the retained condition and will resume explicitly.",
    );
    assert.equal(
      acknowledged.contextIssues?.[0]?.acknowledged?.note.startsWith(
        "I reviewed",
      ),
      true,
    );
    assert.equal(acknowledged.tasks[0]?.contextReviewCount, 1);
    assert.doesNotThrow(() => assertContextReady(acknowledged));
    assert.equal(acknowledged.state, "waiting_input");
  } finally {
    await f.cleanup();
  }
});

test("context review rejects a stale binding and bounded empty notes", async () => {
  const f = await fixture({
    contract: {
      version: 1,
      context: "messages-v1",
      tools: true,
      images: false,
    },
    async run() {
      return "unused";
    },
    async close() {},
  });
  try {
    const run = await f.harness.create({
      objective: "fixture",
      kind: "writing",
      mode: "single",
      model: "worker",
      localOnly: true,
    });
    run.tasks = [structuredClone(task)];
    run.state = "waiting_input";
    const leased = f.store.claim(run.id);
    leased.tasks = [structuredClone(task)];
    leased.state = "waiting_input";
    f.store.save(leased);
    recordContextIssue(
      f.store,
      leased,
      leased.tasks[0]!,
      {
        kind: "missing_condition",
        detail: "condition",
        evidence: "evidence",
        sourceIds: [],
        archiveIds: [],
        operationIds: [],
      },
      "host",
    );
    f.store.release(leased);
    const preview = previewContextReview(f.store, run.id);
    const changed = f.store.claim(run.id);
    changed.objective = "changed";
    f.store.save(changed);
    f.store.release(changed);
    assert.throws(
      () => confirmContextReview(f.store, preview, "acknowledged"),
      { code: "CONTEXT_REVIEW_STALE" },
    );
    assert.throws(() => confirmContextReview(f.store, preview, " "), {
      code: "CONTEXT_REVIEW",
    });
    assert.ok(new AgentError("CONTEXT_REVIEW", "fixture"));
  } finally {
    await f.cleanup();
  }
});

test("four identical exploration reads pause before final success and retain completed operations", async () => {
  let calls = 0;
  const runtime = new ScriptedRuntime(async (request) => {
    for (let index = 0; index < 4; index++)
      await call(request, "read_file", { path: "facts.txt" });
    calls++;
    return completed([], "final answer");
  });
  const f = await fixture(runtime);
  try {
    const workspace = await gitWorkspace(f.root, {
      "facts.txt": "retained fact\n",
    });
    const run = await f.harness.create({
      objective: "Inspect the facts",
      kind: "coding",
      mode: "single",
      model: "worker",
      workspace,
      access: "read-only",
      localOnly: true,
    });
    const result = await f.harness.execute(run.id);
    assert.equal(result.state, "waiting_input");
    assert.equal(calls, 1);
    assert.equal(result.contextIssues?.[0]?.kind, "repeated_exploration");
    assert.ok(
      f.store
        .operations(result.id)
        .filter((operation) => operation.name === "read_file")
        .every((operation) => operation.status === "completed"),
    );
    assert.equal(
      f.store
        .operations(result.id)
        .some((operation) => operation.name === "write_file"),
      false,
    );
  } finally {
    await f.cleanup();
  }
});

test("a report from the selected model pauses the actual execution path", async () => {
  const runtime = new ScriptedRuntime(async (request) => {
    await call(request, "report_context_issue", {
      kind: "contradiction",
      detail: "The retained condition is contradicted.",
      evidence: "literal contradictory evidence",
    });
    return completed([], "should not be accepted");
  });
  const f = await fixture(runtime);
  try {
    const workspace = await gitWorkspace(f.root, { "facts.txt": "fact\n" });
    const run = await f.harness.create({
      objective: "Review the repository",
      kind: "coding",
      mode: "single",
      model: "worker",
      workspace,
      access: "read-only",
      localOnly: true,
    });
    const result = await f.harness.execute(run.id);
    assert.equal(result.state, "waiting_input");
    assert.equal(result.contextIssues?.[0]?.origin, "model");
    assert.equal(f.store.usage(result.id).requests, 1);
  } finally {
    await f.cleanup();
  }
});

test("application context review preserves the queue and does not create a runtime on confirmation", async () => {
  const runtime = new ScriptedRuntime(async () => completed([], "resumed"));
  const f = await fixture(runtime);
  f.config.limits.maxRepairs = 0;
  let runtimeCreations = 0;
  const runtimeFactory = async () => {
    runtimeCreations++;
    return runtime;
  };
  const app = new Application(f.config, f.p, f.store, f.root, runtimeFactory);
  let reopened: Application | undefined;
  try {
    await app.initialize();
    const run = await f.harness.create({
      objective: "Review the repository",
      kind: "chat",
      mode: "single",
      model: "worker",
      localOnly: true,
      conversationId: app.session.id,
    });
    const leased = f.store.claim(run.id);
    leased.conversationId = app.session.id;
    leased.state = "waiting_input";
    leased.tasks = [
      {
        ...structuredClone(task),
        attempts: 1,
        model: "worker",
      },
    ];
    recordContextIssue(
      f.store,
      leased,
      leased.tasks[0]!,
      {
        kind: "missing_condition",
        detail: "condition",
        evidence: "evidence",
        sourceIds: [],
        archiveIds: [],
        operationIds: [],
      },
      "host",
    );
    f.store.release(leased);
    app.conversations.link(app.session, run);
    app.session.latestRunId = run.id;
    app.save();
    app.session.queue.push({
      id: "queued",
      text: "continue later",
      mode: "next",
    });
    app.save();
    const sessionId = app.session.id;
    await app.close();
    reopened = new Application(f.config, f.p, f.store, f.root, runtimeFactory);
    await reopened.initialize();
    reopened.openSession(sessionId);
    const preview = reopened.previewContextReview(run.id);
    const edited = structuredClone(preview);
    edited.issues[0]!.detail = "edited display payload";
    assert.throws(
      () =>
        reopened!.confirmContextReview(
          edited,
          "Reviewed the retained condition explicitly.",
        ),
      { code: "CONTEXT_REVIEW_STALE" },
    );
    reopened.addPin("Keep the confirmed review scope.");
    assert.throws(
      () =>
        reopened!.confirmContextReview(
          preview,
          "Reviewed the retained condition explicitly.",
        ),
      { code: "CONTEXT_REVIEW_STALE" },
    );
    reopened.startQueue();
    assert.equal(reopened.busy, false);
    assert.equal(reopened.session.queue.length, 1);
    const freshPreview = reopened.previewContextReview(run.id);
    await assert.rejects(reopened.resume(), {
      code: "CONTEXT_REVIEW_REQUIRED",
    });
    assert.equal(runtimeCreations, 0);
    const confirmed = reopened.confirmContextReview(
      freshPreview,
      "Reviewed the retained condition explicitly.",
    );
    assert.equal(confirmed.state, "waiting_input");
    assert.equal(confirmed.tasks[0]?.contextReviewCount, 1);
    assert.equal(reopened.session.queue.length, 1);
    assert.equal(runtime.requests.length, 0);
    await reopened.resume();
    assert.equal(
      reopened.currentRun()?.state,
      "succeeded",
      reopened.currentRun()?.reason,
    );
    assert.equal(runtimeCreations, 1);
  } finally {
    if (reopened) await reopened.close();
    else await app.close();
    await f.cleanup();
  }
});

test("changed exploration results reset the repeated-read window", async () => {
  let factsPath = "";
  const runtime = new ScriptedRuntime(async (request) => {
    await call(request, "read_file", { path: "facts.txt" });
    await call(request, "read_file", { path: "facts.txt" });
    await writeFile(factsPath, "changed fact\n");
    await call(request, "read_file", { path: "facts.txt" });
    await call(request, "read_file", { path: "facts.txt" });
    await call(request, "read_file", { path: "facts.txt" });
    return completed([], "finished after progress");
  });
  const f = await fixture(runtime);
  try {
    const workspace = await gitWorkspace(f.root, {
      "facts.txt": "original fact\n",
    });
    const run = await f.harness.create({
      objective: "Inspect changing facts",
      kind: "coding",
      mode: "single",
      model: "worker",
      workspace,
      access: "read-only",
      localOnly: true,
    });
    factsPath = join(f.store.runDir(run.id), "work", "facts.txt");
    const result = await f.harness.execute(run.id);
    assert.equal(result.state, "succeeded", result.reason);
    assert.equal(result.contextIssues?.length ?? 0, 0);
  } finally {
    await f.cleanup();
  }
});

test("context-review CLI previews, rejects stale bindings, and confirms explicitly", async () => {
  const f = await fixture({
    contract: {
      version: 1,
      context: "messages-v1",
      tools: true,
      images: false,
    },
    async run() {
      return "unused";
    },
    async close() {},
  });
  const command = (...args: string[]) =>
    runProcess(
      process.execPath,
      [
        fileURLToPath(new URL("../src/cli.js", import.meta.url)),
        "--home",
        f.p.home,
        "--json",
        ...args,
      ],
      { env: cleanEnvironment, timeoutMs: 30_000, maxBytes: 100_000 },
    );
  try {
    await writeFile(f.p.config, stringify(f.config), { mode: 0o600 });
    const run = await f.harness.create({
      objective: "CLI review fixture",
      kind: "writing",
      mode: "single",
      model: "worker",
      localOnly: true,
    });
    const leased = f.store.claim(run.id);
    leased.state = "waiting_input";
    leased.tasks = [structuredClone(task)];
    recordContextIssue(
      f.store,
      leased,
      leased.tasks[0]!,
      {
        kind: "missing_condition",
        detail: "retained condition",
        evidence: "literal evidence",
        sourceIds: [],
        archiveIds: [],
        operationIds: [],
      },
      "host",
    );
    f.store.release(leased);
    const previewResult = await command("context-review", run.id);
    assert.equal(previewResult.code, 0, previewResult.stderr);
    const preview = JSON.parse(previewResult.stdout);
    assert.equal(preview.issues.length, 1);
    const changed = f.store.claim(run.id);
    changed.objective = "changed after preview";
    f.store.save(changed);
    f.store.release(changed);
    const staleResult = await command(
      "context-review",
      run.id,
      "--confirm",
      preview.binding,
      "--note",
      "I reviewed this",
    );
    assert.equal(staleResult.code, 1);
    assert.match(staleResult.stderr, /Preview binding is stale/);
    const freshResult = await command("context-review", run.id);
    const fresh = JSON.parse(freshResult.stdout);
    const confirmResult = await command(
      "context-review",
      run.id,
      "--confirm",
      fresh.binding,
      "--note",
      "Reviewed the retained condition explicitly.",
    );
    assert.equal(confirmResult.code, 0, confirmResult.stderr);
    const confirmed = JSON.parse(confirmResult.stdout);
    assert.equal(confirmed.state, "waiting_input");
    assert.equal(
      confirmed.contextIssues[0].acknowledged.note,
      "Reviewed the retained condition explicitly.",
    );
    assert.equal(f.store.usage(run.id).requests, 0);
  } finally {
    await f.cleanup();
  }
});
