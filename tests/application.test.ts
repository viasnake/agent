import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  Application,
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

test("compaction creates a deterministic handoff without extra inference or deleting history", async () => {
  const runtime = new ScriptedRuntime(async () => "回答"),
    f = await fixture(runtime),
    app = new Application(f.config, f.p, f.store, f.root, async () => runtime);
  try {
    await app.initialize();
    await app.submit("質問");
    await app.waitForIdle();
    const runId = app.currentRun()!.id;
    await app.compact();
    assert.equal(runtime.requests.length, 1);
    assert.equal(app.session.compacted, true);
    assert.equal(
      JSON.parse(
        await readFile(join(f.store.runDir(runId), "handoff.json"), "utf8"),
      ).state,
      "succeeded",
    );
    await app.submit("続けて質問");
    await app.waitForIdle();
    assert.ok(app.currentRun()?.context);
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
    await app.submit("調査してください @note.md");
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
    const picks = ["connection", "local"],
      answers = ["second-local", "http://127.0.0.1:8080/v1"];
    await new SettingsDialog(app, {
      choose: async () => picks.shift(),
      prompt: async () => answers.shift(),
      confirm: async () => true,
      notify: () => {},
    }).open();
    assert.equal(
      (await loadConfig(f.p)).connections["second-local"]!.enabled,
      false,
    );
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
