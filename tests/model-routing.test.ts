import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { matchAutoRule } from "../src/model-routing.js";
import { modelChoices } from "../web/api.js";
import { answer, call, fixture, until } from "./support.js";

const translation = {
  id: randomUUID(),
  condition: "短い翻訳",
  model: "gpt-4.1-mini",
};
const coding = { id: randomUUID(), condition: "コードの修正", model: "faux-1" };
const hidden = {
  id: randomUUID(),
  condition: "除外対象の条件",
  model: "gpt-4.1-nano",
};
const autoModel = {
  connectionId: randomUUID(),
  accountId: "a".repeat(32),
  token: "fixture-workers-token",
  rules: [translation, coding, hidden],
  fallback: "gpt-4.1",
};
const settings = {
  autoModel,
  models: [
    {
      id: autoModel.connectionId,
      provider: "openai",
      key: "fixture-generation-key",
    },
  ],
  defaultModel: autoModel.connectionId,
  mcp: [],
  instructions: "PRIVATE SYSTEM INSTRUCTIONS",
  limits: { modelRequests: 10, runSeconds: 60, commandSeconds: 10 },
};

test("Clef uses the fixed Workers AI endpoint once and only accepts a confident valid rule choice", async (t) => {
  const requests: Request[] = [];
  let choice = {
    type: "choice",
    choice: "rule_1",
    probabilities: { rule_1: 0.96, rule_2: 0.01, none: 0.03 },
    confidence: 0.96,
  };
  let status = 200;
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string | URL, init?: RequestInit) => {
      requests.push(new Request(url, init));
      return Response.json(
        { success: true, result: { answers: { route: choice } } },
        { status },
      );
    },
  );
  const classify = () =>
    matchAutoRule(
      autoModel,
      "猫を英語で何と言う？",
      [translation, coding],
      AbortSignal.timeout(1000),
    );
  assert.equal(await classify(), translation.id);
  assert.equal(
    requests[0]?.url,
    `https://api.cloudflare.com/client/v4/accounts/${autoModel.accountId}/ai/run/@cf/cloudflare/clef-flash`,
  );
  assert.equal(requests[0]?.method, "POST");
  assert.equal(requests[0]?.redirect, "error");
  assert.equal(
    requests[0]?.headers.get("authorization"),
    `Bearer ${autoModel.token}`,
  );
  const body = await requests[0]!.json();
  assert.equal(body.model, "clef-flash");
  assert.equal(body.state, "猫を英語で何と言う？");
  assert.deepEqual(Object.keys(body).sort(), ["model", "questions", "state"]);
  assert.deepEqual(Object.keys(body.questions.route.criteria), [
    "none",
    "rule_1",
    "rule_2",
  ]);
  assert.equal(body.questions.route.criteria.rule_2, coding.condition);
  assert.doesNotMatch(
    JSON.stringify(body),
    /gpt-4|faux-1|fixture-workers-token/,
  );
  choice = {
    ...choice,
    choice: "none",
    probabilities: { rule_1: 0.01, rule_2: 0.01, none: 0.98 },
  };
  assert.equal(await classify(), undefined);
  choice = {
    ...choice,
    choice: "rule_2",
    probabilities: { rule_1: 0.01, rule_2: 0.97, none: 0.02 },
  };
  assert.equal(await classify(), coding.id);
  choice = { ...choice, confidence: 0.7 };
  assert.equal(await classify(), undefined);
  choice = {
    ...choice,
    confidence: 0.99,
    probabilities: { rule_1: 1.5, rule_2: 0.01, none: 0.03 },
  };
  assert.equal(await classify(), undefined);
  status = 429;
  assert.equal(await classify(), undefined);
  assert.equal(
    requests.length,
    6,
    "classification must not retry a rate limit",
  );
});

