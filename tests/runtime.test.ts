import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { Harness } from "../src/harness.js";
import { endpointFetch, publicAddress } from "../src/network.js";
import {
  PiRuntime,
  configuredThinkingLevel,
  isolatedLoader,
} from "../src/runtime/pi.js";
import { connectionRuntime } from "../src/runtime/providers.js";
import { validateConfig } from "../src/config.js";
import type { RuntimeRequest } from "../src/types.js";
import { normalizePayload } from "../src/runtime/transport.js";
import { ScriptedRuntime, completed, fixture, testConfig } from "./helpers.js";

function response(
  delta: Record<string, unknown>,
  finish: string | null = "stop",
): Response {
  const chunks = [
    {
      id: "fixture",
      object: "chat.completion.chunk",
      created: 1,
      model: "worker-fixture",
      choices: [{ index: 0, delta, finish_reason: finish }],
    },
    {
      id: "fixture",
      object: "chat.completion.chunk",
      choices: [],
      usage: { prompt_tokens: 15, completion_tokens: 12, total_tokens: 27 },
    },
  ];
  return new Response(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
      "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
}

test("model profiles isolate same-ID aliases and apply thinking on resumed SDK sessions", async (t) => {
  const config = testConfig();
  Object.assign(config.models.worker!, {
    reasoning: true,
    thinkingLevel: "high",
    maxOutputTokens: 768,
  });
  Object.assign(config.models.reviewer!, {
    id: config.models.worker!.id,
    reasoning: true,
    thinkingLevel: "low",
    maxOutputTokens: 256,
  });
  validateConfig(config);
  const f = await fixture(new ScriptedRuntime(async () => completed()), config);
  const payloads: Record<string, unknown>[] = [];
  const profiles: Record<string, unknown>[] = [];
  let reservations = 0,
    accounts = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      payloads.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return response({ role: "assistant", content: "Profile fixture" });
    },
  );
  const sessions = new Map<string, string>();
  const request = (model: string): RuntimeRequest => ({
    model,
    role: model === "worker" ? "worker" : "reviewer",
    objective: "Synthetic profile check",
    system: "Fixture only",
    sessionDir: join(f.root, "profile-sessions", model),
    sessionFile: sessions.get(model),
    tools: [],
    signal: new AbortController().signal,
    onSession: (file) => {
      sessions.set(model, file);
    },
    beforeRequest: () => String(++reservations),
    afterRequest: () => {
      accounts++;
    },
    onEvent: (type, detail) => {
      if (type === "model_profile") profiles.push(detail);
    },
  });
  try {
    const runtime = new PiRuntime(config, f.p);
    await runtime.run(request("worker"));
    await runtime.run(request("reviewer"));
    const original = sessions.get("worker");
    await runtime.run(request("worker"));
    assert.equal(sessions.get("worker"), original);
    config.models.worker!.thinkingLevel = "off";
    await runtime.run(request("worker"));
    assert.deepEqual(
      payloads.map((p) => p.reasoning_effort),
      ["high", "low", "high", undefined],
    );
    assert.deepEqual(
      payloads.map((p) => p.max_tokens),
      [768, 256, 768, 768],
    );
    assert.ok(payloads.every((p) => p.model === config.models.worker!.id));
    assert.deepEqual(
      profiles.map((p) => [p.model, p.thinkingLevel, p.maxOutputTokens]),
      [
        ["worker", "high", 768],
        ["reviewer", "low", 256],
        ["worker", "high", 768],
        ["worker", "off", 768],
      ],
    );
    assert.equal(reservations, 4);
    assert.equal(accounts, 4);
  } finally {
    await f.cleanup();
  }
});

