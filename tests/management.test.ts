import {
  fauxAssistantMessage,
  fauxToolCall,
  getCurrentTools,
} from "@earendil-works/pi-ai";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, stat, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { fixture, call, answer, until, TestRunner } from "./support.js";
import { createServer } from "../src/server.js";
import { connectionIdentity, settingsInput } from "../src/settings.js";
import { mcpToolName } from "../src/tools.js";
import { remoteFixture } from "./remote-fixture.js";
import {
  remoteFetch,
  allowedAddress,
  remoteUrl,
  resolveRemote,
} from "../src/remote-http.js";
function input(service: Awaited<ReturnType<typeof fixture>>["service"]) {
  const {
    schemaVersion: _,
    hostId: __,
    ...value
  } = service.settings.snapshot();
  return settingsInput.parse({
    ...value,
    models: value.models.map(({ oauth: _, authVersion: __, ...m }) => m),
    mcp: value.mcp.map(({ oauth: _, authVersion: __, ...s }) => s),
  });
}
function remoteConfig(url: string, auth: "none" | "bearer" | "oauth" = "none") {
  return {
    id: randomUUID(),
    name: "Remote",
    transport: "http" as const,
    enabled: true,
    url,
    auth,
    command: "",
    args: [],
    privateHosts: [],
    clientId: "",
    ...(auth === "bearer" ? { bearer: "fixture-bearer" } : {}),
  };
}
async function http(service: Awaited<ReturnType<typeof fixture>>["service"]) {
  const app = await createServer(service),
    headers: Record<string, string> = {
      host: "127.0.0.1:8080",
      origin: "http://127.0.0.1:8080",
    };
  const session = await app.inject({ url: "/api/session", headers });
  headers.cookie = session.headers["set-cookie"]!.toString().split(";")[0]!;
  headers["x-csrf-token"] = session.json().csrf;
  return { app, headers };
}
test("Web settings protect secrets, require CSRF, preserve history, persist restart and apply only at the next run", async () => {
  let tested = 0;
  let f = await fixture(
    [call("bash", { command: "sleep 1; printf done" }), answer("first")],
    {
      modelTest: async (model, key) => {
        assert.equal(model, "gpt-4.1");
        assert.equal(key, "dummy-model-key");
        tested++;
      },
    },
  );
  const { app, headers } = await http(f.service);
  try {
    const { id } = await f.service.create(randomUUID(), "Keep history");
    await f.service.send(id, randomUUID(), "start");
    await until(
      async () => (await f.service.view(id)).progress.tools.length > 0,
    );
    const before = await f.service.conversation(id),
      s = input(f.service),
      modelId = randomUUID();
    s.models = [
      {
        id: modelId,
        provider: "openai",
        model: "gpt-4.1",
        key: "dummy-model-key",
      },
    ];
    s.defaultModel = modelId;
    s.instructions = "Updated instruction";
    s.limits.modelRequests = 3;
    assert.equal(
      (
        await app.inject({
          method: "PUT",
          url: "/api/settings",
          headers: { ...headers, "x-csrf-token": "bad" },
          payload: s,
        })
      ).statusCode,
      403,
    );
    const saved = await app.inject({
      method: "PUT",
      url: "/api/settings",
      headers,
      payload: s,
    });
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.json().pending, true);
    assert.ok(!saved.body.includes("dummy-model-key"));
    assert.equal(f.config.limits.modelRequests, 60);
    assert.equal((await f.service.conversation(id)).requests, before.requests);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/api/settings/models/${modelId}/test`,
          headers,
          payload: {},
        })
      ).statusCode,
      400,
    );
    assert.equal(tested, 0);
    const test = await app.inject({
      method: "POST",
      url: `/api/settings/models/${modelId}/test`,
      headers,
      payload: { confirmPaid: true },
    });
    assert.equal(test.statusCode, 200);
    assert.equal(tested, 1);
    assert.equal(
      (
        await app.inject({
          method: "PUT",
          url: "/api/settings",
          headers,
          payload: s,
        })
      ).statusCode,
      409,
    );
    await until(
      async () => (await f.service.conversation(id)).status === "idle",
    );
    // Saving a connection does not overwrite a conversation's selected model.
    assert.equal((await f.service.conversation(id)).model, "faux-1");
    await f.service.selectModel(id, modelId, "gpt-4.1");
    f.faux.setResponses([answer("second")]);
    await f.service.send(id, randomUUID(), "continue");
    await until(
      async () => (await f.service.conversation(id)).status === "idle",
    );
    assert.equal(f.config.limits.modelRequests, 3);
    assert.equal(f.service.management().pending, false);
    const history = JSON.stringify(await f.service.view(id));
    assert.match(history, /first/);
    assert.match(history, /second/);
    const raw = await (
      await f.service.piConversation(id)
    ).entries({}, 100, undefined, ctx);
    assert.match(JSON.stringify(raw), /gpt-4.1/);
    assert.ok(!history.includes("dummy-model-key"));
    const path = join(f.root, "control/settings-v1.json");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.match(await readFile(path, "utf8"), /dummy-model-key/);
    const root = f.root;
    await app.close();
    await f.service.close();
    f = await fixture([], { root });
    assert.equal(f.service.management().models[0]!.hasKey, true);
    assert.equal(f.service.management().instructions, "Updated instruction");
    assert.match(JSON.stringify(await f.service.view(id)), /first/);
    const deleted = input(f.service);
    deleted.models[0]!.key = "";
    await f.service.saveSettings(deleted);
    assert.equal(f.service.management().models[0]!.hasKey, false);
  } finally {
    await app.close();
    await f.service.close();
  }
});
test("model connections save without a model and invalid settings identify the field without exposing values", async () => {
  const f = await fixture([]);
  const { app, headers } = await http(f.service);
  try {
    const settings = input(f.service);
    settings.models = [
      {
        id: randomUUID(),
        provider: "openai",
        name: "Personal",
        key: "dummy-private-key",
      },
    ];
    settings.defaultModel = null;
    const save = (payload: object) =>
      app.inject({ method: "PUT", url: "/api/settings", headers, payload });
    const saved = await save(settings);
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.json().models[0].name, "Personal");
    assert.ok(!saved.body.includes("dummy-private-key"));
    const current = input(f.service);
    for (const [patch, expected] of [
      [{ name: "x".repeat(101) }, "接続名は100文字以内です"],
      [{ key: "secret".repeat(3000) }, "API キーは16384文字以内です"],
      [{ provider: "private-unsupported-provider" }, "プロバイダーが不正です"],
    ] as const) {
      const result = await save({
        ...current,
        models: [{ ...current.models[0], ...patch }],
      });
      assert.equal(result.statusCode, 400);
      assert.deepEqual(result.json(), { error: expected });
      assert.equal(f.service.settings.snapshot().revision, current.revision);
    }
  } finally {
    await app.close();
    await f.service.close();
  }
});
test("new conversation output listing while another runs is empty without worker calls or cleanup", async () => {
  const f = await fixture([
    call("bash", { command: "sleep 1; echo completed" }),
    answer("complete"),
  ]);
  try {
    const active = await f.service.create(randomUUID(), "active");
    await f.service.send(active.id, randomUUID(), "run");
    await until(
      async () => (await f.service.view(active.id)).progress.tools.length > 0,
    );
    const fresh = await f.service.create(randomUUID(), "fresh"),
      runner = f.runner as TestRunner;
    const original = runner.call.bind(runner);
    let calls = 0;
    runner.call = (...args) => {
      calls++;
      return original(...args);
    };
    assert.deepEqual(await f.service.files(fresh.id), {
      files: [],
      truncated: false,
    });
    await assert.rejects(
      f.service.download(fresh.id, "outputs/missing"),
      /ありません/,
    );
    assert.equal(calls, 0);
    assert.equal((await f.service.conversation(active.id)).status, "running");
    await until(
      async () => (await f.service.conversation(active.id)).status === "idle",
    );
    assert.match(JSON.stringify(await f.service.view(active.id)), /completed/);
    await rm(join(f.root, "work/conversations", active.id, "outputs"), {
      recursive: true,
    });
    assert.deepEqual((await f.service.files(active.id)).files, []);
  } finally {
    await f.service.close();
  }
});
test("stdio registration via HTTP, failed MCP isolation and safe disable/delete keep standard tools working", async () => {
  const f = await fixture(),
    { app, headers } = await http(f.service);
  try {
    const s = input(f.service),
      id = randomUUID();
    s.mcp = [
      {
        ...remoteConfig("https://unused.example"),
        id,
        name: "stdio",
        transport: "stdio",
        command: process.execPath,
        args: [resolve(".test-dist/tests/mcp-server.js")],
        url: "",
        env: { FIXTURE_SECRET: "delegated-test-secret" },
      },
      {
        ...remoteConfig("https://unused.example"),
        name: "broken",
        transport: "stdio",
        command: "/missing-fixture-mcp",
        url: "",
      },
    ];
    const saved = await app.inject({
      method: "PUT",
      url: "/api/settings",
      headers,
      payload: s,
    });
    assert.equal(saved.statusCode, 200);
    assert.ok(!saved.body.includes("delegated-test-secret"));
    const tested = await app.inject({
      method: "POST",
      url: `/api/settings/mcp/${id}/test`,
      headers,
      payload: {},
    });
    assert.equal(tested.json().mcp[0].status.tools[0].name, "greet");
    f.faux.setResponses([
      call("bash", { command: "sleep 1" }),
      call(mcpToolName(id, "greet"), { name: "Pi" }),
      call("write", { path: "outputs/result.txt", content: "ok" }),
      answer("complete"),
    ]);
    const conversation = await f.service.create(randomUUID(), "stdio");
    await f.service.send(conversation.id, randomUUID(), "run");
    await until(
      async () =>
        (await f.service.view(conversation.id)).progress.tools.length > 0,
    );
    const disable = input(f.service);
    disable.mcp[0]!.enabled = false;
    await f.service.saveSettings(disable);
    await assert.rejects(f.service.testMcp(id), /実行中/);
    await until(
      async () =>
        (await f.service.conversation(conversation.id)).status === "idle",
    );
    assert.match(
      JSON.stringify(await f.service.view(conversation.id)),
      /Hello Pi/,
    );
    assert.equal(
      (
        await f.service.download(conversation.id, "outputs/result.txt")
      ).toString(),
      "ok",
    );

    let advertised: string[] = [];
    f.faux.setResponses([
      (context) => {
        advertised = getCurrentTools(context.messages).map((t) => t.name);
        return fauxAssistantMessage(
          fauxToolCall("bash", { command: "printf still-available" }),
          { stopReason: "toolUse" },
        );
      },
      answer("done"),
    ]);
    await f.service.send(conversation.id, randomUUID(), "continue");
    await until(
      async () =>
        (await f.service.conversation(conversation.id)).status === "idle",
    );
    assert.equal(f.service.management().mcp[0]!.status.state, "disabled");
    assert.ok(!advertised.includes(mcpToolName(id, "greet")));
    const remove = input(f.service);
    remove.mcp = [];
    await f.service.saveSettings(remove);
    f.faux.setResponses([answer("no MCP")]);
    await f.service.send(conversation.id, randomUUID(), "continue");
    await until(
      async () =>
        (await f.service.conversation(conversation.id)).status === "idle",
    );
    assert.equal(f.service.management().mcp.length, 0);
    const history = await (
      await f.service.piConversation(conversation.id)
    ).entries({}, 100, undefined, ctx);
    assert.ok(!JSON.stringify(history).includes("delegated-test-secret"));
  } finally {
    await app.close();
    await f.service.close();
  }
});
test("Streamable HTTP supports unauthenticated and Bearer tools without persisting echoed tokens", async () => {
  const remote = await remoteFixture(),
    f = await fixture([], { remote: remote.options });
  try {
    const s = input(f.service);
    s.mcp = [
      remoteConfig(`${remote.origin}/public`),
      remoteConfig(`${remote.origin}/bearer`, "bearer"),
    ];
    await f.service.saveSettings(s);
    for (const server of s.mcp) {
      const status = await f.service.testMcp(server.id);
      assert.equal(
        status.mcp.find((m) => m.id === server.id)!.status.state,
        "ready",
      );
    }
    f.faux.setResponses([
      call(mcpToolName(s.mcp[0]!.id, "greet"), { name: "one" }),
      call(mcpToolName(s.mcp[1]!.id, "greet"), { name: "two" }),
      answer("done"),
    ]);
    const { id } = await f.service.create(randomUUID(), "HTTP MCP");
    await f.service.send(id, randomUUID(), "go");
    await until(
      async () => (await f.service.conversation(id)).status === "idle",
    );
    assert.equal(remote.counts().calls, 2);
    const history = JSON.stringify(
      await (
        await f.service.piConversation(id)
      ).entries({}, 100, undefined, ctx),
    );
    assert.match(history, /Remote hello/);
    assert.ok(!history.includes("fixture-bearer"));
    assert.ok(
      !JSON.stringify(f.service.management()).includes("fixture-bearer"),
    );
  } finally {
    await f.service.close();
    await remote.close();
  }
});
test("OAuth uses PKCE and browser-bound one-time state, refreshes, reauthenticates and disconnects", async () => {
  const remote = await remoteFixture(),
    f = await fixture([], { remote: remote.options }),
    { app, headers } = await http(f.service);
  try {
    const s = input(f.service),
      server = remoteConfig(`${remote.origin}/oauth`, "oauth");
    s.mcp = [server];
    await f.service.saveSettings(s);
    async function login() {
      const start = await app.inject({
        method: "POST",
        url: `/api/settings/mcp/${server.id}/oauth`,
        headers,
        payload: {},
      });
      assert.equal(start.statusCode, 200, start.body);
      const url = new URL(start.json().url);
      assert.equal(url.searchParams.get("code_challenge_method"), "S256");
      const redirect = await remote.fetch(url);
      assert.equal(redirect.status, 302);
      const callback = new URL(redirect.headers.get("location")!);
      const cookie = start.headers["set-cookie"]!.toString().split(";")[0]!;
      const denied = await app.inject({
        url: callback.pathname + callback.search,
        headers: { host: headers.host! },
      });
      assert.equal(denied.statusCode, 400);
      const result = await app.inject({
        url: callback.pathname + callback.search,
        headers: {
          host: headers.host!,
          cookie,
          "sec-fetch-site": "cross-site",
        },
      });
      assert.equal(result.statusCode, 302, result.body);
      assert.equal(
        (
          await app.inject({
            url: callback.pathname + callback.search,
            headers: { host: headers.host!, cookie },
          })
        ).statusCode,
        400,
      );
    }
    await login();
    assert.equal(f.service.management().mcp[0]!.authorized, true);
    const tested = await f.service.testMcp(server.id);
    assert.equal(tested.mcp[0]!.status.state, "ready");
    assert.ok(remote.counts().refreshes >= 1);
    await login();
    assert.equal(remote.counts().authorizations, 2);
    assert.equal(
      (await f.service.testMcp(server.id)).mcp[0]!.status.state,
      "ready",
    );
    for (const secret of remote.secrets())
      assert.ok(!JSON.stringify(f.service.management()).includes(secret));
    f.faux.setResponses([
      call(mcpToolName(server.id, "greet"), { name: "OAuth" }),
      answer("done"),
    ]);
    const conversation = await f.service.create(randomUUID(), "OAuth");
    await f.service.send(conversation.id, randomUUID(), "run");
    await until(
      async () =>
        (await f.service.conversation(conversation.id)).status === "idle",
    );
    const raw = JSON.stringify(
      await (
        await f.service.piConversation(conversation.id)
      ).entries({}, 100, undefined, ctx),
    );
    assert.match(raw, /Remote hello OAuth/);
    assert.ok(!raw.includes("access-"));
    await app.close();
    await f.service.close();
    const reopened = await fixture([], {
      root: f.root,
      remote: remote.options,
    });
    try {
      assert.equal(reopened.service.management().mcp[0]!.authorized, true);
      assert.equal(
        (await reopened.service.testMcp(server.id)).mcp[0]!.status.state,
        "ready",
      );
      await reopened.service.disconnectMcp(server.id);
      assert.equal(reopened.service.management().mcp[0]!.authorized, false);
      assert.equal(
        (await reopened.service.testMcp(server.id)).mcp[0]!.status.state,
        "error",
      );
    } finally {
      await reopened.service.close();
    }
  } finally {
    await app.close();
    await f.service.close();
    await remote.close();
  }
});
test("credential destination edits and stale OAuth completions cannot restore or transfer secrets", async () => {
  const f = await fixture();
  try {
    const s = input(f.service),
      server = remoteConfig("https://first.example/mcp", "bearer");
    s.mcp = [server];
    await f.service.saveSettings(s);
    const original = f.service.settings.snapshot().mcp[0]!;
    const edit = input(f.service);
    edit.mcp[0]!.url = "https://second.example/mcp";
    delete edit.mcp[0]!.bearer;
    await f.service.saveSettings(edit);
    assert.equal(f.service.management().mcp[0]!.hasBearer, false);
    await assert.rejects(
      f.service.settings.oauth(server.id, connectionIdentity(original), (v) => {
        v.tokens = { access_token: "stale-secret", token_type: "Bearer" };
      }),
      /変更/,
    );
    const beforeDisconnect = f.service.settings.snapshot().mcp[0]!;
    await f.service.disconnectMcp(server.id);
    await assert.rejects(
      f.service.settings.oauth(
        server.id,
        connectionIdentity(beforeDisconnect),
        (v) => {
          v.tokens = { access_token: "stale-secret", token_type: "Bearer" };
        },
      ),
      /変更/,
    );
    assert.equal(f.service.management().mcp[0]!.authorized, false);
  } finally {
    await f.service.close();
  }
});
test("remote URL/DNS policy blocks metadata, special IPv4/IPv6 and mixed DNS answers; private hosts require exact grants", async () => {
  for (const address of [
    "127.0.0.1",
    "169.254.169.254",
    "0.0.0.0",
    "10.0.0.1",
    "172.16.2.3",
    "192.168.1.1",
    "100.100.100.200",
    "224.0.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "fe80::1",
    "fd00::1",
    "2002:7f00:1::",
  ])
    assert.equal(allowedAddress(address), false, address);
  assert.equal(allowedAddress("169.254.169.254", true), false);
  assert.equal(allowedAddress("::ffff:169.254.169.254", true), false);
  assert.equal(allowedAddress("8.8.8.8"), true);
  assert.equal(allowedAddress("2606:4700:4700::1111"), true);
  for (const value of [
    "http://example.com",
    "https://user:pass@example.com",
    "https://example.com/#x",
  ])
    assert.throws(() => remoteUrl(value));
  const url = remoteUrl("https://vpn.example/mcp");
  const privateDns = async () => [{ address: "10.0.0.1", family: 4 }];
  await assert.rejects(resolveRemote(url, [], privateDns));
  await assert.rejects(resolveRemote(url, ["other.example"], privateDns));
  assert.equal(
    (await resolveRemote(url, ["vpn.example"], privateDns)).address,
    "10.0.0.1",
  );
  await assert.rejects(
    resolveRemote(url, [], async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]),
  );
});

test("conversation model selection survives restart, preserves history and cannot replace an active model", async () => {
  let f = await fixture([
    call("bash", { command: "sleep 1; printf done" }),
    answer("first model"),
  ]);
  const { app, headers } = await http(f.service);
  const one = randomUUID(),
    two = randomUUID();
  try {
    const s = input(f.service);
    s.models = [
      {
        id: one,
        provider: "openai",
        model: "gpt-4.1",
        key: "model-one-secret",
      },
      { id: two, provider: "openai", model: "faux-1", key: "model-two-secret" },
    ];
    s.defaultModel = one;
    await f.service.saveSettings(s);
    const created = await app.inject({
      method: "POST",
      url: "/api/conversations",
      headers,
      payload: {
        requestId: randomUUID(),
        title: "Selected model model-one-secret",
        modelId: two,
      },
    });
    const id = created.json().id as string;
    assert.equal((await f.service.conversation(id)).modelConfigId, two);
    assert.equal(
      (
        await app.inject({
          method: "PUT",
          url: `/api/conversations/${id}/model`,
          headers: { ...headers, "x-csrf-token": "bad" },
          payload: { modelId: one },
        })
      ).statusCode,
      403,
    );
    await f.service.send(id, randomUUID(), "start");
    await until(
      async () => (await f.service.view(id)).progress.tools.length > 0,
    );
    const before = await f.service.conversation(id);
    assert.equal(
      (
        await app.inject({
          method: "PUT",
          url: `/api/conversations/${id}/model`,
          headers,
          payload: { modelId: one },
        })
      ).statusCode,
      409,
    );
    assert.equal((await f.service.conversation(id)).modelConfigId, two);
    assert.equal((await f.service.conversation(id)).requests, before.requests);
    await until(
      async () => (await f.service.conversation(id)).status === "idle",
    );
    const result = await app.inject({
      method: "PUT",
      url: `/api/conversations/${id}/model`,
      headers,
      payload: { modelId: one },
    });
    assert.equal(result.statusCode, 200);
    assert.equal(result.json().conversation.modelConfigId, one);
    assert.ok(!result.body.includes("model-one-secret"));
    f.faux.setResponses([answer("second model")]);
    await f.service.send(id, randomUUID(), "continue");
    await until(
      async () => (await f.service.conversation(id)).status === "idle",
    );
    const raw = JSON.stringify(
      await (
        await f.service.piConversation(id)
      ).entries({}, 100, undefined, ctx),
    );
    assert.match(raw, /faux-1/);
    assert.match(raw, /gpt-4.1/);
    assert.match(raw, /first model/);
    assert.match(raw, /second model/);
    assert.ok(!raw.includes("model-one-secret"));
    const other = await f.service.create(randomUUID(), "Another", two);
    f.faux.setResponses([answer("other conversation")]);
    await f.service.send(other.id, randomUUID(), "other");
    await until(
      async () => (await f.service.conversation(other.id)).status === "idle",
    );
    assert.equal((await f.service.conversation(id)).modelConfigId, one);
    const root = f.root;
    await app.close();
    await f.service.close();
    f = await fixture([], { root });
    assert.equal((await f.service.conversation(id)).modelConfigId, one);
    assert.match(JSON.stringify(await f.service.view(id)), /second model/);
    const deleted = input(f.service);
    deleted.models = deleted.models.filter((m) => m.id !== one);
    deleted.defaultModel = two;
    await f.service.saveSettings(deleted);
    await assert.rejects(
      f.service.send(id, randomUUID(), "must not silently switch"),
      /選び直/,
    );
    assert.equal((await f.service.conversation(id)).modelConfigId, one);
  } finally {
    await app.close();
    await f.service.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("HTTP MCP calls use the configured private target without permitting metadata, redirects or plaintext credentials", async () => {
  const remote = await remoteFixture();
  const port = new URL(remote.local).port;
  const target = `http://fixture.example:${port}`;
  let resolutions = 0;
  const f = await fixture([], {
    remote: {
      network: {
        resolve: async (url, hosts) => {
          assert.equal(url.origin, target);
          const validated = await resolveRemote(url, hosts, async () => [
            { address: "10.20.30.40", family: 4 },
          ]);
          assert.equal(validated.address, "10.20.30.40");
          resolutions++;
          return { address: "127.0.0.1", family: 4 };
        },
      },
    },
  });
  try {
    const s = input(f.service),
      server = remoteConfig(`${target}/public`);
    s.mcp = [server];
    await f.service.saveSettings(s);
    assert.equal(
      (await f.service.testMcp(server.id)).mcp[0]!.status.state,
      "ready",
    );
    const result = await f.service.remote.use(
      f.service.mcpServer(server.id),
      "http://127.0.0.1:8080",
      (client) =>
        client.callTool({ name: "greet", arguments: { name: "HTTP" } }),
    );
    assert.match(JSON.stringify(result), /HTTP/);
    assert.ok(resolutions >= 2);
    const denied = input(f.service);
    denied.mcp[0]!.auth = "bearer";
    denied.mcp[0]!.bearer = "never-send";
    await assert.rejects(f.service.saveSettings(denied));
    const http = remoteFetch(["169.254.169.254"], {
      httpOrigin: "http://169.254.169.254",
      resolve: (url, hosts) => resolveRemote(url, hosts),
    });
    await assert.rejects(http("http://169.254.169.254/latest"), /許可/);
    await assert.rejects(http("http://other.example/latest"), /登録/);
    const plain = remoteFetch(["fixture.example"], {
      httpOrigin: target,
      resolve: async () => ({ address: "127.0.0.1", family: 4 }),
    });
    await assert.rejects(
      plain(`${target}/public`, {
        headers: { Authorization: "Bearer never-send" },
      }),
      /HTTPS/,
    );
  } finally {
    await f.service.close();
    await remote.close();
  }
});

