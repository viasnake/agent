import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configSchema } from "../src/config.js";
import {
  archiveContext,
  compactContext,
  contextBudget,
  normalizeConversationContext,
  readContextArchive,
} from "../src/context.js";
import { AgentError, type ConversationContext } from "../src/types.js";
import { Application } from "../src/application.js";
import { Conversations } from "../src/conversations.js";
import { PiRuntime } from "../src/runtime/pi.js";
import type { RuntimeRequest, ToolSpec } from "../src/types.js";
import { ScriptedRuntime, fixture, testConfig } from "./helpers.js";

function providerContext(toolText: string) {
  return {
    messages: [
      { role: "user", content: "Preserve this instruction verbatim." },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call-old", function: { name: "read_file" } }],
      },
      {
        role: "tool",
        tool_call_id: "call-old",
        content: toolText,
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call-latest", function: { name: "read_file" } }],
      },
      {
        role: "tool",
        tool_call_id: "call-latest",
        content: "latest result stays verbatim",
      },
    ],
  };
}

function providerResponse(
  delta: Record<string, unknown>,
  finish: string,
): Response {
  const chunk = {
    id: "context-fixture",
    object: "chat.completion.chunk",
    created: 1,
    model: "worker-fixture",
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
}

test("context archives are private, hash-idempotent, and compact only older tool results", async () => {
  const f = await fixture(new ScriptedRuntime(async () => "unused"));
  try {
    const run = await f.harness.create({
      kind: "chat",
      objective: "explain",
      conversationId: "c8640e18-3c84-47d9-a552-534aa55281d2",
    });
    const context = providerContext("large tool result ".repeat(1000));
    const compacted = await compactContext(f.p, run, context, {
      config: f.config,
      contextWindow: 2048,
      maxOutputTokens: 256,
      trigger: "automatic",
    });
    assert.ok(compacted);
    assert.ok(
      JSON.stringify(compacted.context).length < JSON.stringify(context).length,
    );
    const after = compacted.context as typeof context;
    assert.equal(after.messages[0]!.content, context.messages[0]!.content);
    assert.deepEqual(after.messages[1], context.messages[1]);
    assert.match(String(after.messages[2]!.content), /read_context/);
    assert.equal(after.messages[3]!.tool_calls?.[0]?.id, "call-latest");
    assert.equal(after.messages[4]!.content, "latest result stays verbatim");
    assert.equal(
      JSON.parse(await readContextArchive(f.p, run, compacted.record.archiveId))
        .messages[2].content,
      context.messages[2]!.content,
    );
    const archive = await readContextArchive(
      f.p,
      run,
      compacted.record.archiveId,
    );
    assert.equal(
      await readContextArchive(f.p, run, compacted.record.archiveId, 80, 11),
      Buffer.from(archive).subarray(11, 91).toString("utf8"),
    );
    const duplicate = await archiveContext(f.p, run, context);
    assert.equal(duplicate.archiveId, compacted.record.archiveId);
    assert.deepEqual(
      await readdir(
        join(f.p.home, "conversations", run.conversationId!, "archives"),
      ),
      [`${duplicate.archiveId}.json`],
    );
  } finally {
    await f.cleanup();
  }
});

test("compaction falls back to bounded archive markers to reach its target", async () => {
  const config = configSchema.parse(testConfig());
  config.models.worker!.contextWindow = 14_000;
  config.models.worker!.maxOutputTokens = 1_000;
  const f = await fixture(new ScriptedRuntime(async () => "unused"), config);
  try {
    const run = await f.harness.create({
      kind: "chat",
      objective: "inspect tool history",
    });
    const messages: Record<string, unknown>[] = [
      { role: "user", content: "Preserve the original request." },
    ];
    for (let index = 0; index < 24; index++) {
      const callId = `call-${index}`;
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [{ id: callId, function: { name: "read_file" } }],
      });
      messages.push({
        role: "tool",
        tool_call_id: callId,
        content: "verbose result ".repeat(140),
      });
    }
    messages.push(
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call-latest", function: { name: "read_file" } }],
      },
      {
        role: "tool",
        tool_call_id: "call-latest",
        content: "latest result remains verbatim",
      },
    );
    const context = { messages };
    const budget = contextBudget(
      f.config,
      config.models.worker!.contextWindow,
      config.models.worker!.maxOutputTokens,
    );
    const compacted = await compactContext(f.p, run, context, {
      config: f.config,
      contextWindow: config.models.worker!.contextWindow,
      maxOutputTokens: config.models.worker!.maxOutputTokens,
      trigger: "automatic",
    });
    assert.ok(compacted);
    assert.ok(compacted.record.afterBytes <= budget.targetBytes);
    const afterMessages = (compacted.context as typeof context).messages;
    assert.equal(afterMessages[0]!.content, messages[0]!.content);
    assert.equal(
      afterMessages.at(-1)!.content,
      "latest result remains verbatim",
    );
    assert.ok(
      afterMessages.some(
        (message) =>
          message.role === "tool" &&
          String(message.content).includes("Older tool result archived"),
      ),
    );
    assert.deepEqual(
      afterMessages
        .filter((message) => message.role === "tool")
        .map((message) => message.tool_call_id),
      messages
        .filter((message) => message.role === "tool")
        .map((message) => message.tool_call_id),
    );
  } finally {
    await f.cleanup();
  }
});