test("Auto persists as a selection, binds each response, and falls back without changing manual sessions", async () => {
  const seen: string[] = [];
  const f = await fixture([], {
    modelCatalog: async () => [
      autoModel.fallback,
      translation.model,
      coding.model,
    ],
    classifyRoute: async (config, text, rules) => {
      assert.equal(config.token, autoModel.token);
      seen.push(text);
      if (text === "classifier fails") throw new Error("provider error");
      assert.deepEqual(rules, [translation, coding]);
      if (text === "unknown route") return hidden.id;
      return text === "コードを修正して" ? coding.id : translation.id;
    },
  });
  const send = async (
    id: string,
    text: string,
    responses = [answer("done")],
  ) => {
    f.faux.setResponses(responses);
    const receipt = randomUUID();
    await f.service.send(id, receipt, text);
    await until(
      async () => (await f.service.conversation(id)).status === "idle",
    );
    await f.service.send(id, receipt, text);
  };
  try {
    await f.service.saveSettings({ ...settings, revision: 0 });
    const options = await f.service.conversationModelOptions();
    assert.equal(modelChoices(options)[0]?.name, "Auto");
    assert.doesNotMatch(
      JSON.stringify(options),
      /fixture-workers-token|fixture-generation-key/,
    );
    const { id } = await f.service.create(randomUUID(), "auto", "auto", "auto");
    await send(id, "猫を英語で？", [
      call("bash", { command: "echo ok" }),
      answer("cat"),
    ]);
    const view = await f.service.view(id);
    assert.equal(view.conversation.modelConfigId, "auto");
    assert.equal(view.conversation.model, undefined);
    assert.equal(view.conversation.autoResolvedModel?.model, translation.model);
    const answered = view.transcript.find((entry) =>
      entry.messages.some((message) => message.content === "cat"),
    );
    assert.equal(answered?.messages[0]?.model, translation.model);
    assert.equal(view.usage.models.length, 1);
    await send(id, "コードを修正して");
    assert.equal(
      (await f.service.conversation(id)).autoResolvedModel?.model,
      coding.model,
    );
    await send(id, "unknown route");
    assert.equal(
      (await f.service.conversation(id)).autoResolvedModel?.model,
      autoModel.fallback,
    );
    await send(id, "classifier fails");
    assert.equal(
      (await f.service.conversation(id)).autoResolvedModel?.model,
      autoModel.fallback,
    );
    await send(id, `token: ${autoModel.token}`);
    await send(id, "a".repeat(1201));
    await f.service.selectModel(id, autoModel.connectionId, translation.model);
    await send(id, "manual message");
    assert.equal((await f.service.conversation(id)).model, translation.model);
    assert.deepEqual(seen, [
      "猫を英語で？",
      "コードを修正して",
      "unknown route",
      "classifier fails",
    ]);
    const reopened = await f.service.saveSettings({
      ...settings,
      autoModel: { ...autoModel, token: undefined },
      revision: 1,
    });
    assert.equal(reopened.autoModel?.token, autoModel.token);
    await assert.rejects(
      f.service.saveSettings({
        ...settings,
        autoModel: {
          ...autoModel,
          token: undefined,
          accountId: "b".repeat(32),
        },
        revision: 2,
      }),
      /トークン/,
    );
  } finally {
    await f.service.close();
  }
});

test("pending Auto routing does not block another session or use the replaced settings", async () => {
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let release!: (value: string | undefined) => void;
  const result = new Promise<string | undefined>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const f = await fixture([answer("manual")], {
    classifyRoute: async () => {
      calls++;
      enter();
      return result;
    },
  });
  try {
    await f.service.saveSettings({ ...settings, revision: 0 });
    const { id } = await f.service.create(randomUUID(), "auto", "auto", "auto");
    const requestId = randomUUID();
    const pending = f.service.send(id, requestId, "simple");
    await entered;
    const duplicate = f.service.send(id, requestId, "simple");
    const manual = await f.service.create(
      randomUUID(),
      "manual",
      autoModel.connectionId,
      autoModel.fallback,
    );
    await f.service.send(manual.id, randomUUID(), "manual");
    await f.service.saveSettings({ ...settings, autoModel: null, revision: 1 });
    const checked = Promise.all([
      assert.rejects(pending, /判定中/),
      assert.rejects(duplicate, /判定中/),
    ]);
    release(translation.id);
    await checked;
    assert.equal(calls, 1);
    assert.equal((await f.service.view(id)).transcript.length, 0);
  } finally {
    release(undefined);
    await f.service.close();
  }
});
