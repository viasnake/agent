import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  Application,
  inferAccess,
  inferKind,
  fileReferences,
  type AppEvent,
} from "../src/application.js";
import { Conversations } from "../src/conversations.js";
import { Sandbox } from "../src/sandbox.js";
import { Store } from "../src/storage.js";
import {
  call,
  completed,
  fixture,
  gitWorkspace,
  ScriptedRuntime,
  testConfig,
} from "./helpers.js";
import { safeText, markdown } from "../src/tui/components.js";
import { visibleWidth } from "@earendil-works/pi-tui";
import { PiRuntime } from "../src/runtime/pi.js";
import type { Runtime } from "../src/types.js";
import { readSnapshot } from "../src/workspace.js";

const until = async (condition: () => boolean) => {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for state");
    await new Promise((r) => setTimeout(r, 10));
  }
};

test("simple conversation uses one model without planning, shell or document requirements", async () => {
  const runtime = new ScriptedRuntime(async (request) => {
    assert.equal(request.tools.length, 0);
    return "こんにちは。";
  });
  const f = await fixture(runtime),
    app = new Application(f.config, f.p, f.store, f.root, async () => runtime);
  try {
    await app.initialize();
    await app.submit("こんにちは");
    await app.waitForIdle();
    assert.equal(app.currentRun()?.state, "succeeded");
    assert.equal(runtime.requests.length, 1);
    assert.equal(app.currentRun()?.kind, "chat");
    assert.equal(f.store.usage(app.currentRun()!.id).requests, 1);
    assert.equal(
      app.conversations.messages(app.session.id).at(-1)?.text,
      "こんにちは。",
    );
  } finally {
    await app.close();
    await f.cleanup();
  }
});

test("repository exploration stays read-only across planning and coding-copy transitions", async (t) => {
  const runtime = new ScriptedRuntime(async (request, index) => {
    if (request.tools.some((tool) => tool.name === "write_file")) {
      await call(request, "write_file", {
        path: "draft.md",
        content: "pending coding copy",
        expectedSha256: null,
      });
      return completed(["draft.md"]);
    }
    assert.ok(request.tools.some((tool) => tool.name === "read_file"));
    assert.ok(!request.tools.some((tool) => tool.name === "write_file"));
    await assert.rejects(
      call(request, "write_file", {
        path: "forbidden.md",
        content: "must not be written",
        expectedSha256: null,
      }),
      /Tool unavailable/,
    );
    if (index === 0 || index === 1)
      assert.match(
        await call(request, "read_file", { path: "README.md" }),
        /original workspace/,
      );
    if (index === 3)
      assert.match(
        await call(request, "read_file", { path: "draft.md" }),
        /pending coding copy/,
      );
    return "read-only findings";
  });
  const f = await fixture(runtime);
  let probes = 0,
    checks = 0;
  t.mock.method(Sandbox.prototype, "probe", async () => {
    probes++;
    return { ok: true, detail: "unit fixture" };
  });
  t.mock.method(Sandbox.prototype, "execute", async () => {
    checks++;
    return { code: 0, stdout: "", stderr: "", truncated: false };
  });
  f.config.checks = {
    test: { command: "true", protectedPaths: [] },
  };
  const origin = await gitWorkspace(f.root, {
    "README.md": "original workspace\n",
  });
  const app = new Application(
    f.config,
    f.p,
    f.store,
    origin,
    async () => runtime,
  );
  try {
    await app.initialize();
    app.addPin("Keep the public API stable.");
    app.addConstraint("Never modify the original workspace.");
    await app.submit("Explain this repository");
    await app.waitForIdle();
    assert.equal(app.currentRun()?.access, "read-only");

    await app.submit("Review the plan; まだ変更しない");
    await app.waitForIdle();
    assert.equal(app.currentRun()?.kind, "chat");
    assert.equal(app.currentRun()?.access, "read-only");

    await app.submit("実装して add feature");
    await app.waitForIdle();
    const codingRun = app.currentRun()!;
    assert.equal(codingRun.kind, "coding");
    assert.equal(codingRun.access, "change");
    assert.equal(
      await readFile(join(origin, "draft.md")).then(
        () => true,
        () => false,
      ),
      false,
    );

    const probesBeforeReview = probes,
      checksBeforeReview = checks;
    await app.submit("Explain this bug");
    await app.waitForIdle();
    const explanationRun = app.currentRun()!;
    assert.equal(explanationRun.kind, "coding");
    assert.equal(explanationRun.access, "read-only");
    assert.equal(explanationRun.state, "succeeded", explanationRun.reason);
    assert.match(
      runtime.requests[3]!.system,
      /Answer the user in their language/,
    );
    assert.doesNotMatch(runtime.requests[3]!.system, /result JSON/i);
    assert.equal(app.session.workRunId, codingRun.id);
    assert.equal(probes, probesBeforeReview);
    assert.equal(checks, checksBeforeReview);
    assert.equal(
      await readFile(
        join(f.store.runDir(codingRun.id), "work", "draft.md"),
        "utf8",
      ),
      "pending coding copy",
    );

    await app.submit("まだ変更しないで説明して");
    await app.waitForIdle();
    assert.equal(app.currentRun()?.kind, "chat");
    assert.equal(app.currentRun()?.access, "read-only");
    assert.equal(app.session.workRunId, codingRun.id);
    assert.deepEqual(
      runtime.requests.map((request) => request.tools.length > 0),
      [true, true, true, true, true],
    );
    for (const request of runtime.requests) {
      assert.deepEqual(request.constraints, [
        "Never modify the original workspace.",
      ]);
      assert.match(request.objective, /Keep the public API stable/);
    }
  } finally {
    await app.close();
    await f.cleanup();
  }
});

