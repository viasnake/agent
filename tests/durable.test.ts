import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  Harness,
  createRegistry,
  defineExtension,
  defineTool,
  defineDoc,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { obj, str } from "@earendil-works/pi-schema";

const State = defineDoc<{ accepted: number[] }>({
  kind: "test.state",
  version: 1,
  scope: "session",
  initial: () => ({ accepted: [] }),
  checkpointWhen: () => true,
});
test("Phase 0: real SQLite, app Document, atomic submit, requestId, tool, watch, reopen", async () => {
  const path = join(
    await mkdtemp(join(tmpdir(), "agent-durable-")),
    "state.sqlite",
  );
  const models = createModels();
  const faux = fauxProvider({ tokensPerSecond: Infinity });
  models.setProvider(faux.provider);
  const registry = createRegistry();
  let executions = 0;
  registry.install(
    defineExtension({
      name: "test",
      tools: [
        defineTool({
          name: "echo",
          description: "echo",
          parameters: obj({ text: str() }),
          execute: async (args) => {
            executions++;
            return { output: [{ type: "text", text: args.text }] };
          },
        }),
      ],
    }),
  );
  let harness = await Harness.open(
    await openNodeSqliteStorage(path),
    { models, registry },
    ctx,
  );
  const conversation = await harness.createConversation(
    {
      ownership: { kind: "ownerless" },
      agent: { model: { provider: "faux", modelId: "faux-1" } },
    },
    ctx,
  );
  const watch = await conversation.watch(ctx, { min: 2, max: 4 });
  let changes = 0;
  watch.start(async () => {
    changes++;
  });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("echo", { text: "result" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("done"),
  ]);
  const id = await harness.commit(async (tx) => {
    const id = await conversation.submit(tx, {
      type: "input",
      content: "work",
      requestId: "one",
    });
    (await tx.doc(State)).accepted.push(id);
    return id;
  }, ctx);
  await conversation.waitForIdle(ctx);
  assert.equal((await harness.submission(id, ctx))!.id, id);
  assert.equal(
    (
      await conversation.submit(
        { type: "input", content: "work", requestId: "one" },
        ctx,
      )
    ).id,
    id,
  );
  assert.equal(executions, 1);
  assert.ok(changes > 0);
  await watch.stop();
  await harness.close(ctx);
  harness = await Harness.open(
    await openNodeSqliteStorage(path),
    { models, registry },
    ctx,
  );
  assert.deepEqual((await harness.snapshot(State, ctx))?.accepted, [id]);
  const reopened = await harness.conversation(conversation.id, ctx);
  assert.ok(reopened);
  assert.equal(
    (
      await reopened.submit(
        { type: "input", content: "work", requestId: "one" },
        ctx,
      )
    ).id,
    id,
  );
  await harness.close(ctx);
});

test("Phase 0: abort waits for tools; continue uses the published submit API", async () => {
  const models = createModels(),
    faux = fauxProvider({ tokensPerSecond: Infinity });
  models.setProvider(faux.provider);
  const registry = createRegistry();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let stopped = false;
  registry.install(
    defineExtension({
      name: "test",
      tools: [
        defineTool({
          name: "wait",
          description: "wait",
          parameters: obj({}),
          execute: async (_args, _api, context) => {
            started();
            await new Promise<void>((resolve) => {
              context.abortSignal!.addEventListener(
                "abort",
                () => {
                  stopped = true;
                  resolve();
                },
                { once: true },
              );
            });
            return { output: [{ type: "text", text: "stopped" }] };
          },
        }),
      ],
    }),
  );
  const path = join(
    await mkdtemp(join(tmpdir(), "agent-abort-")),
    "state.sqlite",
  );
  const harness = await Harness.open(
    await openNodeSqliteStorage(path),
    { models, registry },
    ctx,
  );
  const conversation = await harness.root(ctx, {
    agent: { model: { provider: "faux", modelId: "faux-1" } },
  });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
  ]);
  await conversation.submit(
    { type: "input", content: "wait", requestId: "first" },
    ctx,
  );
  await ready;
  await conversation.abort(ctx);
  assert.equal(stopped, true);
  faux.setResponses([fauxAssistantMessage("continued")]);
  const result = await conversation.submit(
    { type: "continue", requestId: "second" },
    ctx,
  );
  assert.equal((await result.wait(ctx)).status, "done");
  await harness.close(ctx);
});