test("thinking profiles remain optional and unsupported explicit levels fail before requests", async (t) => {
  const config = testConfig();
  const original = JSON.stringify(config);
  assert.equal(JSON.stringify(validateConfig(config)), original);
  assert.equal("thinkingLevel" in config.models.worker!, false);
  const f = await fixture(new ScriptedRuntime(async () => completed()), config);
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    throw new Error("No network allowed");
  });
  try {
    const provider = await connectionRuntime(config, f.p, "local", "worker");
    const model = provider.getModel(
      "agent-compatible",
      config.models.worker!.id,
    )!;
    assert.equal(configuredThinkingLevel(model, config.models.worker!), "off");
    assert.throws(
      () =>
        configuredThinkingLevel(model, {
          ...config.models.worker!,
          thinkingLevel: "high",
        }),
      /does not support/,
    );
    const native = {
      ...model,
      reasoning: true,
      thinkingLevelMap: { high: null },
    };
    assert.throws(
      () =>
        configuredThinkingLevel(native, {
          ...config.models.worker!,
          thinkingLevel: "high",
        }),
      /does not support/,
    );
    assert.equal(
      configuredThinkingLevel(native, {
        ...config.models.worker!,
        thinkingLevel: "low",
      }),
      "low",
    );
    config.models.worker!.thinkingLevel = "high";
    assert.throws(() => validateConfig(config), /capability must be enabled/);
    await assert.rejects(
      () =>
        new PiRuntime(config, f.p).run({
          model: "worker",
          role: "worker",
          objective: "Never sent",
          system: "Never sent",
          sessionDir: join(f.root, "rejected-profile"),
          tools: [],
          signal: new AbortController().signal,
          onSession: () => assert.fail("No session for unsupported capability"),
          beforeRequest: () => {
            requests++;
            return "unexpected";
          },
          afterRequest: () => assert.fail(),
          onEvent: () => assert.fail(),
        }),
      /does not support/,
    );
    assert.equal(requests, 0);
    config.models.worker!.reasoning = true;
    assert.doesNotThrow(() => validateConfig(config));
    config.models.worker!.reasoning = false;
    assert.throws(() => validateConfig(config), /capability must be enabled/);
  } finally {
    await f.cleanup();
  }
});
test("pinned Pi SDK executes registered tools, persists a session and accounts for each turn", async (t) => {
  const f = await fixture(new ScriptedRuntime(async () => completed()));
  let calls = 0;
  const payloads: Record<string, unknown>[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      assert.equal(url, "http://127.0.0.1:12345/v1/chat/completions");
      assert.equal(init?.redirect, "error");
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      payloads.push(payload);
      calls++;
      if (calls === 1)
        return response(
          {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "write-1",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({
                    path: "answer.md",
                    content: "SDK integration works.",
                    expectedSha256: null,
                  }),
                },
              },
            ],
          },
          "tool_calls",
        );
      return response({ role: "assistant", content: completed(["answer.md"]) });
    },
  );
  try {
    const runner = new Harness(
        f.config,
        f.p,
        f.store,
        new PiRuntime(f.config, f.p),
      ),
      run = await runner.create({
        kind: "writing",
        objective: "write a document",
      });
    const result = await runner.execute(run.id);
    assert.equal(result.state, "succeeded", result.reason);
    assert.equal(calls, 2);
    assert.equal(f.store.usage(run.id).requests, 2);
    assert.equal(
      await readFile(join(f.store.runDir(run.id), "work", "answer.md"), "utf8"),
      "SDK integration works.",
    );
    assert.match(result.tasks[0]!.sessionFile!, /\.jsonl$/);
    assert.ok(
      (await readdir(join(f.store.runDir(run.id), "sessions", "work"))).some(
        (n) => n.endsWith(".jsonl"),
      ),
    );
    assert.ok(
      (payloads[1]!.messages as Array<{ role: string }>).some(
        (m) => m.role === "tool",
      ),
    );
    assert.equal(
      (payloads[0]!.tools as Array<{ function: { name: string } }>).some((t) =>
        ["bash", "read", "write", "edit"].includes(t.function.name),
      ),
      false,
    );
  } finally {
    await f.cleanup();
  }
});
test("incomplete provider stream cannot dispatch complete-looking tool arguments", async (t) => {
  const f = await fixture(new ScriptedRuntime(async () => completed()));
  t.mock.method(globalThis, "fetch", async () =>
    response(
      {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "write-1",
            type: "function",
            function: {
              name: "write_file",
              arguments: JSON.stringify({
                path: "should-not-exist.md",
                content: "incomplete",
                expectedSha256: null,
              }),
            },
          },
        ],
      },
      null,
    ),
  );
  try {
    const runner = new Harness(
        f.config,
        f.p,
        f.store,
        new PiRuntime(f.config, f.p),
      ),
      run = await runner.create({
        kind: "writing",
        objective: "test incomplete stream",
      });
    const result = await runner.execute(run.id);
    assert.equal(result.state, "failed");
    assert.deepEqual(await readdir(join(f.store.runDir(run.id), "work")), []);
    assert.equal(f.store.operations(run.id).length, 0);
  } finally {
    await f.cleanup();
  }
});
test("429 waits after one SDK request and cannot silently retry or change providers", async (t) => {
  const f = await fixture(new ScriptedRuntime(async () => completed()));
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response(
      JSON.stringify({
        error: { message: "fixture quota", type: "rate_limit_error" },
      }),
      {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "2" },
      },
    );
  });
  try {
    const runner = new Harness(
        f.config,
        f.p,
        f.store,
        new PiRuntime(f.config, f.p),
      ),
      run = await runner.create({ kind: "writing", objective: "test quota" });
    const result = await runner.execute(run.id);
    assert.equal(result.state, "waiting_quota", result.reason);
    assert.equal(calls, 1);
    assert.equal(f.store.usage(run.id).requests, 1);
  } finally {
    await f.cleanup();
  }
});
test("SDK cannot load project extensions, skills, context files or default shell tools", () => {
  const loader = isolatedLoader("fixed system");
  assert.deepEqual(loader.getAgentsFiles(), { agentsFiles: [] });
  assert.equal(loader.getExtensions().extensions.length, 0);
  assert.equal(loader.getSkills().skills.length, 0);
  assert.equal(loader.getPrompts().prompts.length, 0);
});
test("Sarashina sends auto tool choice, supported limits and no stream_options", () => {
  const conn = {
    ...testConfig().connections.local!,
    type: "sarashina" as const,
  };
  const body = normalizePayload(
    {
      tools: [{ type: "function" }],
      stream_options: { include_usage: true },
      max_tokens: 9999,
      store: true,
    },
    conn,
    9999,
  ) as Record<string, unknown>;
  assert.equal(body.tool_choice, "auto");
  assert.equal(body.max_completion_tokens, 8000);
  assert.equal("stream_options" in body, false);
  assert.equal("max_tokens" in body, false);
  assert.equal("store" in body, false);
  const chatgpt = normalizePayload(
    { store: true, stream: false, max_output_tokens: 4000 },
    { ...conn, type: "chatgpt" },
    4000,
  ) as Record<string, unknown>;
  assert.equal(chatgpt.store, false);
  assert.equal(chatgpt.stream, true);
  assert.equal("max_output_tokens" in chatgpt, false);
});
test("transport blocks endpoint changes and forces redirect rejection", async (t) => {
  let sent = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      sent++;
      assert.equal(init?.redirect, "error");
      return new Response("ok");
    },
  );
  const guarded = endpointFetch(
    "https://api.example.invalid/v1",
    new AbortController().signal,
  );
  await assert.rejects(
    () => guarded("https://evil.invalid/v1/responses"),
    /unconfigured/,
  );
  await assert.rejects(
    () => guarded("https://api.example.invalid/other"),
    /unconfigured/,
  );
  assert.equal(sent, 0);
  await guarded("https://api.example.invalid/v1/responses");
  assert.equal(sent, 1);
});
test("public fetch address filtering rejects private, metadata, transition and mapped ranges", () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "100.100.100.200",
    "192.168.1.1",
    "0.0.0.0",
    "198.18.0.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "2002:7f00:1::1",
    "2001:db8::1",
  ])
    assert.equal(publicAddress(address), false, address);
  assert.equal(publicAddress("8.8.8.8"), true);
  assert.equal(publicAddress("2606:4700:4700::1111"), true);
});