test("explicit no-change prohibitions take precedence over change verbs", () => {
  assert.equal(inferKind("まだ変更しないが、修正案を説明して"), "chat");
  assert.equal(inferAccess("Explain how to fix this bug"), "read-only");
  assert.equal(inferAccess("Review this change"), "read-only");
  assert.equal(
    inferAccess("do not modify files; explain how to implement it"),
    "read-only",
  );
  assert.equal(
    inferAccess("コードを変更しないで修正案を説明して"),
    "read-only",
  );
  assert.equal(inferAccess("fix this bug"), "change");
  assert.equal(inferAccess("実装して"), "change");
  assert.equal(inferAccess("ambiguous follow-up"), "read-only");
});

test("access overrides are one-turn and cannot override explicit prohibitions", async (t) => {
  const runtime = new ScriptedRuntime(async (request) => {
    if (request.access === "change") {
      await call(request, "write_file", {
        path: "change.txt",
        content: "changed",
        expectedSha256: null,
      });
      return completed();
    }
    assert.ok(!request.tools.some((tool) => tool.name === "write_file"));
    return "read-only answer";
  });
  const f = await fixture(runtime),
    origin = await gitWorkspace(f.root, { "README.md": "baseline\n" }),
    app = new Application(f.config, f.p, f.store, origin, async () => runtime);
  t.mock.method(Sandbox.prototype, "probe", async () => ({
    ok: true,
    detail: "unit fixture",
  }));
  t.mock.method(Sandbox.prototype, "execute", async () => ({
    code: 0,
    stdout: "",
    stderr: "",
    truncated: false,
  }));
  f.config.checks = { test: { command: "true", protectedPaths: [] } };
  try {
    await app.initialize();
    app.session.kind = "coding";
    app.session.checks = ["test"];
    app.setAccessOverride("change");
    const preview = await app.previewInput("ambiguous follow-up");
    assert.equal(preview.access, "change");
    assert.equal(preview.accessOverride, "change");
    await app.submit("ambiguous follow-up", "instruction", preview);
    await app.waitForIdle();
    assert.equal(app.currentRun()?.access, "change");
    assert.equal(
      app.currentRun()?.state,
      "succeeded",
      app.currentRun()?.reason,
    );
    assert.equal(app.session.access, "read-only");
    const nextPreview = await app.previewInput("ambiguous follow-up");
    assert.equal(nextPreview.accessOverride, undefined);
    assert.equal(nextPreview.access, "read-only");

    app.setAccessOverride("change");
    const stalePreview = await app.previewInput("ambiguous follow-up");
    app.setAccessOverride("read-only");
    await assert.rejects(
      () => app.submit("ambiguous follow-up", "instruction", stalePreview),
      { code: "IMAGE_PREVIEW_STALE" },
    );
    assert.equal(app.session.queue.length, 0);

    app.session.kind = "chat";
    app.setAccessOverride("change");
    const prohibited = await app.previewInput(
      "do not modify files; explain how to implement it",
    );
    assert.equal(prohibited.accessOverride, "change");
    assert.equal(prohibited.access, "read-only");
    await app.submit(
      "do not modify files; explain how to implement it",
      "instruction",
      prohibited,
    );
    await app.waitForIdle();
    assert.equal(app.currentRun()?.access, "read-only");
    assert.equal(app.currentRun()?.state, "succeeded");
    assert.equal(runtime.requests.at(-1)?.access, "read-only");
    assert.equal(app.session.access, "read-only");
  } finally {
    await app.close();
    await f.cleanup();
  }
});

test("user context notes and constraints survive a conversation restart without changing privacy policy", async () => {
  const runtime = new ScriptedRuntime(async () => "unused");
  const f = await fixture(runtime);
  const app = new Application(
    f.config,
    f.p,
    f.store,
    f.root,
    async () => runtime,
  );
  let reopened: Application | undefined;
  try {
    await app.initialize();
    const sessionId = app.session.id;
    const policy = {
      dataClass: app.session.dataClass,
      localOnly: app.session.localOnly,
    };
    app.addPin("Keep the original API stable.");
    app.addContextNote("decision", "Use the local database.");
    app.addContextNote("question", "Which platforms need support?");
    app.addConstraint("Do not change the public endpoint.");
    await app.close();

    reopened = new Application(
      f.config,
      f.p,
      f.store,
      f.root,
      async () => runtime,
    );
    await reopened.initialize();
    reopened.openSession(sessionId);
    assert.equal(reopened.pins()[0]?.text, "Keep the original API stable.");
    const context = reopened.session.context!;
    assert.equal(context.pins[0]?.author, "user");
    assert.equal(context.pins[0]?.trusted, true);
    assert.equal(context.decisions[0]?.text, "Use the local database.");
    assert.equal(
      context.openQuestions[0]?.text,
      "Which platforms need support?",
    );
    assert.deepEqual(context.constraints, [
      "Do not change the public endpoint.",
    ]);
    assert.deepEqual(
      {
        dataClass: reopened.session.dataClass,
        localOnly: reopened.session.localOnly,
      },
      policy,
    );
  } finally {
    if (reopened) await reopened.close();
    else await app.close();
    await f.cleanup();
  }
});

test("status keeps context estimates separate from unknown provider usage", async () => {
  const runtime: Runtime = {
    async run(request) {
      request.signal.throwIfAborted();
      const reservation = request.beforeRequest(
        Buffer.byteLength(request.objective),
      );
      request.afterRequest(reservation, {
        input: null,
        output: null,
        costUsd: null,
      });
      return "answer";
    },
    async close() {},
  };
  const f = await fixture(runtime);
  const app = new Application(
    f.config,
    f.p,
    f.store,
    f.root,
    async () => runtime,
  );
  try {
    await app.initialize();
    await app.submit("Give a short answer");
    await app.waitForIdle();
    const view = app.view();
    assert.ok(view.context);
    assert.ok(view.context.bytes > 0);
    assert.equal(view.usage?.input, null);
    assert.equal(view.usage?.output, null);
    assert.equal(view.usage?.usageComplete, false);
    const connectionUsage = f.store.usageByConnection(app.currentRun()!.id)[0]!;
    assert.equal(connectionUsage.inputTokens, null);
    assert.equal(connectionUsage.outputTokens, null);
    assert.equal(connectionUsage.usageComplete, false);
    const report = app.session.context?.workingState.history.at(-1)?.results[0];
    assert.equal(report?.author, "model");
    assert.equal(report?.trusted, false);
  } finally {
    await app.close();
    await f.cleanup();
  }
});

