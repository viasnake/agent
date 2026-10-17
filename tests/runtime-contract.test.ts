import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { Application } from "../src/application.js";
import { estimateContextBytes } from "../src/context.js";
import { runRuntime } from "../src/runtime/contract.js";
import { AgentError, type Runtime, type RuntimeRequest } from "../src/types.js";
import { call, fixture, gitWorkspace, testConfig } from "./helpers.js";

const descriptor = {
  version: 1 as const,
  context: "messages-v1" as const,
  images: true,
  tools: true,
  sessionFormat: "independent-json-v1",
};
const unknownUsage = { input: null, output: null, costUsd: null };

function adapter(run: Runtime["run"]): Runtime {
  return { contract: { ...descriptor }, run, async close() {} };
}
function request(overrides: Partial<RuntimeRequest> = {}): RuntimeRequest {
  let counter = 0;
  return {
    model: "worker",
    role: "worker",
    objective: "fixture",
    system: "trusted host instruction",
    sessionDir: "/fixture/sessions/work",
    tools: [],
    signal: new AbortController().signal,
    onSession() {},
    beforeRequest: () => `reservation-${++counter}`,
    afterRequest() {},
    onEvent() {},
    ...overrides,
  };
}
function settle(input: RuntimeRequest): void {
  const id = input.beforeRequest(12);
  input.afterRequest(id, unknownUsage);
}

test("runtime contract rejects unsupported descriptors and foreign native sessions before invocation", async () => {
  let calls = 0;
  const runtime = adapter(async (input) => {
    calls++;
    settle(input);
    return "complete";
  });
  for (const contract of [
    { ...descriptor, version: 2 },
    { ...descriptor, context: "private-sdk-frame" },
    { ...descriptor, sessionFormat: "../escape" },
    { ...descriptor, sessionFormat: null },
  ]) {
    await assert.rejects(
      runRuntime({ ...runtime, contract } as Runtime, request()),
      { code: "RUNTIME_CONTRACT" },
    );
  }
  const tool = {
    name: "read",
    description: "fixture",
    parameters: {},
    async execute() {
      return "ok";
    },
  };
  await assert.rejects(
    runRuntime(
      { ...runtime, contract: { ...descriptor, tools: false } },
      request({ tools: [tool] }),
    ),
    { code: "RUNTIME_CONTRACT" },
  );
  await assert.rejects(
    runRuntime(
      { ...runtime, contract: { ...descriptor, images: false } },
      request({
        images: [{} as NonNullable<RuntimeRequest["images"]>[number]],
      }),
    ),
    { code: "RUNTIME_CONTRACT" },
  );
  const native = request({ sessionFile: "/fixture/sessions/old/native.json" });
  for (const format of [undefined, "another-runtime-v1"])
    await assert.rejects(runRuntime(runtime, native, format), {
      code: "RUNTIME_SESSION",
    });
  assert.equal(calls, 0);
  assert.equal(
    await runRuntime(runtime, native, descriptor.sessionFormat),
    "complete",
  );
  assert.equal(calls, 1);
  await runRuntime(
    { ...runtime, contract: { ...descriptor, acceptsLegacySessions: true } },
    native,
  );
  assert.equal(calls, 2);
});

test("runtime contract guards accounting, frame translation and native session registration", async () => {
  const violations: Array<Runtime["run"]> = [
    async () => "unaccounted",
    async (input) => {
      input.beforeRequest(1);
      return "unsettled";
    },
    async (input) => {
      settle(input);
      input.afterRequest("reservation-1", unknownUsage);
      return "duplicate";
    },
    async (input) => {
      input.afterRequest("unknown", unknownUsage);
      return "unknown";
    },
    async (input) => {
      input.beforeRequest(-1);
      return "negative estimate";
    },
    async (input) => {
      input.afterRequest(input.beforeRequest(1), {
        ...unknownUsage,
        output: -1,
      });
      return "invalid usage";
    },
    async (input) => {
      await input.transformContext!(
        { messages: [{ role: "native-private-role" }] },
        input.signal,
      );
      settle(input);
      return "bad frame";
    },
    async (input) => {
      input.onSession("/fixture/outside.json");
      settle(input);
      return "outside";
    },
    async (input) => {
      try {
        input.beforeRequest(-1);
      } catch {}
      return "swallowed";
    },
  ];
  for (const run of violations)
    await assert.rejects(runRuntime(adapter(run), request()), {
      code: "RUNTIME_CONTRACT",
    });
  const denied = new AgentError("QUOTA", "fixture exhausted");
  await assert.rejects(
    runRuntime(
      adapter(async (input) => {
        try {
          input.beforeRequest(1);
        } catch {}
        return "swallowed quota";
      }),
      request({
        beforeRequest: () => {
          throw denied;
        },
      }),
    ),
    (error) => error === denied,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runRuntime(
      adapter(async () => assert.fail("must not invoke")),
      request({ signal: controller.signal }),
    ),
    { name: "AbortError" },
  );
});

