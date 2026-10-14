import test from "node:test";
import assert from "node:assert/strict";
import { Router } from "../src/routing.js";
import { fixture, ScriptedRuntime, completed, testConfig } from "./helpers.js";

test("Clef shadow and assisted routing stay within eligible profiles and record reservations", async (t) => {
  const config = testConfig();
  config.models.alternative = {
    ...config.models.worker!,
    id: "alternative-fixture",
    priority: -1,
  };
  config.connections.clef = {
    type: "clef",
    enabled: true,
    account: "test-classifier",
    billing: "api",
    allowedData: ["private"],
    secretEnv: "AGENT_TEST_CLEF_KEY",
    accountEnv: "AGENT_TEST_CLEF_ACCOUNT",
    requestsPerMinute: 100,
    maxRequestUsd: 0.01,
  };
  config.limits.maxApiUsd = 1;
  config.routing = { mode: "shadow", classifier: "clef" };
  const oldKey = process.env.AGENT_TEST_CLEF_KEY,
    oldAccount = process.env.AGENT_TEST_CLEF_ACCOUNT;
  process.env.AGENT_TEST_CLEF_KEY = "fixture-only";
  process.env.AGENT_TEST_CLEF_ACCOUNT = "a".repeat(32);
  let calls = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      calls++;
      assert.equal(
        String(input),
        `https://api.cloudflare.com/client/v4/accounts/${"a".repeat(32)}/ai/run/@cf/cloudflare/clef-flash`,
      );
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(Object.keys(body.questions.selection.criteria), [
        "candidate_0",
        "candidate_1",
      ]);
      return Response.json({
        result: {
          answers: {
            selection: {
              choice: "candidate_1",
              probabilities: { candidate_0: 0.1, candidate_1: 0.9 },
            },
          },
        },
      });
    },
  );
  const f = await fixture(new ScriptedRuntime(async () => completed()), config);
  try {
    const created = await f.harness.create({
        kind: "writing",
        objective: "routing contract",
      }),
      run = f.store.claim(created.id),
      router = new Router(config, f.store),
      signal = new AbortController().signal;
    assert.equal(await router.select(run, "worker", true, signal), "worker");
    config.routing.mode = "assisted";
    assert.equal(
      await router.select(run, "worker", true, signal),
      "alternative",
    );
    run.localOnly = true;
    assert.equal(await router.select(run, "worker", true, signal), "worker");
    assert.equal(calls, 2);
    assert.equal(f.store.usage(run.id).requests, 2);
    assert.equal(f.store.usage(run.id).heldUsd, 0.02);
    assert.equal(
      f.store.events(run.id).filter((e) => e.type === "classifier_result")
        .length,
      2,
    );
    f.store.release(run);
  } finally {
    await f.cleanup();
    if (oldKey === undefined) delete process.env.AGENT_TEST_CLEF_KEY;
    else process.env.AGENT_TEST_CLEF_KEY = oldKey;
    if (oldAccount === undefined) delete process.env.AGENT_TEST_CLEF_ACCOUNT;
    else process.env.AGENT_TEST_CLEF_ACCOUNT = oldAccount;
  }
});