test("additional instructions invalidate earlier task results at a boundary; next input runs afterwards", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const runtime = new ScriptedRuntime(async (request, index) => {
    if (index === 0) await gate;
    return `回答 ${index}: ${request.objective}`;
  });
  const f = await fixture(runtime),
    app = new Application(f.config, f.p, f.store, f.root, async () => runtime);
  const events: AppEvent[] = [];
  app.on("event", (e: AppEvent) => events.push(e));
  try {
    await app.initialize();
    await app.submit("最初の質問");
    await until(() => runtime.requests.length === 1);
    await app.submit("短く答えて");
    await app.submit("後の質問", "next");
    assert.deepEqual(
      app.session.queue.map((q) => q.mode),
      ["instruction", "next"],
    );
    release();
    await until(() => runtime.requests.length === 3 && !app.busy);
    const runs = f.store.list();
    assert.equal(runs.length, 2);
    const first = runs.find((r) => r.id !== app.currentRun()!.id)!;
    assert.match(first.objective, /短く答えて/);
    assert.equal(first.tasks[0]!.attempts, 2);
    assert.equal(first.state, "succeeded");
    assert.equal(app.session.queue.length, 0);
    assert.ok(events.some((e) => e.type === "instructions_accepted"));
  } finally {
    release();
    await app.close();
    await f.cleanup();
  }
});

test("stop persists queued work and reopening does not replay provider requests", async () => {
  const runtime = new ScriptedRuntime(
    (request) =>
      new Promise((_, reject) => {
        request.signal.addEventListener(
          "abort",
          () => reject(request.signal.reason),
          { once: true },
        );
      }),
  );
  const f = await fixture(runtime),
    app = new Application(f.config, f.p, f.store, f.root, async () => runtime);
  let reopened: Application | undefined;
  try {
    await app.initialize();
    const sessionId = app.session.id;
    await app.submit("質問");
    await until(() => runtime.requests.length === 1);
    await app.submit("待機した質問", "next");
    app.stop();
    await app.waitForIdle();
    assert.equal(app.currentRun()?.state, "cancelled");
    assert.equal(app.session.queue.length, 1);
    await app.close();
    reopened = new Application(
      f.config,
      f.p,
      f.store,
      f.root,
      async () => runtime,
    );
    await reopened.initialize();
    reopened.openSession(sessionId);
    assert.equal(reopened.session.queue.length, 1);
    assert.equal(runtime.requests.length, 1);
    assert.equal(reopened.busy, false);
  } finally {
    if (reopened) await reopened.close();
    await f.cleanup();
  }
});

test("a preparation failure keeps its queued input and does not retry in a loop", async () => {
  const runtime = new ScriptedRuntime(async () => completed());
  const f = await fixture(runtime);
  const app = new Application(
    f.config,
    f.p,
    f.store,
    f.root,
    async () => runtime,
  );
  try {
    await app.initialize();
    await app.submit("Fix the code");
    await app.waitForIdle();
    assert.equal(app.session.queue.length, 1);
    assert.equal(runtime.requests.length, 0);
    assert.equal(app.busy, false);
  } finally {
    await app.close();
    await f.cleanup();
  }
});

test("conversation lease prevents concurrent editing and releases without losing drafts", async () => {
  const f = await fixture(new ScriptedRuntime(async () => "ok"));
  const first = new Conversations(f.store),
    second = new Conversations(f.store);
  try {
    const session = first.create(f.root, { dataClass: "private", checks: [] });
    session.draft = "未送信の日本語";
    first.save(session);
    assert.throws(() => second.acquire(session.id), /another process/);
    first.release(session.id);
    assert.equal(second.acquire(session.id).draft, "未送信の日本語");
  } finally {
    await f.cleanup();
  }
});