test("runtime contract preserves exact unknown usage, transformed context and awaited tools but blocks late work", async () => {
  let captured: RuntimeRequest | undefined,
    toolCalls = 0,
    events = 0;
  const settlements: unknown[] = [],
    sessions: unknown[] = [];
  const runtime = adapter(async (input) => {
    captured = input;
    const frame = await input.transformContext!(
      { messages: [{ role: "user", content: "original" }] },
      input.signal,
    );
    assert.deepEqual(frame, {
      messages: [{ role: "user", content: "transformed" }],
    });
    input.onSession(join(input.sessionDir, "native.json"));
    const id = input.beforeRequest(123, 2, 16384);
    input.afterRequest(id, unknownUsage);
    assert.equal(await call(input, "read", {}), "evidence");
    input.onEvent("text_delta", { text: "provisional" });
    return "complete";
  });
  assert.equal(
    await runRuntime(
      runtime,
      request({
        transformContext: async () => ({
          messages: [{ role: "user", content: "transformed" }],
        }),
        tools: [
          {
            name: "read",
            description: "fixture",
            parameters: {},
            async execute(_args, signal) {
              signal.throwIfAborted();
              toolCalls++;
              return "evidence";
            },
          },
        ],
        beforeRequest: (bytes, images, tokens) => {
          assert.deepEqual([bytes, images, tokens], [123, 2, 16384]);
          return "one";
        },
        afterRequest: (id, usage) => settlements.push([id, usage]),
        onSession: (file, format) => sessions.push([file, format]),
        onEvent: () => {
          events++;
        },
      }),
    ),
    "complete",
  );
  assert.deepEqual(settlements, [["one", unknownUsage]]);
  assert.deepEqual(sessions, [
    ["/fixture/sessions/work/native.json", descriptor.sessionFormat],
  ]);
  assert.equal(toolCalls, 1);
  assert.equal(captured!.signal.aborted, true);
  await assert.rejects(call(captured!, "read", {}), {
    code: "RUNTIME_CONTRACT",
  });
  assert.throws(() => captured!.onSession("/fixture/sessions/work/late.json"), {
    code: "RUNTIME_CONTRACT",
  });
  captured!.onEvent("text_delta", { text: "late" });
  assert.equal(events, 1);
  assert.equal(toolCalls, 1);
});

test("runtime contract rejects post-cancellation success and drains cancellation into outstanding tools", async () => {
  const controller = new AbortController();
  let settlements = 0;
  await assert.rejects(
    runRuntime(
      adapter(async (input) => {
        const id = input.beforeRequest(1);
        controller.abort();
        input.afterRequest(id, unknownUsage);
        return "must not succeed";
      }),
      request({
        signal: controller.signal,
        afterRequest() {
          settlements++;
        },
      }),
    ),
    { name: "AbortError" },
  );
  assert.equal(settlements, 1);
  let pending: Promise<string> | undefined;
  await assert.rejects(
    runRuntime(
      adapter(async (input) => {
        settle(input);
        pending = call(input, "wait", {});
        return "unfinished tool";
      }),
      request({
        tools: [
          {
            name: "wait",
            description: "fixture",
            parameters: {},
            execute: async (_args, signal) =>
              new Promise<string>((resolve) => {
                signal.addEventListener("abort", () => resolve("cancelled"), {
                  once: true,
                });
              }),
          },
        ],
      }),
    ),
    { code: "RUNTIME_CONTRACT" },
  );
  assert.equal(await pending, "cancelled");
});

class JsonSessionRuntime implements Runtime {
  readonly contract = { ...descriptor };
  readonly requests: RuntimeRequest[] = [];
  constructor(
    readonly respond: (input: RuntimeRequest) => Promise<string>,
    readonly seed: unknown[] = [],
  ) {}
  async run(input: RuntimeRequest): Promise<string> {
    input.signal.throwIfAborted();
    this.requests.push(input);
    const prior = input.sessionFile
      ? (JSON.parse(await readFile(input.sessionFile, "utf8"))
          .messages as unknown[])
      : this.seed;
    const context = (await input.transformContext!(
      {
        systemPrompt: input.system,
        messages: [...prior, { role: "user", content: input.objective }],
      },
      input.signal,
    )) as { messages: unknown[] };
    const reservation = input.beforeRequest(estimateContextBytes(context));
    const result = await this.respond(input);
    input.afterRequest(reservation, unknownUsage);
    input.signal.throwIfAborted();
    const file = join(input.sessionDir, "native.json");
    await mkdir(input.sessionDir, { recursive: true, mode: 0o700 });
    await writeFile(
      file,
      JSON.stringify({
        messages: [...context.messages, { role: "assistant", content: result }],
      }),
      { mode: 0o600 },
    );
    input.onSession(file);
    return result;
  }
  async close() {}
}