test("context archive reads verify the digest without returning unbounded data", async () => {
  const f = await fixture(new ScriptedRuntime(async () => "unused"));
  try {
    const run = await f.harness.create({
      kind: "chat",
      objective: "explain",
    });
    const context = providerContext("archived evidence ".repeat(1000));
    const { archiveId } = await archiveContext(f.p, run, context);
    assert.ok(
      (await readContextArchive(f.p, run, archiveId, 32_000)).length <= 32_000,
    );
    await assert.rejects(readContextArchive(f.p, run, archiveId, 32_001), {
      code: "CONTEXT_ARCHIVE",
    });
    await writeFile(
      join(f.p.runs, run.id, "context-archives", `${archiveId}.json`),
      "tampered",
    );
    await assert.rejects(readContextArchive(f.p, run, archiveId), {
      code: "CONTEXT_ARCHIVE",
    });
  } finally {
    await f.cleanup();
  }
});

test("automatic request transform sends a smaller context and retains the original archive", async () => {
  const config = configSchema.parse(testConfig());
  config.models.worker!.contextWindow = 2048;
  config.models.worker!.maxOutputTokens = 256;
  const context = providerContext("verbose log ".repeat(5000));
  const runtime = new ScriptedRuntime(async (request) => {
    const transformed = await request.transformContext!(
      context,
      request.signal,
    );
    assert.ok(
      JSON.stringify(transformed).length < JSON.stringify(context).length,
    );
    return "summary";
  });
  const f = await fixture(runtime, config);
  const app = new Application(
    f.config,
    f.p,
    f.store,
    f.root,
    async () => runtime,
  );
  try {
    await app.initialize();
    await app.submit("keep the full conversation");
    await app.waitForIdle();
    const record = app.currentRun()!.compactions![0]!;
    assert.ok(record.afterBytes < record.beforeBytes);
    assert.match(
      await app.readContext(record.archiveId),
      /verbose log verbose log/,
    );
    assert.ok((await app.readContext(record.archiveId, 32_000, 12_000)).length);
  } finally {
    await app.close();
    await f.cleanup();
  }
});

test("tool-free chat exposes read_context only when conversation archives exist", async () => {
  let archiveId: string | undefined;
  const runtime = new ScriptedRuntime(async (request, index) => {
    if (index === 0) {
      assert.equal(request.tools.length, 0);
      return "hello";
    }
    const readContext = request.tools.find(
      (tool) => tool.name === "read_context",
    );
    assert.ok(readContext);
    assert.equal(request.tools.length, 1);
    assert.match(
      await readContext.execute(
        {
          archiveId: archiveId!,
          start: 0,
          bytes: 1000,
        },
        request.signal,
      ),
      /archived greeting history/,
    );
    return "history retrieved";
  });
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
    await app.submit("hello");
    await app.waitForIdle();
    const run = f.store.get(app.currentRun()!.id);
    const archive = await archiveContext(f.p, run, {
      messages: [{ role: "user", content: "archived greeting history" }],
    });
    archiveId = archive.archiveId;
    const state = normalizeConversationContext(app.session.context);
    state.compactions = [
      {
        id: archive.archiveId,
        archiveId: archive.archiveId,
        at: Date.now(),
        beforeBytes: archive.bytes,
        afterBytes: archive.bytes,
        trigger: "manual",
        heuristic: "bytes/3+images*8192",
      },
    ];
    app.session.context = state;
    app.save();
    await app.submit("continue");
    await app.waitForIdle();
    assert.equal(app.currentRun()?.state, "succeeded");
  } finally {
    await app.close();
    await f.cleanup();
  }
});