test("coding continuation keeps cumulative changes, checks each turn, applies, and retains newly created files", async (t) => {
  let checks = 0;
  const checkEvents: AppEvent[] = [];
  t.mock.method(Sandbox.prototype, "probe", async () => ({
    ok: true,
    detail: "unit fixture",
  }));
  t.mock.method(Sandbox.prototype, "execute", async () => {
    assert.equal(checkEvents.at(-1)?.type, "check_started");
    checks++;
    return { code: 0, stdout: "checked", stderr: "", truncated: false };
  });
  const config = testConfig();
  config.checks = { unit: { command: "test -s app.txt", protectedPaths: [] } };
  const runtime = new ScriptedRuntime(async (request, index) => {
    if (index === 0) {
      await call(request, "edit_file", {
        path: "app.txt",
        oldText: "baseline",
        newText: "first",
      });
      await call(request, "write_file", {
        path: "new.txt",
        content: "created",
        expectedSha256: null,
      });
    } else if (index === 1) {
      const result = await call(request, "read_file", { path: "app.txt" });
      assert.match(result, /first/);
      await call(request, "edit_file", {
        path: "app.txt",
        oldText: "first",
        newText: "second",
      });
    } else {
      assert.match(
        await call(request, "read_file", { path: "new.txt" }),
        /created/,
      );
      await call(request, "edit_file", {
        path: "new.txt",
        oldText: "created",
        newText: "continued",
      });
    }
    return completed([], `change ${index}`);
  });
  const f = await fixture(runtime, config),
    origin = await gitWorkspace(f.root, { "app.txt": "baseline" });
  const app = new Application(
    config,
    f.p,
    f.store,
    origin,
    async () => runtime,
  );
  app.on("event", (event: AppEvent) => {
    if (event.type === "validation_started" || event.type.startsWith("check_"))
      checkEvents.push(event);
  });
  try {
    await app.initialize();
    await app.submit("fix app");
    await app.waitForIdle();
    assert.equal(app.currentRun()?.state, "succeeded");
    const firstRun = app.currentRun()!.id;
    await app.submit("also fix app");
    await app.waitForIdle();
    assert.equal(app.currentRun()?.parentRunId, firstRun);
    assert.equal(app.currentRun()?.state, "succeeded");
    const diff = await app.diff();
    assert.match(diff.patch, /-baseline/);
    assert.match(diff.patch, /\+second/);
    assert.match(diff.patch, /\+created/);
    assert.equal(diff.applicable, true);
    assert.equal(checks, 2);
    assert.deepEqual(
      checkEvents.map((event) => event.type),
      [
        "validation_started",
        "check_started",
        "check_finished",
        "validation_started",
        "check_started",
        "check_finished",
      ],
    );
    assert.equal(checkEvents.at(-1)?.detail.passed, true);
    assert.equal(checkEvents.at(-1)?.detail.command, "test -s app.txt");
    assert.equal(await readFile(join(origin, "app.txt"), "utf8"), "baseline");
    await app.apply(diff.token);
    assert.equal(await readFile(join(origin, "app.txt"), "utf8"), "second");
    assert.equal(app.session.workRunId, undefined);
    await app.submit("fix new file");
    await app.waitForIdle();
    assert.equal(
      app.currentRun()?.state,
      "succeeded",
      app.currentRun()?.reason,
    );
    const next = await app.diff();
    assert.match(next.patch, /-created/);
    assert.doesNotMatch(next.patch, /-baseline/);
    await app.apply(next.token);
    assert.equal(await readFile(join(origin, "new.txt"), "utf8"), "continued");
    await assert.rejects(() => app.apply(diff.token), /未適用/);
    const validation = await app.lastValidation();
    assert.equal(
      validation?.find((check) => check.id === "unit")?.passed,
      true,
    );
    const sessionId = app.session.id;
    await app.newSession();
    assert.equal(await app.lastValidation(), undefined);
    app.openSession(sessionId);
    assert.deepEqual(await app.lastValidation(), validation);
  } finally {
    await app.close();
    await f.cleanup();
  }
});

test("continuation detects origin conflicts without overwriting user changes", async () => {
  const runtime = new ScriptedRuntime(async () => completed()),
    f = await fixture(runtime);
  try {
    const origin = await gitWorkspace(f.root, { "app.txt": "baseline" });
    const run = await f.harness.create({
      kind: "coding",
      objective: "first",
      workspace: origin,
    });
    await writeFile(
      join(f.store.runDir(run.id), "work", "app.txt"),
      "private change",
    );
    await writeFile(join(origin, "app.txt"), "user change");
    await assert.rejects(
      () =>
        f.harness.create({
          kind: "coding",
          objective: "continue",
          workspace: origin,
          parentRunId: run.id,
        }),
      /Source workspace changed/,
    );
    assert.equal(
      await readFile(join(origin, "app.txt"), "utf8"),
      "user change",
    );
  } finally {
    await f.cleanup();
  }
});

test("referenced inputs are bounded and secret and traversal paths are rejected before a run", async () => {
  const runtime = new ScriptedRuntime(async () => "ok"),
    f = await fixture(runtime),
    app = new Application(f.config, f.p, f.store, f.root, async () => runtime);
  try {
    await app.initialize();
    await writeFile(join(f.root, "note.md"), "資料");
    assert.deepEqual(await app.attachments('Explain @"note.md"'), [
      { path: "note.md", bytes: 6 },
    ]);
    await assert.rejects(
      () => app.submit("read @../outside"),
      /Invalid workspace path/,
    );
    await assert.rejects(() => app.submit("read @.env"), /添付できません/);
    assert.equal(f.store.list().length, 0);
  } finally {
    await app.close();
    await f.cleanup();
  }
});

test("source artifacts remain readable across linked conversation kinds", async () => {
  let sourceId: string | undefined;
  const runtime = new ScriptedRuntime(async (request) => {
    if (request.objective.includes("read the cited source")) {
      const readSource = request.tools.find(
        (tool) => tool.name === "read_source",
      );
      assert.ok(readSource);
      assert.match(
        await readSource.execute(
          { id: sourceId!, startLine: 1, lines: 10 },
          request.signal,
        ),
        /note\.md/,
      );
      return "The linked source contains the requested note.";
    }
    return "Source received.";
  });
  const f = await fixture(runtime),
    app = new Application(f.config, f.p, f.store, f.root, async () => runtime);
  try {
    await writeFile(join(f.root, "note.md"), "cross-kind source\n");
    await app.initialize();
    app.session.kind = "research";
    await app.submit('Research @"note.md"');
    await app.waitForIdle();
    const source = f.store
      .artifacts(app.currentRun()!.id)
      .find((artifact) => artifact.kind === "source");
    assert.ok(source);
    sourceId = source.id;

    app.session.kind = "chat";
    await app.submit("read the cited source");
    await app.waitForIdle();
    assert.equal(app.currentRun()?.state, "succeeded");
    assert.ok(
      runtime.requests
        .at(-1)
        ?.tools.some((tool) => tool.name === "read_source"),
    );
  } finally {
    await app.close();
    await f.cleanup();
  }
});

