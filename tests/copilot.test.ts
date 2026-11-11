import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";
import { fixture, until } from "./support.js";
import { settingsInput } from "../src/settings.js";
import { modelChoices } from "../web/api.js";
import { createServer } from "../src/server.js";

const chatModels = githubCopilotProvider()
  .getModels()
  .filter((m) => m.api === "openai-completions");
const first = chatModels[0]!.id;
const second = chatModels[1]!.id;
function edit(f: Awaited<ReturnType<typeof fixture>>) {
  const { schemaVersion: _, pending: __, ...value } = f.service.management();
  return settingsInput.parse({
    ...value,
    models: value.models.map(
      ({ hasKey: _, authorized: __, status: ___, ...m }) => m,
    ),
  });
}
async function configure(f: Awaited<ReturnType<typeof fixture>>) {
  const input = edit(f);
  const id = randomUUID();
  input.models = [{ id, provider: "github-copilot", auth: "oauth" }];
  await f.service.saveSettings(input);
  return id;
}

test("Copilot SDK device login, account models, rotation, restart and ordinary tool execution", async (t) => {
  let f = await fixture([], { noModel: true, modelCatalog: undefined });
  let tokens = 0,
    catalogs = 0,
    polls = 0;
  let tool = true;
  let permissions = [first, second];
  let failCatalog = false;
  const dispatched: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.url === "https://github.com/login/device/code") {
        assert.equal(request.method, "POST");
        return Response.json({
          device_code: "private-device-secret",
          user_code: "ABCD-EFGH",
          verification_uri: "https://github.com/login/device",
          interval: 1,
          expires_in: 60,
        });
      }
      if (request.url === "https://github.com/login/oauth/access_token") {
        const body = new URLSearchParams(await request.text());
        assert.equal(body.get("device_code"), "private-device-secret");
        assert.equal(
          body.get("grant_type"),
          "urn:ietf:params:oauth:grant-type:device_code",
        );
        polls++;
        return Response.json({ access_token: "private-github-secret" });
      }
      if (request.url === "https://api.github.com/copilot_internal/v2/token") {
        assert.equal(
          request.headers.get("authorization"),
          "Bearer private-github-secret",
        );
        tokens++;
        return Response.json({
          token: `private-copilot-secret-${tokens}`,
          expires_at: Date.now() / 1000 + (tokens === 1 ? 60 : 3600),
        });
      }
      if (request.url === "https://api.individual.githubcopilot.com/models") {
        catalogs++;
        if (failCatalog)
          return Response.json(
            { error: "private-copilot-secret" },
            { status: 403 },
          );
        return Response.json({
          data: [
            ...permissions.map((id) => ({
              id,
              model_picker_enabled: true,
              policy: { state: "enabled" },
              capabilities: { supports: { tool_calls: true } },
            })),
            {
              id: chatModels[2]!.id,
              model_picker_enabled: true,
              policy: { state: "disabled" },
            },
            { id: "unknown-model", model_picker_enabled: true },
          ],
        });
      }
      assert.equal(
        request.url,
        "https://api.individual.githubcopilot.com/chat/completions",
      );
      assert.equal(
        request.headers.get("authorization"),
        `Bearer private-copilot-secret-${tokens}`,
      );
      const body = (await request.json()) as {
        model: string;
        stream: boolean;
        messages: { role: string }[];
      };
      assert.equal(body.stream, true);
      dispatched.push(body.model);
      const delta = tool
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call_fixture",
                type: "function",
                function: {
                  name: "write",
                  arguments: JSON.stringify({
                    path: "outputs/copilot.txt",
                    content: "copilot tool output",
                  }),
                },
              },
            ],
          }
        : { role: "assistant", content: "Copilot fixture OK" };
      if (!tool && dispatched.length === 2)
        assert.ok(body.messages.some((m) => m.role === "tool"));
      const chunks = [
        { choices: [{ index: 0, delta, finish_reason: null }] },
        {
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: tool ? "tool_calls" : "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        },
      ];
      tool = false;
      return new Response(
        chunks
          .map(
            (chunk) =>
              `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: body.model, ...chunk })}\n\n`,
          )
          .join("") + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  );
  const root = f.root;
  try {
    const id = await configure(f);
    const app = await createServer(f.service);
    const session = await app.inject({
      method: "GET",
      url: "/api/session",
      headers: { host: "127.0.0.1:8080" },
    });
    const cookie = session.cookies
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
    const headers = {
      host: "127.0.0.1:8080",
      origin: "http://127.0.0.1:8080",
      cookie,
      "x-csrf-token": session.json().csrf,
    };
    const response = await app.inject({
      method: "POST",
      url: `/api/settings/models/${id}/oauth`,
      headers,
      payload: {},
    });
    assert.equal(response.statusCode, 200, response.body);
    const login = response.json();
    assert.equal(login.userCode, "ABCD-EFGH");
    assert.equal(login.url, "https://github.com/login/device");
    assert.ok(!response.body.includes("private-"));
    assert.equal(f.service.modelAuth.current("different-browser"), null);
    assert.throws(
      () =>
        f.service.modelAuth.submit(
          login.id,
          session.cookies.find((c) => c.name === "agent_session")!.value,
          "callback",
        ),
      /送信できません/,
    );
    await until(async () => f.service.management().models[0]!.authorized);
    const status = await app.inject({
      method: "GET",
      url: `/api/settings/model-login/${login.id}`,
      headers,
    });
    assert.equal(status.json().state, "complete");
    assert.equal(status.json().userCode, undefined);
    assert.ok(!status.body.includes("private-"));
    await app.close();
    assert.equal(polls, 1);
    assert.equal(tokens, 1);
    // Expired access token is refreshed by Pi before the account-filtered list is read.
    const options = await f.service.conversationModelOptions();
    assert.equal(tokens, 2);
    assert.deepEqual(
      modelChoices(options).map((m) => m.model),
      [first, second],
    );
    assert.equal(options.models[0]!.name, "GitHub Copilot");
    await f.service.conversationModelOptions();
    const catalogReads = catalogs;
    await f.service.conversationModelOptions();
    assert.equal(catalogs, catalogReads);
    assert.equal(dispatched.length, 0);
    const saved = join(root, "control/settings-v1.json");
    assert.equal((await stat(saved)).mode & 0o777, 0o600);
    assert.match(await readFile(saved, "utf8"), /private-copilot-secret-2/);
    await f.service.close();
    f = await fixture([], { root, noModel: true, modelCatalog: undefined });
    assert.deepEqual(
      modelChoices(await f.service.conversationModelOptions()).map(
        (m) => m.model,
      ),
      [first, second],
    );
    const conversation = await f.service.create(
      randomUUID(),
      "Copilot",
      id,
      first,
    );
    await f.service.send(conversation.id, randomUUID(), "Write a file");
    await until(
      async () =>
        (await f.service.conversation(conversation.id)).status !== "running",
    );
    assert.equal(
      (await f.service.conversation(conversation.id)).status,
      "idle",
    );
    assert.equal(
      await readFile(
        join(
          root,
          "work/conversations",
          conversation.id,
          "outputs/copilot.txt",
        ),
        "utf8",
      ),
      "copilot tool output",
    );
    await f.service.selectModel(conversation.id, id, second);
    await f.service.send(conversation.id, randomUUID(), "Continue");
    await until(
      async () =>
        (await f.service.conversation(conversation.id)).status !== "running",
    );
    assert.deepEqual(dispatched, [first, first, second]);
    const view = await f.service.view(conversation.id);
    assert.match(JSON.stringify(view.transcript), /Copilot fixture OK/);
    assert.ok(
      !JSON.stringify([view, options, f.service.management()]).includes(
        "private-",
      ),
    );
    // The connection test must pick an allowed model, not the first bundled model.
    let config = f.service.settings.snapshot().models[0]!;
    await f.service.settings.setModelOAuth(id, config.authVersion, {
      ...config.oauth!,
      availableModelIds: [second],
    });
    assert.equal((await f.service.testModel(id)).models[0]!.status, "接続成功");
    assert.equal(dispatched.at(-1), second);
    assert.equal(dispatched.length, 4);
    // Revocation becomes effective at the next token refresh, including execution admission.
    config = f.service.settings.snapshot().models[0]!;
    permissions = [];
    await f.service.settings.setModelOAuth(id, config.authVersion, {
      ...config.oauth!,
      expires: 0,
    });
    const empty = await f.service.conversationModelOptions();
    assert.deepEqual(empty.models[0]!.catalog, []);
    assert.equal(empty.models[0]!.error, "利用できるモデルがありません");
    await assert.rejects(
      f.service.send(conversation.id, randomUUID(), "Denied"),
      /利用できないモデル/,
    );
    config = f.service.settings.snapshot().models[0]!;
    failCatalog = true;
    await f.service.settings.setModelOAuth(id, config.authVersion, {
      ...config.oauth!,
      expires: 0,
    });
    const failed = await f.service.conversationModelOptions();
    assert.deepEqual(failed.models[0]!.catalog, []);
    assert.ok(failed.models[0]!.error);
    assert.ok(!JSON.stringify(failed).includes("private-"));
    // Missing Pi metadata must never fall back to all bundled models.
    config = f.service.settings.snapshot().models[0]!;
    const { availableModelIds: _, ...credential } = config.oauth!;
    await f.service.settings.setModelOAuth(id, config.authVersion, {
      ...credential,
      expires: Date.now() + 3600000,
    });
    const missing = await f.service.conversationModelOptions();
    assert.deepEqual(missing.models[0]!.catalog, []);
    assert.match(missing.models[0]!.error!, /再認証/);
    await f.service.modelAuth.disconnect(id);
    assert.deepEqual(
      (await f.service.conversationModelOptions()).models[0]!.catalog,
      [],
    );
    await assert.rejects(
      f.service.send(conversation.id, randomUUID(), "Disconnected"),
      /認証を完了/,
    );
    assert.equal(dispatched.length, 4);
  } finally {
    await f.service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Copilot device failures, cancellation, expiry, stale login and provider changes", async (t) => {
  const f = await fixture([], { noModel: true, modelCatalog: undefined });
  let mode: "pending" | "denied" | "expired" | "success" | "bad-url" =
    "pending";
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/login/device/code"))
      return Response.json({
        device_code: "private-device-secret",
        user_code: "ABCD-EFGH",
        verification_uri:
          mode === "bad-url"
            ? "https://example.com/login"
            : "https://github.com/login/device",
        interval: 1,
        expires_in: mode === "expired" ? 0 : 60,
      });
    if (url.endsWith("/login/oauth/access_token"))
      return Response.json(
        mode === "success"
          ? { access_token: "private-github-secret" }
          : {
              error:
                mode === "denied" ? "access_denied" : "authorization_pending",
              error_description: "private-upstream-secret",
            },
      );
    if (url.endsWith("/copilot_internal/v2/token"))
      return Response.json({
        token: "private-copilot-secret",
        expires_at: Date.now() / 1000 + 3600,
      });
    if (url.endsWith("/models")) return Response.json({ data: [] });
    throw new Error(`Unexpected URL ${url}`);
  });
  try {
    const id = await configure(f);
    for (const next of ["pending", "denied", "expired", "bad-url"] as const) {
      mode = next;
      const login = await f.service.modelAuth.begin(id, "owner");
      if (next === "pending") {
        await assert.rejects(f.service.modelAuth.begin(id, "owner"), /進行中/);
        assert.throws(
          () => f.service.modelAuth.status(login.id, "other"),
          /ブラウザー/,
        );
        await f.service.modelAuth.cancel(login.id, "owner");
      }
      await until(
        async () =>
          f.service.modelAuth.status(login.id, "owner").state === "error",
      );
      const status = f.service.modelAuth.status(login.id, "owner");
      if (next === "expired") assert.match(status.message, /有効期限/);
      assert.equal(status.userCode, undefined);
      assert.ok(!JSON.stringify(status).includes("private-"));
      assert.equal(f.service.management().models[0]!.authorized, false);
    }
    mode = "success";
    const login = await f.service.modelAuth.begin(id, "owner");
    const changed = edit(f);
    changed.models[0]!.provider = "openai";
    await f.service.saveSettings(changed);
    await until(
      async () =>
        f.service.modelAuth.status(login.id, "owner").state === "error",
    );
    assert.equal(f.service.management().models[0]!.authorized, false);
    const openai = f.service.settings.snapshot().models[0]!;
    await f.service.settings.setModelOAuth(id, openai.authVersion, {
      type: "oauth",
      access: "openai-secret",
      refresh: "refresh-secret",
      expires: Date.now() + 3600000,
    });
    const back = edit(f);
    back.models[0]!.provider = "github-copilot";
    await f.service.saveSettings(back);
    assert.equal(f.service.management().models[0]!.authorized, false);
    const reauth = await f.service.modelAuth.begin(id, "owner");
    await until(
      async () =>
        f.service.modelAuth.status(reauth.id, "owner").state === "complete",
    );
    assert.equal(f.service.management().models[0]!.authorized, true);
  } finally {
    await f.service.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("Copilot test failures classify SDK errors without leaking provider responses or retrying", async (t) => {
  const f = await fixture([], { noModel: true, modelCatalog: undefined });
  let status = 400;
  let code = "model_not_supported";
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    return Response.json(
      {
        error: {
          code,
          type: "invalid_request_error",
          message: "private-copilot-secret private-request-content",
          param: "model",
        },
      },
      { status },
    );
  });
  try {
    const id = await configure(f);
    for (const modelId of ["claude-haiku-4.5", "gpt-5.6-luna"]) {
      const model = f.service.settings.snapshot().models[0]!;
      await f.service.settings.setModelOAuth(id, model.authVersion, {
        type: "oauth",
        access: "private-copilot-secret",
        refresh: "private-refresh-secret",
        expires: Date.now() + 3600000,
        availableModelIds: [modelId],
      });
      for (const failure of [
        {
          status: 400,
          code: "model_not_supported",
          expected: "モデルを利用できません",
        },
        { status: 403, code: "forbidden", expected: "接続失敗（HTTP 403）" },
      ]) {
        status = failure.status;
        code = failure.code;
        const before = requests;
        const result = await f.service.testModel(id);
        assert.equal(result.models[0]!.status, failure.expected);
        assert.equal(requests, before + 1, "never retry a rejected inference");
        assert.ok(!JSON.stringify(result).includes("private-"));
      }
    }
  } finally {
    await f.service.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