test("one credential connection supports independent conversation models and preserves selections on restart", async () => {
  let f = await fixture([]);
  const connection = randomUUID();
  try {
    const s = input(f.service);
    s.models = [
      {
        id: connection,
        provider: "openai",
        name: "Personal",
        key: "connection-secret",
      },
    ];
    s.defaultModel = connection;
    await f.service.saveSettings(s);
    const first = await f.service.create(
      randomUUID(),
      "First",
      connection,
      "gpt-4.1",
    );
    const second = await f.service.create(
      randomUUID(),
      "Second",
      connection,
      "gpt-4.1-mini",
    );
    for (const item of [first, second]) {
      f.faux.setResponses([answer("completed")]);
      await f.service.send(item.id, randomUUID(), "hello");
      await until(
        async () => (await f.service.conversation(item.id)).status === "idle",
      );
    }
    assert.equal((await f.service.conversation(first.id)).model, "gpt-4.1");
    assert.equal(
      (await f.service.conversation(second.id)).model,
      "gpt-4.1-mini",
    );
    assert.equal(f.service.settings.snapshot().models[0]!.model, undefined);
    await f.service.selectModel(first.id, connection, "gpt-4.1-mini");
    f.faux.setResponses([answer("continued")]);
    await f.service.send(first.id, randomUUID(), "continue");
    await until(
      async () => (await f.service.conversation(first.id)).status === "idle",
    );
    const history = JSON.stringify(
      await (
        await f.service.piConversation(first.id)
      ).entries({}, 100, undefined, ctx),
    );
    assert.match(history, /gpt-4.1/);
    assert.match(history, /gpt-4.1-mini/);
    assert.match(history, /continued/);
    assert.ok(!history.includes("connection-secret"));
    await assert.rejects(
      f.service.selectModel(first.id, connection, "unknown-model"),
      /選び直/,
    );
    const root = f.root;
    await f.service.close();
    f = await fixture([], { root });
    assert.equal(
      (await f.service.conversation(first.id)).model,
      "gpt-4.1-mini",
    );
    assert.equal(
      (await f.service.conversation(second.id)).model,
      "gpt-4.1-mini",
    );
    const removed = input(f.service);
    removed.models = [];
    removed.defaultModel = null;
    await f.service.saveSettings(removed);
    await assert.rejects(
      f.service.send(first.id, randomUUID(), "no fallback"),
      /選び直/,
    );
    assert.match(JSON.stringify(await f.service.view(first.id)), /continued/);
  } finally {
    await f.service.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