test("compaction creates a deterministic handoff without extra inference or deleting history", async () => {
  const runtime = new ScriptedRuntime(async () => "回答"),
    f = await fixture(runtime);
  f.config.models.worker!.contextWindow = 8192;
  f.config.models.worker!.maxOutputTokens = 512;
  f.config.models.reviewer!.contextWindow = 512;
  f.config.models.reviewer!.maxOutputTokens = 128;
  f.config.models = {
    reviewer: f.config.models.reviewer!,
    worker: f.config.models.worker!,
  };
  const app = new Application(
    f.config,
    f.p,
    f.store,
    f.root,
    async () => runtime,
  );
  try {
    await app.initialize();
    await app.submit("質問".repeat(1200));
    await app.waitForIdle();
    const runId = app.currentRun()!.id;
    await app.compact();
    assert.equal(runtime.requests.length, 1);
    assert.equal(app.session.compacted, true);
    const handoff = app.session.handoff;
    const archiveDirectory = join(
      f.p.home,
      "conversations",
      app.session.id,
      "archives",
    );
    const archives = await readdir(archiveDirectory);
    await app.compact();
    assert.equal(app.session.handoff, handoff);
    assert.deepEqual(await readdir(archiveDirectory), archives);
    assert.equal(
      JSON.parse(
        await readFile(join(f.store.runDir(runId), "handoff.json"), "utf8"),
      ).state,
      "succeeded",
    );
    await writeFile(
      join(f.store.runDir(runId), "handoff.json"),
      JSON.stringify({ state: "succeeded", objective: "legacy handoff" }),
      { mode: 0o600 },
    );
    app.session.handoff = undefined;
    app.session.contextRunId = undefined;
    app.save();
    await app.submit("続けて質問");
    await app.waitForIdle();
    assert.ok(app.currentRun()?.context);
    assert.match(runtime.requests[1]!.objective, /legacy handoff/);
    assert.equal(app.conversations.messages(app.session.id).length, 4);
  } finally {
    await app.close();
    await f.cleanup();
  }
});

test("version-one database migration preserves runs and writes a consistent backup", async () => {
  const f = await fixture(new ScriptedRuntime(async () => completed()));
  const run = await f.harness.create({
    kind: "writing",
    objective: "preserved",
  });
  f.store.db.exec("PRAGMA user_version=1");
  f.store.close();
  const migrated = new Store(f.p);
  try {
    assert.equal(migrated.get(run.id).objective, "preserved");
    assert.equal(
      (
        migrated.db.prepare("PRAGMA user_version").get() as {
          user_version: number;
        }
      ).user_version,
      2,
    );
    assert.ok(
      (await readdir(f.p.home)).some(
        (n) => n.startsWith("state.sqlite.v1-") && n.endsWith(".bak"),
      ),
    );
  } finally {
    migrated.close();
    await import("node:fs/promises").then((fs) =>
      fs.rm(f.root, { recursive: true, force: true }),
    );
  }
});

