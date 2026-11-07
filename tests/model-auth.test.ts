import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer as httpServer } from "node:http";
import { readFile, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { createServer } from "../src/server.js";
import { settingsInput } from "../src/settings.js";
import { fixture, until, answer } from "./support.js";
import type { ModelLogin } from "../src/model-auth.js";

function edit(f: Awaited<ReturnType<typeof fixture>>) {
  const { schemaVersion: _, pending: __, ...value } = f.service.management();
  return settingsInput.parse({
    ...value,
    models: value.models.map(
      ({ hasKey: _, authorized: __, status: ___, ...m }) => m,
    ),
    mcp: [],
  });
}

test("OpenAI SDK OAuth: browser ownership, PKCE, refresh, restart, disconnect and stale login protection", async () => {
  let exchanges = 0,
    refreshes = 0,
    challenge = "",
    issued = 0;
  const tokenServer = httpServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const form = new URLSearchParams(body);
    assert.equal(form.get("client_id"), "oaiapp_fixture");
    assert.equal(form.get("resource"), "https://api.openai.com/v1");
    if (form.get("grant_type") === "authorization_code") {
      assert.equal(form.get("code"), "fixture-code");
      assert.equal(
        form.get("redirect_uri"),
        "http://127.0.0.1:1455/auth/callback",
      );
      assert.equal(
        createHash("sha256")
          .update(form.get("code_verifier")!)
          .digest("base64url"),
        challenge,
      );
      exchanges++;
    } else {
      assert.equal(form.get("grant_type"), "refresh_token");
      assert.match(form.get("refresh_token")!, /^fixture-refresh-/);
      refreshes++;
    }
    issued++;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        access_token: `fixture-access-${issued}`,
        refresh_token: `fixture-refresh-${issued}`,
        id_token: "fixture-id-token",
        token_type: "Bearer",
        scope: "openid offline_access chatgpt.tokens.use.direct",
        // Initial credentials deliberately need refresh before the first request.
        expires_in: form.get("grant_type") === "authorization_code" ? 60 : 3600,
      }),
    );
  });
  await new Promise<void>((resolve) =>
    tokenServer.listen(0, "127.0.0.1", resolve),
  );
  const address = tokenServer.address();
  assert.ok(address && typeof address !== "string");
  const originalFetch = globalThis.fetch;
  // Test-process-only transport substitution: exercise real SDK code exchange and
  // refresh over HTTP without contacting an account or invoking a paid model.
  globalThis.fetch = async (url, init) => {
    assert.equal(
      String(url),
      "https://auth.openai.com/api/accounts/oauth/token",
    );
    return originalFetch(`http://127.0.0.1:${address.port}/token`, init);
  };
  let f = await fixture([answer("history survives")]);
  const app = await createServer(f.service);
  const base = { host: "127.0.0.1:8080", origin: "http://127.0.0.1:8080" };
  async function session() {
    const response = await app.inject({ url: "/api/session", headers: base });
    return {
      ...base,
      cookie: response.headers["set-cookie"]!.toString().split(";")[0]!,
      "x-csrf-token": response.json().csrf,
    };
  }
  const headers = await session(),
    stranger = await session();
  async function request(url: string, payload: Record<string, unknown> = {}) {
    return app.inject({ method: "POST", url, payload, headers });
  }
  const modelId = randomUUID();
  const loginUrl = `/api/settings/models/${modelId}/oauth`;
  async function start() {
    const response = await request(loginUrl);
    assert.equal(response.statusCode, 200, response.body);
    const login = response.json<ModelLogin>();
    assert.equal(login.state, "waiting");
    const url = new URL(login.url!);
    assert.equal(url.origin, "https://auth.openai.com");
    assert.equal(url.searchParams.get("agent_name_hint"), "viasnake/agent");
    assert.equal(
      url.searchParams.get("ext_agent_host_id"),
      `urn:uuid:${f.service.settings.snapshot().hostId}`,
    );
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    challenge = url.searchParams.get("code_challenge")!;
    return { login, url };
  }
  function callback(url: URL, state = url.searchParams.get("state")!) {
    const cb = new URL(url.searchParams.get("redirect_uri")!);
    cb.search = new URLSearchParams({
      code: "fixture-code",
      client_id: "oaiapp_fixture",
      state,
    }).toString();
    return cb.href;
  }
  async function waitLogin(id: string) {
    await until(async () =>
      ["complete", "error"].includes(
        f.service.modelAuth.status(id, headers.cookie.split("=")[1]!).state,
      ),
    );
    return (
      await app.inject({ url: `/api/settings/model-login/${id}`, headers })
    ).json<ModelLogin>();
  }
  try {
    const { id } = await f.service.create(randomUUID(), "Persistent history");
    await f.service.send(id, randomUUID(), "hello");
    await until(
      async () => (await f.service.conversation(id)).status === "idle",
    );
    const input = edit(f);
    input.models = [
      { id: modelId, provider: "openai", model: "gpt-4.1", auth: "oauth" },
    ];
    input.defaultModel = modelId;
    await f.service.saveSettings(input);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: loginUrl,
          payload: {},
          headers: { ...headers, "x-csrf-token": "bad" },
        })
      ).statusCode,
      403,
    );
    const first = await start();
    assert.equal((await request(loginUrl)).statusCode, 409);
    assert.equal(
      (
        await app.inject({
          url: `/api/settings/model-login/${first.login.id}`,
          headers: stranger,
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/api/settings/model-login/${first.login.id}`,
          headers: stranger,
          payload: { url: callback(first.url) },
        })
      ).statusCode,
      404,
    );
    await request(`/api/settings/model-login/${first.login.id}`, {
      url: callback(first.url, "wrong-state"),
    });
    assert.equal((await waitLogin(first.login.id)).state, "error");
    assert.equal(exchanges, 0);
    const valid = await start();
    await request(`/api/settings/model-login/${valid.login.id}`, {
      url: callback(valid.url),
    });
    assert.equal((await waitLogin(valid.login.id)).state, "complete");
    assert.equal(exchanges, 1);
    assert.equal(
      (
        await request(`/api/settings/model-login/${valid.login.id}`, {
          url: callback(valid.url),
        })
      ).statusCode,
      409,
    );
    const model = f.service.settings.snapshot().models[0]!;
    const models = createModels({
      credentials: f.service.settings.credentials(model),
    });
    models.setProvider(openaiProvider());
    const [a, b] = await Promise.all([
      models.getAuth("openai"),
      models.getAuth("openai"),
    ]);
    assert.equal(refreshes, 1);
    assert.equal(a?.auth.apiKey, "fixture-access-2");
    assert.deepEqual(a, b);
    const projection = JSON.stringify(f.service.management());
    for (const secret of [
      "fixture-access-1",
      "fixture-access-2",
      "fixture-refresh-1",
      "fixture-refresh-2",
    ])
      assert.ok(!projection.includes(secret));
    assert.equal(
      f.service.redact("fixture-access-1 fixture-access-2 fixture-refresh-2"),
      "[REDACTED] [REDACTED] [REDACTED]",
    );
    const path = join(f.root, "control/settings-v1.json");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.match(await readFile(path, "utf8"), /fixture-refresh-2/);
    assert.match(JSON.stringify(await f.service.view(id)), /history survives/);
    assert.ok(!JSON.stringify(await f.service.view(id)).includes("fixture-"));

    // A completed older authorization cannot restore a disconnected model.
    const stale = await start();
    await f.service.settings.setModelOAuth(
      modelId,
      f.service.settings.snapshot().models[0]!.authVersion,
    );
    await request(`/api/settings/model-login/${stale.login.id}`, {
      url: callback(stale.url),
    });
    assert.equal((await waitLogin(stale.login.id)).state, "error");
    assert.equal(f.service.management().models[0]!.authorized, false);
    const again = await start();
    const callbackResponse = await originalFetch(callback(again.url));
    assert.equal(callbackResponse.status, 200);
    await callbackResponse.text();
    assert.equal((await waitLogin(again.login.id)).state, "complete");
    const hostId = f.service.settings.snapshot().hostId;
    const root = f.root;
    await app.close();
    await f.service.close();
    f = await fixture([], { root });
    assert.equal(f.service.settings.snapshot().hostId, hostId);
    assert.equal(f.service.management().models[0]!.authorized, true);
    assert.match(JSON.stringify(await f.service.view(id)), /history survives/);
    const old = f.service.settings.credentials(
      f.service.settings.snapshot().models[0]!,
    );
    await f.service.modelAuth.disconnect(modelId);
    assert.equal(f.service.modelAuth.current("owner"), null);
    await assert.rejects(
      old.modify("openai", async () => ({
        type: "oauth",
        access: "stale",
        refresh: "stale",
        expires: Date.now() + 3600000,
      })),
    );
    assert.equal(f.service.management().models[0]!.authorized, false);
    assert.ok(!(await readFile(path, "utf8")).includes("fixture-refresh"));
    const cancelled = await f.service.modelAuth.begin(modelId, "owner");
    assert.equal(
      (await f.service.modelAuth.cancel(cancelled.id, "owner")).state,
      "error",
    );
  } finally {
    await app.close();
    await f.service.close();
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve) => tokenServer.close(() => resolve()));
    await rm(f.root, { recursive: true, force: true });
  }
});
