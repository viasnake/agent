import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { UsageDoc, type UsageState } from "@earendil-works/pi-durable";
import { conversationUsage } from "../src/usage.js";
import { fixture, answer, until } from "./support.js";

test("usage combines model and tool buckets without repricing recorded totals or counting reasoning twice", () => {
  const usage = {
    input: 1000,
    output: 200,
    reasoning: 50,
    cacheRead: 300,
    cacheWrite: 400,
    cacheWrite1h: 100,
    totalTokens: 1900,
    cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 0.125 },
  };
  const result = conversationUsage({
    models: { "provider/model-a": usage, "provider/model-b": usage },
    tools: { nested: usage },
  });
  assert.deepEqual(result.total, {
    input: 3000,
    output: 600,
    cacheRead: 900,
    cacheWrite: 1200,
    totalTokens: 5700,
    cost: 0.375,
  });
  assert.equal(result.models[0]!.cost, 0.125);
  assert.deepEqual(
    result.models.map((row) => row.name),
    ["provider/model-a", "provider/model-b"],
  );
  assert.equal(result.tools[0]!.name, "nested");
  assert.equal(conversationUsage(undefined).total.totalTokens, 0);
});

test("unknown prices propagate to totals without hiding known costs or treating no usage as unknown", () => {
  const usage = {
    input: 10,
    output: 20,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 30,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  for (const bucket of ["models", "tools"] as const) {
    const state: UsageState = {
      models: { priced: { ...usage, cost: { ...usage.cost, total: 0.25 } } },
      tools: {},
    };
    state[bucket].unknown = usage;
    const result = conversationUsage(state);
    assert.equal(
      result[bucket].find((row) => row.name === "unknown")!.cost,
      null,
    );
    assert.equal(
      result.models.find((row) => row.name === "priced")!.cost,
      0.25,
    );
    assert.equal(result.total.cost, null);
    assert.equal(result.total.totalTokens, 60);
  }
  assert.equal(conversationUsage(undefined).total.cost, 0);
  assert.equal(
    conversationUsage({
      models: { empty: { ...usage, input: 0, output: 0, totalTokens: 0 } },
      tools: {},
    }).total.cost,
    0,
  );
  assert.equal(
    conversationUsage({
      models: {
        unknown: { ...usage, cost: { ...usage.cost, totalFromProvider: true } },
      },
      tools: {},
    }).total.cost,
    null,
  );
});

test("session usage is read-only, cumulative beyond history pages, persistent and isolated from fork ancestors", async () => {
  let f = await fixture([answer("First response"), answer("Second response")]);
  try {
    const { id } = await f.service.create(randomUUID(), "Usage");
    const empty = (await f.service.view(id)).usage;
    assert.equal(empty.total.totalTokens, 0);
    assert.deepEqual(empty.models, []);
    assert.equal((await f.service.conversation(id)).workspaceCreated, false);
    assert.equal(f.faux.state.callCount, 0);

    const request = randomUUID();
    await f.service.send(id, request, "First input");
    await until(
      async () => (await f.service.conversation(id)).status === "idle",
    );
    const first = await f.service.view(id);
    assert.ok(first.usage.total.totalTokens > 0);
    assert.ok(first.usage.total.output > 0);
    assert.equal(first.usage.total.cost, null);
    await f.service.send(id, request, "First input");
    assert.deepEqual((await f.service.view(id)).usage, first.usage);

    await f.service.send(id, randomUUID(), "Second input");
    await until(
      async () => (await f.service.conversation(id)).status === "idle",
    );
    const own = (await f.service.view(id)).usage;
    assert.ok(own.total.totalTokens > first.usage.total.totalTokens);
    const pi = await f.service.piConversation(id);
    const stored = (await f.service.harness.snapshot(UsageDoc, pi.id, ctx))!;
    assert.equal(
      own.total.totalTokens,
      stored.models["faux/faux-1"]!.totalTokens,
    );

    // Usage must not depend on the transcript page or require reading all history.
    for (let index = 0; index < 45; index++)
      await pi.submit(
        {
          type: "write",
          entry: {
            kind: "test.history",
            model: [
              { role: "user", content: `Page ${index}`, timestamp: Date.now() },
            ],
          },
        },
        ctx,
      );
    const latest = await f.service.view(id);
    assert.ok(latest.cursor);
    assert.equal(
      latest.transcript.some((entry) =>
        entry.messages.some((message) => message.role === "assistant"),
      ),
      false,
    );
    assert.deepEqual(latest.usage, own);
    assert.deepEqual((await f.service.view(id, latest.cursor)).usage, own);
    assert.equal(f.faux.state.callCount, 2);

    const response = first.transcript.find((entry) =>
      entry.messages.some((message) => message.role === "assistant"),
    )!;
    const branch = await f.service.branch(
      id,
      randomUUID(),
      response.id,
      "fork",
    );
    assert.deepEqual((await f.service.view(branch.id)).usage, empty);
    f.faux.setResponses([answer("Branch response")]);
    await f.service.send(branch.id, randomUUID(), "Branch input");
    await until(
      async () => (await f.service.conversation(branch.id)).status === "idle",
    );
    const branchUsage = (await f.service.view(branch.id)).usage;
    assert.ok(branchUsage.total.totalTokens > 0);
    assert.deepEqual((await f.service.view(id)).usage, own);

    await f.service.close();
    f = await fixture([], { root: f.root });
    assert.deepEqual((await f.service.view(id)).usage, own);
    assert.deepEqual((await f.service.view(branch.id)).usage, branchUsage);
    assert.equal(f.faux.state.callCount, 0);
    await f.service.deleteConversation(id);
    assert.deepEqual((await f.service.view(branch.id)).usage, branchUsage);
    await assert.rejects(f.service.view(id), { statusCode: 404 });
  } finally {
    await f.service.close();
  }
});