test("real Pi sessions continue conversational context and forks preserve prior run history", async (t) => {
  const f = await fixture(new ScriptedRuntime(async () => "unused"));
  const payloads: Record<string, unknown>[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (_input: unknown, init?: RequestInit) => {
      payloads.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const chunk = {
        id: "fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: "worker-fixture",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "覚えています: 青い鳥" },
            finish_reason: "stop",
          },
        ],
      };
      return new Response(
        `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  );
  const app = new Application(
    f.config,
    f.p,
    f.store,
    f.root,
    async () => new PiRuntime(f.config, f.p),
  );
  try {
    await app.initialize();
    await app.submit("青い鳥を覚えて");
    await app.waitForIdle();
    assert.equal(
      app.currentRun()?.state,
      "succeeded",
      app.currentRun()?.reason,
    );
    const old = app.currentRun()!.tasks[0]!.sessionFile!,
      original = await readFile(old, "utf8");
    await app.submit("何を覚えている？");
    await app.waitForIdle();
    assert.equal(
      app.currentRun()?.state,
      "succeeded",
      app.currentRun()?.reason,
    );
    assert.equal(payloads.length, 2);
    assert.notEqual(app.currentRun()!.tasks[0]!.sessionFile, old);
    assert.equal(await readFile(old, "utf8"), original);
    assert.match(JSON.stringify(payloads[1]!.messages), /青い鳥を覚えて/);
  } finally {
    await app.close();
    await f.cleanup();
  }
});

test("Japanese text wraps with Pi width rules and external terminal controls cannot pass through", () => {
  const hostile =
    "日本語\x1b]52;c;ZXhmaWw=\x07結合e\u0301\x1b[2J\u009b31m\u202etext";
  const clean = safeText(hostile);
  assert.doesNotMatch(clean, /[\x1b\x07\u009b\u202e]/);
  assert.match(clean, /日本語/);
  for (const line of markdown(clean.repeat(20)).render(40))
    assert.ok(visibleWidth(line) <= 40);
  assert.equal(inferKind("こんにちは"), "chat");
  assert.equal(inferKind("不具合を修正して"), "coding");
  assert.deepEqual(fileReferences('説明 @"a b.md" @file.ts'), [
    "a b.md",
    "file.ts",
  ]);
});

test("research sources and documents survive a writing follow-up with stable citations", async () => {
  const runtime = new ScriptedRuntime(async (request, index) => {
    if (index === 0) {
      const objective = JSON.parse(request.objective) as { evidence: string };
      const evidence = JSON.parse(objective.evidence) as {
        sources: { id: string }[];
      };
      const source = evidence.sources[0]!.id;
      assert.match(await call(request, "read_source", { id: source }), /原文/);
      await call(request, "write_file", {
        path: "report.md",
        content: `調査結果 [source:${source}:L1]`,
        expectedSha256: null,
      });
    } else {
      assert.match(
        await call(request, "read_file", { path: "report.md" }),
        /調査結果/,
      );
      await call(request, "edit_file", {
        path: "report.md",
        oldText: "調査結果",
        newText: "読みやすい調査結果",
      });
    }
    return completed(["report.md"]);
  });
  const f = await fixture(runtime),
    app = new Application(f.config, f.p, f.store, f.root, async () => runtime);
  try {
    await writeFile(join(f.root, "note.md"), "原文");
    await app.initialize();
    const input = "調査してください @note.md",
      preview = await app.previewInput(input);
    await unlink(join(f.root, "note.md"));
    await app.submit(input, "next", preview);
    await app.waitForIdle();
    assert.equal(
      app.currentRun()?.state,
      "succeeded",
      app.currentRun()?.reason,
    );
    const source = f.store
      .artifacts(app.currentRun()!.id)
      .find((a) => a.kind === "source")!;
    await app.submit("文章を整文してください");
    await app.waitForIdle();
    assert.equal(
      app.currentRun()?.state,
      "succeeded",
      app.currentRun()?.reason,
    );
    assert.ok(
      f.store.artifacts(app.currentRun()!.id).some((a) => a.id === source.id),
    );
    assert.equal((await f.store.content(source)).toString(), "原文");
  } finally {
    await app.close();
    await f.cleanup();
  }
});

test("attachment count and raw-byte budgets reject before creating prepared blobs", async () => {
  const runtime = new ScriptedRuntime(async () => "unused"),
    f = await fixture(runtime),
    app = new Application(f.config, f.p, f.store, f.root, async () => runtime);
  try {
    await app.initialize();
    const names = Array.from({ length: 9 }, (_, index) => `small-${index}.txt`);
    for (const name of names) await writeFile(join(f.root, name), "text");
    await assert.rejects(
      app.previewInput(names.map((name) => `@${name}`).join(" ")),
      { code: "INPUT_SIZE" },
    );

    const largeNames = ["large-a.txt", "large-b.txt"];
    for (const name of largeNames)
      await writeFile(join(f.root, name), Buffer.alloc(10_000_001, "x"));
    await assert.rejects(
      app.previewInput(largeNames.map((name) => `@${name}`).join(" ")),
      { code: "INPUT_SIZE" },
    );
    await assert.rejects(readdir(f.p.attachments), { code: "ENOENT" });
    assert.equal(runtime.requests.length, 0);
  } finally {
    await app.close();
    await f.cleanup();
  }
});

test("redacted conversations do not inherit prior Git sources", async () => {
  const runtime = new ScriptedRuntime(async (request) => {
    const readSource = request.tools.find(
      (tool) => tool.name === "read_source",
    );
    assert.ok(readSource);
    await assert.rejects(
      readSource.execute(
        { id: gitSourceId!, startLine: 1, lines: 10 },
        request.signal,
      ),
      { code: "SOURCE" },
    );
    assert.match(
      await readSource.execute(
        { id: allowedSourceId!, startLine: 1, lines: 10 },
        request.signal,
      ),
      /authorized source/,
    );
    return "Previous non-Git evidence remains available only when authorized.";
  });
  const f = await fixture(runtime),
    app = new Application(f.config, f.p, f.store, f.root, async () => runtime);
  let gitSourceId: string | undefined, allowedSourceId: string | undefined;
  try {
    const gitBytes = Buffer.from("selected Git source\n"),
      origin = await gitWorkspace(f.root, {
        "inputs/git.patch": gitBytes.toString(),
        "aliases/git-copy.patch": gitBytes.toString(),
        "README.md": "safe source\n",
      }),
      sourceRun = await f.harness.create({
        kind: "chat",
        objective: "own Git source",
      });
    const owned = f.store.claim(sourceRun.id, true, true);
    const source = await f.store.artifact(
      owned,
      "git.patch",
      "source",
      gitBytes,
      { format: "git", locator: "working diff" },
    );
    const allowedSource = await f.store.artifact(
      owned,
      "note.txt",
      "source",
      Buffer.from("authorized source\n"),
      { format: "text", locator: "line 1" },
    );
    f.store.release(owned);
    gitSourceId = source.id;
    allowedSourceId = allowedSource.id;
    await app.initialize();
    app.session.workspace = origin;
    app.conversations.link(app.session, sourceRun);
    const context = (app.session.context ??= {
      pins: [],
      decisions: [],
      openQuestions: [],
      constraints: [],
      instructions: [],
      sourceIds: [],
      imageIds: [],
      originalRunIds: [],
      compactions: [],
      workingState: {
        checks: [],
        hashes: {},
        artifacts: [],
        operations: [],
        history: [],
      },
    });
    context.sourceIds = [source.id, allowedSource.id];
    context.redactedImageIds = [`img-${"a".repeat(64)}`];
    context.workingState.artifacts = [source.id, allowedSource.id];
    context.workingState.hashes = {
      "git.patch": source.sha256,
      "note.txt": allowedSource.sha256,
    };
    context.workingState.history = [
      {
        runId: sourceRun.id,
        status: "succeeded",
        checks: [],
        hashes: {
          "git.patch": source.sha256,
          "note.txt": allowedSource.sha256,
        },
        artifacts: [source.id, allowedSource.id],
        operations: [],
        results: [],
      },
    ];
    app.save();

    await app.submit("Explain the earlier evidence");
    await app.waitForIdle();
    const run = app.currentRun()!;
    assert.equal(run.state, "succeeded", run.reason);
    assert.ok(!run.contextState?.sourceIds.includes(source.id));
    assert.ok(!run.contextState?.workingState.artifacts.includes(source.id));
    assert.ok(
      !run.contextState?.workingState.history[0]?.artifacts.includes(source.id),
    );
    assert.equal(run.contextState?.workingState.hashes["git.patch"], undefined);
    assert.ok(
      !f.store
        .artifacts(run.id)
        .some(
          (artifact) =>
            artifact.kind === "source" && artifact.metadata.format === "git",
        ),
    );
    assert.ok(
      f.store
        .artifacts(run.id)
        .some((artifact) => artifact.id === allowedSource.id),
    );
    const snapshot = await readSnapshot(f.store.runDir(run.id));
    assert.ok(snapshot.redactedPaths?.includes("inputs/git.patch"));
    assert.ok(snapshot.redactedPaths?.includes("aliases/git-copy.patch"));
    await assert.rejects(
      readFile(join(f.store.runDir(run.id), "work", "inputs", "git.patch")),
      { code: "ENOENT" },
    );
    assert.equal(
      await readFile(
        join(f.store.runDir(run.id), "baseline", "inputs", "git.patch"),
        "utf8",
      ),
      gitBytes.toString(),
    );
  } finally {
    await app.close();
    await f.cleanup();
  }
});

test("restricted historical Git bytes are projected from work without granting source access", async () => {
  let gitSourceId: string | undefined;
  const runtime = new ScriptedRuntime(async (request) => {
    const readSource = request.tools.find(
      (tool) => tool.name === "read_source",
    );
    assert.ok(readSource);
    await assert.rejects(
      readSource.execute(
        { id: gitSourceId!, startLine: 1, lines: 10 },
        request.signal,
      ),
      { code: "SOURCE" },
    );
    return "The redacted working copy is safe to inspect.";
  });
  const f = await fixture(runtime),
    app = new Application(f.config, f.p, f.store, f.root, async () => runtime);
  try {
    const gitBytes = Buffer.from("restricted Git source bytes\n"),
      origin = await gitWorkspace(f.root, {
        "inputs/git.patch": gitBytes.toString(),
        "aliases/git-copy.patch": gitBytes.toString(),
        "README.md": "safe source\n",
      }),
      sourceRun = await f.harness.create({
        kind: "chat",
        objective: "restricted historical Git source",
        dataClass: "restricted",
      });
    const owned = f.store.claim(sourceRun.id, true, true);
    const source = await f.store.artifact(
      owned,
      "git.patch",
      "source",
      gitBytes,
      {
        format: "git",
        locator: "working diff",
      },
    );
    gitSourceId = source.id;
    f.store.release(owned);
    await app.initialize();
    app.session.workspace = origin;
    app.conversations.link(app.session, sourceRun);
    app.session.context = {
      pins: [],
      decisions: [],
      openQuestions: [],
      constraints: [],
      instructions: [],
      sourceIds: [],
      imageIds: [],
      redactedImageIds: [`img-${"a".repeat(64)}`],
      originalRunIds: [],
      compactions: [],
      workingState: {
        checks: [],
        hashes: {},
        artifacts: [],
        operations: [],
        history: [],
      },
    };
    app.save();
    await app.submit("Explain this repository");
    await app.waitForIdle();
    const run = app.currentRun()!;
    assert.equal(run.state, "succeeded", run.reason);
    assert.ok(
      !f.store
        .artifacts(run.id)
        .some((artifact) => artifact.metadata.format === "git"),
    );
    const snapshot = await readSnapshot(f.store.runDir(run.id));
    assert.ok(snapshot.redactedPaths?.includes("inputs/git.patch"));
    assert.ok(snapshot.redactedPaths?.includes("aliases/git-copy.patch"));
    await assert.rejects(
      readFile(join(f.store.runDir(run.id), "work", "inputs", "git.patch")),
      { code: "ENOENT" },
    );
    assert.equal(
      await readFile(
        join(f.store.runDir(run.id), "baseline", "inputs", "git.patch"),
        "utf8",
      ),
      gitBytes.toString(),
    );
    assert.equal(
      await readFile(join(origin, "inputs", "git.patch"), "utf8"),
      gitBytes.toString(),
    );
    assert.equal(runtime.requests.length, 1);
  } finally {
    await app.close();
    await f.cleanup();
  }
});

test("a waiting provider run resumes explicitly with the same request budget", async () => {
  const { AgentError } = await import("../src/types.js");
  const runtime = new ScriptedRuntime(async (_request, index) => {
    if (index === 0) throw new AgentError("PROVIDER", "offline");
    return "接続が復旧しました";
  });
  const f = await fixture(runtime),
    app = new Application(f.config, f.p, f.store, f.root, async () => runtime);
  try {
    await app.initialize();
    await app.submit("質問");
    await app.waitForIdle();
    const first = app.currentRun()!;
    assert.equal(first.state, "waiting_input");
    assert.equal(f.store.usage(first.id).requests, 1);
    await app.resume();
    assert.equal(app.currentRun()?.id, first.id);
    assert.equal(app.currentRun()?.state, "succeeded");
    assert.equal(f.store.usage(first.id).requests, 2);
  } finally {
    await app.close();
    await f.cleanup();
  }
});

test("resume rejects a conversation redaction set that differs from the run", async () => {
  const { AgentError } = await import("../src/types.js");
  const runtime = new ScriptedRuntime(async () => {
    throw new AgentError("PROVIDER", "offline");
  });
  const f = await fixture(runtime),
    app = new Application(f.config, f.p, f.store, f.root, async () => runtime);
  try {
    await app.initialize();
    await app.submit("質問");
    await app.waitForIdle();
    assert.equal(app.currentRun()?.state, "waiting_input");
    app.session.context ??= {
      pins: [],
      decisions: [],
      openQuestions: [],
      constraints: [],
      instructions: [],
      sourceIds: [],
      imageIds: [],
      redactedImageIds: [],
      originalRunIds: [],
      compactions: [],
      workingState: {
        checks: [],
        hashes: {},
        artifacts: [],
        operations: [],
        history: [],
      },
    };
    app.session.context.redactedImageIds = [`img-${"b".repeat(64)}`];
    app.save();
    await assert.rejects(app.resume(), { code: "IMAGE_REDACTED" });
    assert.equal(runtime.requests.length, 1);
  } finally {
    await app.close();
    await f.cleanup();
  }
});

test("configuration forms save through the schema, back up, and reject external edits", async () => {
  const { stringify } = await import("yaml");
  const { loadConfig } = await import("../src/config.js");
  const { SettingsDialog } = await import("../src/tui/settings.js");
  const runtime = new ScriptedRuntime(async () => "unused"),
    f = await fixture(runtime),
    app = new Application(f.config, f.p, f.store, f.root, async () => runtime);
  try {
    await writeFile(f.p.config, stringify(f.config), { mode: 0o600 });
    await app.initialize();
    const picks = ["local", "manual"],
      answers = [
        "second-local",
        "http://127.0.0.1:8080/v1",
        "second-model",
        "fixture-model",
      ];
    let editCount = 0;
    await new SettingsDialog(app, {
      edit: async () =>
        editCount++ === 0 ? { value: "connection" } : undefined,
      choose: async () => picks.shift(),
      prompt: async () => answers.shift(),
      confirm: async () => true,
      notify: () => {},
    }).open();
    const saved = await loadConfig(f.p);
    assert.equal(saved.connections["second-local"]!.enabled, false);
    assert.equal(saved.models["second-model"]!.id, "fixture-model");
    assert.equal(saved.models["second-model"]!.tools, false);
    assert.equal(runtime.requests.length, 0);
    assert.ok(await readFile(`${f.p.config}.bak`, "utf8"));
    const unsafe = structuredClone(app.config);
    unsafe.connections["second-local"]!.endpoint = "http://example.com";
    await assert.rejects(() => app.saveConfiguration(unsafe), /loopback/);
    const external = structuredClone(app.config);
    external.limits.maxRequests = 10;
    await writeFile(f.p.config, stringify(external), { mode: 0o600 });
    await assert.rejects(() => app.saveConfiguration(app.config), /外部で変更/);
    assert.equal((await loadConfig(f.p)).limits.maxRequests, 10);
  } finally {
    await app.close();
    await f.cleanup();
  }
});

test("cancelled apply retains an uncertain operation and terminal run without overwriting source", async (t) => {
  t.mock.method(Sandbox.prototype, "probe", async () => ({
    ok: true,
    detail: "unit fixture",
  }));
  t.mock.method(Sandbox.prototype, "execute", async () => ({
    code: 0,
    stdout: "ok",
    stderr: "",
    truncated: false,
  }));
  const config = testConfig();
  config.checks = { unit: { command: "test -s app.txt", protectedPaths: [] } };
  const runtime = new ScriptedRuntime(async (request) => {
    await call(request, "edit_file", {
      path: "app.txt",
      oldText: "baseline",
      newText: "edited",
    });
    return completed();
  });
  const f = await fixture(runtime, config),
    origin = await gitWorkspace(f.root, { "app.txt": "baseline" }),
    app = new Application(config, f.p, f.store, origin, async () => runtime);
  try {
    await app.initialize();
    await app.submit("fix app");
    await app.waitForIdle();
    const diff = await app.diff();
    const original = f.store.operation.bind(f.store);
    t.mock.method(
      f.store,
      "operation",
      (...args: Parameters<Store["operation"]>) => {
        original(...args);
        if (
          args[2] === "dispatched" &&
          f.store
            .operations(args[0].id)
            .some((o) => o.id === args[1] && o.name === "apply")
        )
          app.stop();
      },
    );
    await assert.rejects(() => app.apply(diff.token));
    assert.equal(app.currentRun()?.state, "succeeded");
    assert.equal(await readFile(join(origin, "app.txt"), "utf8"), "baseline");
    assert.ok(
      f.store
        .operations(diff.runId)
        .some((o) => o.name === "apply" && o.status === "unknown"),
    );
    assert.equal((await app.diff()).applicable, false);
  } finally {
    await app.close();
    await f.cleanup();
  }
});

test("real Pi SDK keeps worker and reviewer sessions and events distinct in one conversation", async (t) => {
  const config = testConfig();
  config.defaults.mode = "reviewed";
  const f = await fixture(new ScriptedRuntime(async () => "unused"), config);
  let calls = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (_input: unknown, init?: RequestInit) => {
      calls++;
      const payload = JSON.parse(String(init?.body)) as { model: string };
      const delta =
        calls === 1
          ? {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "write",
                  type: "function",
                  function: {
                    name: "write_file",
                    arguments: JSON.stringify({
                      path: "document.md",
                      content: "日本語の文書",
                      expectedSha256: null,
                    }),
                  },
                },
              ],
            }
          : {
              role: "assistant",
              content: completed(
                payload.model === "reviewer-fixture" ? [] : ["document.md"],
                payload.model,
              ),
            };
      return new Response(
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: payload.model, choices: [{ index: 0, delta, finish_reason: calls === 1 ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  );
  const app = new Application(
    config,
    f.p,
    f.store,
    f.root,
    async () => new PiRuntime(config, f.p),
  );
  const started: string[] = [];
  app.on("event", (event: AppEvent) => {
    if (event.type === "task_started") started.push(String(event.detail.model));
  });
  try {
    await app.initialize();
    await app.submit("日本語の文書を作成して");
    await app.waitForIdle();
    const run = app.currentRun()!;
    assert.equal(run.state, "succeeded", run.reason);
    assert.deepEqual(started, ["worker", "reviewer"]);
    assert.equal(calls, 3);
    assert.notEqual(run.tasks[0]!.sessionFile, run.tasks[1]!.sessionFile);
    assert.equal(f.store.usage(run.id).requests, 3);
  } finally {
    await app.close();
    await f.cleanup();
  }
});