test("independent JSON adapter preserves host evidence, context and session ownership across restart and explicit replacement", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    assert.fail("No network or Pi inference"),
  );
  const original = new JsonSessionRuntime(
    async (input) => {
      assert.ok(input.constraints?.includes("変更しない"));
      assert.ok(
        !input.tools.some(
          (tool) => tool.name === "write_file" || tool.name === "shell",
        ),
      );
      const objective = JSON.parse(input.objective);
      if (objective.selectedSkills.length) {
        const source = await call(input, "read_source", {
          id: objective.selectedSkills[0].sourceId,
        });
        assert.match(source, /stable evidence/);
      }
      return "手順を確認しました。";
    },
    [
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "old", function: { name: "read_file" } }],
      },
      {
        role: "tool",
        tool_call_id: "old",
        content: "seeded log ".repeat(6000),
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "latest", function: { name: "read_file" } }],
      },
      { role: "tool", tool_call_id: "latest", content: "latest preserved" },
    ],
  );
  const replacement = new JsonSessionRuntime(original.respond);
  replacement.contract.sessionFormat = "independent-json-v2";
  let selected: Runtime = original;
  const config = testConfig();
  config.models.worker!.contextWindow = 8192;
  config.models.worker!.maxOutputTokens = 256;
  const f = await fixture(original, config);
  const workspace = await gitWorkspace(f.root, {
    "skills/example/SKILL.md": "stable evidence",
  });
  let app = new Application(
    f.config,
    f.p,
    f.store,
    workspace,
    async () => selected,
  );
  try {
    await app.initialize();
    app.addConstraint("変更しない");
    app.addPin("固定事項を保持する");
    const sessionId = app.session.id;
    const text = '覚えてください @"skill:skills/example/SKILL.md"';
    await app.submit(text, "instruction", await app.previewInput(text));
    await app.waitForIdle();
    const first = app.currentRun()!;
    assert.equal(first.state, "succeeded", first.reason);
    assert.equal(first.tasks[0]!.sessionFormat, descriptor.sessionFormat);
    assert.ok(first.compactions?.length);
    assert.match(
      await app.readContext(first.compactions![0]!.archiveId),
      /seeded log/,
    );
    assert.ok(
      f.store
        .operations(first.id)
        .some(
          (operation) =>
            operation.name === "read_source" &&
            operation.status === "completed",
        ),
    );
    assert.equal(f.store.usage(first.id).requests, 1);
    assert.equal(app.view().usage?.input, null);
    const file = first.tasks[0]!.sessionFile!;
    const saved = await readFile(file, "utf8");
    await app.close();
    app = new Application(
      f.config,
      f.p,
      f.store,
      workspace,
      async () => selected,
    );
    await app.initialize();
    app.openSession(sessionId);
    await app.submit("続けてください");
    await app.waitForIdle();
    assert.equal(
      app.currentRun()!.state,
      "succeeded",
      app.currentRun()!.reason,
    );
    assert.equal(original.requests[1]!.sessionFile, file);
    assert.notEqual(app.currentRun()!.tasks[0]!.sessionFile, file);
    assert.equal(await readFile(file, "utf8"), saved);
    selected = replacement;
    await app.submit("続けてください");
    await app.waitForIdle();
    assert.equal(
      app.currentRun()!.state,
      "waiting_input",
      app.currentRun()!.reason,
    );
    assert.match(app.currentRun()!.reason!, /RUNTIME_SESSION/);
    assert.equal(replacement.requests.length, 0);
    selected = original;
    await app.resume();
    await app.waitForIdle();
    assert.equal(
      app.currentRun()!.state,
      "succeeded",
      app.currentRun()!.reason,
    );
    await app.compact();
    selected = replacement;
    await app.submit("固定事項を保って続けてください");
    await app.waitForIdle();
    assert.equal(
      app.currentRun()!.state,
      "succeeded",
      app.currentRun()!.reason,
    );
    assert.equal(replacement.requests.length, 1);
    assert.equal(replacement.requests[0]!.sessionFile, undefined);
    assert.match(replacement.requests[0]!.objective, /固定事項を保持する/);
    assert.equal(
      app.currentRun()!.tasks[0]!.sessionFormat,
      "independent-json-v2",
    );
    assert.equal(await readFile(file, "utf8"), saved);
  } finally {
    await app.close();
    await f.cleanup();
  }
});