test("Pi sends compacted tool history on the next provider request", async (t) => {
  const config = configSchema.parse(testConfig());
  config.models.worker!.contextWindow = 4096;
  config.models.worker!.maxOutputTokens = 512;
  const f = await fixture(new ScriptedRuntime(async () => "unused"), config);
  const run = await f.harness.create({
    kind: "chat",
    objective: "inspect the two tool results",
  });
  const payloads: Record<string, unknown>[] = [];
  const oldText = `old-start\n${"old chunk ".repeat(450)}\nold-end`;
  const latestText = `latest-start\n${"latest chunk ".repeat(300)}\nlatest-end`;
  const tool: ToolSpec = {
    name: "read_large",
    description: "Return a fixture result",
    parameters: {
      type: "object",
      properties: { label: { type: "string" } },
      required: ["label"],
      additionalProperties: false,
    },
    async execute(args) {
      return args.label === "old" ? oldText : latestText;
    },
  };
  let archiveId: string | undefined;
  let beforeTransformBytes = 0;
  let afterTransformBytes = 0;
  let requestCount = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      payloads.push(payload);
      if (payloads.length === 1)
        return providerResponse(
          {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "old-call",
                type: "function",
                function: {
                  name: "read_large",
                  arguments: JSON.stringify({ label: "old" }),
                },
              },
              {
                index: 1,
                id: "latest-call",
                type: "function",
                function: {
                  name: "read_large",
                  arguments: JSON.stringify({ label: "latest" }),
                },
              },
            ],
          },
          "tool_calls",
        );
      return providerResponse({ role: "assistant", content: "Done" }, "stop");
    },
  );
  const request: RuntimeRequest = {
    model: "worker",
    role: "worker",
    objective: run.objective,
    system: "Fixture system",
    sessionDir: join(f.p.runs, run.id, "sessions", "context-test"),
    tools: [tool],
    signal: new AbortController().signal,
    onSession() {},
    beforeRequest() {
      requestCount++;
      return `reservation-${requestCount}`;
    },
    afterRequest() {},
    onEvent() {},
    async transformContext(context) {
      beforeTransformBytes = Buffer.byteLength(JSON.stringify(context));
      const compacted = await compactContext(f.p, run, context, {
        config: f.config,
        contextWindow: 4096,
        maxOutputTokens: 512,
        trigger: "automatic",
      });
      if (!compacted) return context;
      archiveId = compacted.record.archiveId;
      afterTransformBytes = Buffer.byteLength(
        JSON.stringify(compacted.context),
      );
      return compacted.context;
    },
  };
  try {
    assert.equal(await new PiRuntime(f.config, f.p).run(request), "Done");
    assert.equal(payloads.length, 2);
    assert.ok(afterTransformBytes < beforeTransformBytes);
    const sentMessages = JSON.stringify(payloads[1]!.messages);
    assert.match(sentMessages, /Older tool result archived/);
    assert.match(sentMessages, /latest-end/);
    assert.ok((sentMessages.match(/old chunk /g) ?? []).length < 100);
    assert.ok(archiveId);
    assert.equal(requestCount, 2);
    const archived = JSON.parse(
      await readContextArchive(f.p, run, archiveId),
    ) as {
      messages: Array<{
        role: string;
        content: string | Array<{ text?: string }>;
      }>;
    };
    const archivedTool = archived.messages.find((message) =>
      ["tool", "toolResult"].includes(message.role),
    );
    const archivedText =
      typeof archivedTool?.content === "string"
        ? archivedTool.content
        : archivedTool?.content.map((part) => part.text ?? "").join("");
    assert.equal(archivedText, oldText);
  } finally {
    await f.cleanup();
  }
});