function nativeResponse(item: Record<string, unknown>): Response {
  const events = [
    { type: "response.created", response: { id: "fixture" } },
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "fixture",
        status: "completed",
        output: [item],
        usage: {
          input_tokens: 15,
          output_tokens: 12,
          total_tokens: 27,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    },
  ];
  return new Response(
    events
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}
test("ChatGPT OAuth uses public Responses API, completes tools and never loads Codex credentials", async (t) => {
  const config = testConfig();
  config.connections.local = {
    ...config.connections.local!,
    type: "chatgpt",
    billing: "subscription",
    endpoint: undefined,
  };
  config.models.worker!.id = "gpt-4.1";
  const f = await fixture(new ScriptedRuntime(async () => completed()), config);
  let calls = 0;
  await mkdir(join(f.p.auth, "local"), { mode: 0o700 });
  // This fabricated, unexpired credential belongs only to this temporary test home.
  await writeFile(
    join(f.p.auth, "local", "auth.json"),
    JSON.stringify({
      openai: {
        type: "oauth",
        access: "fixture-oauth-access",
        refresh: "fixture-refresh",
        expires: Date.now() + 3600000,
      },
    }),
    { mode: 0o600 },
  );
  t.mock.method(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      assert.equal(url, "https://api.openai.com/v1/responses");
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer fixture-oauth-access",
      );
      const body = JSON.parse(String(init?.body));
      assert.equal(body.store, false);
      assert.equal(body.stream, true);
      assert.equal("max_output_tokens" in body, false);
      calls++;
      return nativeResponse(
        calls === 1
          ? {
              type: "function_call",
              id: "fc_fixture",
              call_id: "call_fixture",
              name: "write_file",
              arguments: JSON.stringify({
                path: "answer.md",
                content: "ChatGPT contract verified.",
                expectedSha256: null,
              }),
            }
          : {
              type: "message",
              id: "msg_fixture",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: completed(["answer.md"]),
                  annotations: [],
                },
              ],
            },
      );
    },
  );
  try {
    const harness = new Harness(
      config,
      f.p,
      f.store,
      new PiRuntime(config, f.p),
    );
    const run = await harness.create({
      kind: "writing",
      objective: "exercise public OAuth transport",
    });
    const result = await harness.execute(run.id);
    assert.equal(result.state, "succeeded", result.reason);
    assert.equal(calls, 2);
    assert.equal(f.store.usage(run.id).unknownCostRequests, 2);
  } finally {
    await f.cleanup();
  }
});
test("native Gemini uses its explicit API key, tool protocol and usage accounting", async (t) => {
  const config = testConfig();
  config.connections.local = {
    ...config.connections.local!,
    type: "gemini",
    billing: "api",
    endpoint: undefined,
    secretEnv: "AGENT_TEST_GEMINI_KEY",
    maxRequestUsd: 0.1,
  };
  config.models.worker!.id = "gemini-2.5-flash";
  config.limits.maxApiUsd = 1;
  const previous = process.env.AGENT_TEST_GEMINI_KEY;
  process.env.AGENT_TEST_GEMINI_KEY = "fixture-key";
  const f = await fixture(new ScriptedRuntime(async () => completed()), config);
  let calls = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      assert.match(
        req.url,
        /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-2\.5-flash:streamGenerateContent/,
      );
      assert.equal(req.headers.get("x-goog-api-key"), "fixture-key");
      calls++;
      const body = JSON.parse(await req.text());
      assert.ok(body.contents.length);
      assert.ok(body.tools.length);
      const part =
        calls === 1
          ? {
              functionCall: {
                name: "write_file",
                args: {
                  path: "answer.md",
                  content: "Gemini contract verified.",
                  expectedSha256: null,
                },
              },
            }
          : { text: completed(["answer.md"]) };
      return new Response(
        `data: ${JSON.stringify({ candidates: [{ index: 0, content: { role: "model", parts: [part] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 15, candidatesTokenCount: 12, totalTokenCount: 27 } })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  );
  try {
    const harness = new Harness(
      config,
      f.p,
      f.store,
      new PiRuntime(config, f.p),
    );
    const run = await harness.create({
      kind: "writing",
      objective: "exercise native Gemini transport",
    });
    const result = await harness.execute(run.id);
    assert.equal(result.state, "succeeded", result.reason);
    assert.equal(calls, 2);
    assert.equal(f.store.usage(run.id).input, 30);
    assert.ok(f.store.usage(run.id).knownCostUsd > 0);
  } finally {
    await f.cleanup();
    if (previous === undefined) delete process.env.AGENT_TEST_GEMINI_KEY;
    else process.env.AGENT_TEST_GEMINI_KEY = previous;
  }
});

test("a transient provider failure can resume its saved session without automatic retries", async (t) => {
  const f = await fixture(new ScriptedRuntime(async () => completed()));
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    if (calls === 1)
      return Response.json(
        { error: { message: "fixture unavailable" } },
        { status: 503 },
      );
    if (calls === 2)
      return response(
        {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "recovery",
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({
                  path: "answer.md",
                  content: "Recovered document.",
                  expectedSha256: null,
                }),
              },
            },
          ],
        },
        "tool_calls",
      );
    return response({ role: "assistant", content: completed(["answer.md"]) });
  });
  try {
    const harness = new Harness(
      f.config,
      f.p,
      f.store,
      new PiRuntime(f.config, f.p),
    );
    const run = await harness.create({
      kind: "writing",
      objective: "recover after network error",
    });
    const waiting = await harness.execute(run.id);
    assert.equal(waiting.state, "waiting_input", waiting.reason);
    assert.equal(calls, 1);
    const session = waiting.tasks[0]!.sessionFile;
    const resumed = await harness.execute(run.id);
    assert.equal(resumed.state, "succeeded", resumed.reason);
    assert.equal(resumed.tasks[0]!.sessionFile, session);
    assert.equal(resumed.tasks[0]!.attempts, 2);
  } finally {
    await f.cleanup();
  }
});
