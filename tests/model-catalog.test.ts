import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture } from "./support.js";
import { settingsInput } from "../src/settings.js";
import { modelChoices } from "../web/api.js";

test("conversation models are account-specific, cached, secret-free and never require inference", async (t) => {
  const f = await fixture([], { modelCatalog: undefined });
  const oauth = randomUUID(),
    api = randomUUID(),
    missing = randomUUID();
  const calls: string[] = [];
  let failed = false;
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      assert.equal(request.url, "https://api.openai.com/v1/models");
      assert.equal(request.method, "GET");
      assert.equal(request.redirect, "error");
      const key = request.headers.get("authorization")!;
      calls.push(key);
      if (key === "Bearer fixture-oauth-access") {
        if (failed)
          return Response.json(
            { secret: "fixture-oauth-access" },
            { status: 403 },
          );
        return Response.json({
          models: [
            { slug: "gpt-6.1-sol", visibility: "list" },
            { slug: "gpt-6.1-sol", visibility: "list" },
            { slug: "gpt-4.1", visibility: "hidden" },
            { slug: "unimplemented-model", visibility: "list" },
          ],
        });
      }
      assert.equal(key, "Bearer sk-fixture-api-key");
      return Response.json({
        data: [{ id: "gpt-4.1-mini" }, { id: "non-chat-model" }],
      });
    },
  );
  const edit = () => {
    const { schemaVersion: _, pending: __, ...value } = f.service.management();
    return settingsInput.parse({
      ...value,
      models: value.models.map(
        ({ hasKey: _, authorized: __, status: ___, ...m }) => m,
      ),
    });
  };
  try {
    const input = edit();
    input.models = [
      {
        id: oauth,
        name: "ChatGPT",
        provider: "openai",
        auth: "oauth",
        model: "gpt-4.1",
      },
      {
        id: api,
        name: "API",
        provider: "openai",
        auth: "api_key",
        key: "sk-fixture-api-key",
      },
      {
        id: missing,
        name: "Unconfigured",
        provider: "openai",
        auth: "api_key",
      },
    ];
    await f.service.saveSettings(input);
    const model = f.service.settings
      .snapshot()
      .models.find((m) => m.id === oauth)!;
    await f.service.settings.setModelOAuth(oauth, model.authVersion, {
      type: "oauth",
      access: "fixture-oauth-access",
      refresh: "fixture-oauth-refresh",
      expires: Date.now() + 3600000,
      clientId: "oaiapp_fixture",
      scopes: ["chatgpt.tokens.use.direct"],
    });
    const [first, second] = await Promise.all([
      f.service.conversationModelOptions(),
      f.service.conversationModelOptions(),
    ]);
    assert.deepEqual(first, second);
    assert.equal(
      calls.length,
      2,
      "concurrent reads share one request per connection",
    );
    assert.deepEqual(
      modelChoices(first).map((m) => [m.group, m.model]),
      [
        ["ChatGPT", "gpt-6.1-sol"],
        ["API", "gpt-4.1-mini"],
      ],
    );
    assert.ok(!JSON.stringify(first).includes("fixture-oauth"));
    assert.ok(!JSON.stringify(first).includes("sk-fixture"));
    await f.service.conversationModelOptions();
    assert.equal(calls.length, 2);
    // A saved legacy selection must not reintroduce a hidden model into the picker.
    const conversation = await f.service.create(
      randomUUID(),
      "retained",
      oauth,
      "gpt-4.1",
    );
    failed = true;
    await f.service.saveSettings(edit());
    const failedOptions = await f.service.conversationModelOptions();
    assert.equal(failedOptions.models[0]!.error, "接続失敗（HTTP 403）");
    assert.deepEqual(
      modelChoices(failedOptions).map((m) => m.model),
      ["gpt-4.1-mini"],
    );
    assert.equal(
      (await f.service.conversation(conversation.id)).model,
      "gpt-4.1",
      "listing never silently changes stored selections",
    );
    const removed = edit();
    removed.models = removed.models.filter((m) => m.id !== oauth);
    await f.service.saveSettings(removed);
    const after = await f.service.conversationModelOptions();
    assert.equal(
      after.models.some((m) => m.id === oauth),
      false,
    );
  } finally {
    await f.service.close();
  }
});

test("catalog results from a replaced credential are discarded", async () => {
  let release!: (ids: string[]) => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const f = await fixture([], {
    modelCatalog: () => {
      started();
      return new Promise<string[]>((resolve) => {
        release = resolve;
      });
    },
  });
  try {
    const {
      schemaVersion: _,
      pending: __,
      ...initial
    } = f.service.management();
    const input = settingsInput.parse({
      ...initial,
      models: [
        {
          id: randomUUID(),
          provider: "openai",
          key: "sk-fixture-old",
          auth: "api_key",
        },
      ],
    });
    await f.service.saveSettings(input);
    const pending = f.service.conversationModelOptions();
    await ready;
    input.revision++;
    input.models[0]!.key = "sk-fixture-new";
    await f.service.saveSettings(input);
    release(["gpt-4.1"]);
    await assert.rejects(pending, /接続が変更/);
  } finally {
    await f.service.close();
  }
});