test("context archive cancellation and unsafe archive roots never return a compacted context", async () => {
  const f = await fixture(new ScriptedRuntime(async () => "unused"));
  try {
    const run = await f.harness.create({
      kind: "chat",
      objective: "explain",
      conversationId: "1c34ab60-4654-4c87-88b5-b08bece01f92",
    });
    const context = providerContext("verbose ".repeat(2000));
    let check = 0;
    const signal = {
      throwIfAborted() {
        if (++check === 2) throw new DOMException("cancelled", "AbortError");
      },
    } as AbortSignal;
    await assert.rejects(
      compactContext(f.p, run, context, {
        config: f.config,
        contextWindow: 2048,
        maxOutputTokens: 256,
        trigger: "automatic",
        signal,
      }),
      { name: "AbortError" },
    );
    assert.equal(context.messages[2]!.content, "verbose ".repeat(2000));
    const external = join(f.root, "external-archives");
    await mkdir(external, { mode: 0o700 });
    const unsafeRun = await f.harness.create({
      kind: "chat",
      objective: "read archive",
      conversationId: "2de080ba-371f-4a21-b9dc-d4c018ff5c2c",
    });
    await mkdir(join(f.p.home, "conversations"), {
      mode: 0o700,
      recursive: true,
    });
    await symlink(
      external,
      join(f.p.home, "conversations", unsafeRun.conversationId!),
    );
    await assert.rejects(
      archiveContext(f.p, unsafeRun, context),
      (error: unknown) =>
        error instanceof AgentError && error.code === "UNSAFE_STORAGE",
    );
  } finally {
    await f.cleanup();
  }
});

test("protected context over budget stops with CONTEXT_LIMIT and byte budget is exact", async () => {
  const f = await fixture(new ScriptedRuntime(async () => "unused"));
  try {
    f.config.limits.maxInputBytes = 5000;
    const budget = contextBudget(f.config, 2048, 256);
    assert.deepEqual(budget, {
      usableBytes: 5000,
      triggerBytes: 4000,
      targetBytes: 3000,
    });
    const run = await f.harness.create({
      kind: "chat",
      objective: "explain",
    });
    const context = providerContext("large tool result ".repeat(1000));
    context.messages[0]!.content = "protected user content ".repeat(200);
    await assert.rejects(
      compactContext(f.p, run, context, {
        config: f.config,
        contextWindow: 2048,
        maxOutputTokens: 256,
        trigger: "automatic",
      }),
      (error: unknown) =>
        error instanceof AgentError && error.code === "CONTEXT_LIMIT",
    );
    assert.match(
      await readFile(
        join(
          f.p.runs,
          run.id,
          "context-archives",
          `${(await archiveContext(f.p, run, context)).archiveId}.json`,
        ),
        "utf8",
      ),
      /protected user content/,
    );
  } finally {
    await f.cleanup();
  }
});

test("legacy conversation JSON without context fields remains readable", async () => {
  const f = await fixture(new ScriptedRuntime(async () => "unused"));
  try {
    const conversations = new Conversations(f.store);
    const session = conversations.create(f.root, {
      dataClass: "private",
      checks: [],
    });
    const legacy = {
      ...session,
      handoff: JSON.stringify({ state: "succeeded", objective: "old handoff" }),
    } as Record<string, unknown>;
    delete legacy.context;
    delete legacy.access;
    f.store.db
      .prepare("UPDATE conversations SET payload=? WHERE id=?")
      .run(JSON.stringify(legacy), session.id);
    const restored = conversations.get(session.id);
    assert.equal(restored.access, "read-only");
    assert.deepEqual(restored.context?.pins, []);
    assert.deepEqual(restored.context?.constraints, []);
    assert.match(restored.handoff!, /old handoff/);
    const normalized = normalizeConversationContext({
      workingState: {
        history: [
          {
            runId: "old-run",
            status: "succeeded",
            checks: [],
            hashes: {},
            artifacts: [],
            results: [{ role: "worker", summary: "untrusted report" }],
          },
        ],
      },
    } as unknown as ConversationContext);
    assert.deepEqual(normalized.workingState.operations, []);
    assert.deepEqual(normalized.workingState.history[0]?.operations, []);
    assert.equal(
      normalized.workingState.history[0]?.results[0]?.author,
      "model",
    );
    assert.equal(
      normalized.workingState.history[0]?.results[0]?.trusted,
      false,
    );
  } finally {
    await f.cleanup();
  }
});
