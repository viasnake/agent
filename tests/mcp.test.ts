import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { McpTools, schemaHash } from "../src/mcp.js";
import { Sandbox } from "../src/sandbox.js";
import { TaskTools } from "../src/tools.js";
import { fixture, ScriptedRuntime, completed, testConfig } from "./helpers.js";
import { StreamableHttpTransport, type Tool } from "@earendil-works/pi-mcp";
import { serverFetch } from "../src/mcp-auth.js";
import { StreamCompletion } from "../src/runtime/stream.js";
import type {
  ToolApprovalHandler,
  ToolApprovalRequest,
} from "../src/tool-approval.js";
import { validateConfig } from "../src/config.js";

const approved: Tool = {
  name: "lookup",
  description: "Lookup a document",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
    additionalProperties: false,
  },
};
function mockMcp(
  t: TestContext,
  catalog: () => Tool[],
  payloads: unknown[] = [],
) {
  const calls: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      const request = JSON.parse(String(init?.body)) as {
        id?: number;
        method: string;
        params?: { protocolVersion?: string; name?: string };
      };
      calls.push(request.method);
      if (request.method === "tools/call") payloads.push(request.params);
      if (request.id === undefined) return new Response(null, { status: 202 });
      const result =
        request.method === "initialize"
          ? {
              protocolVersion: request.params!.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "fixture", version: "1" },
            }
          : request.method === "tools/list"
            ? { tools: catalog() }
            : { content: [{ type: "text", text: "fixture evidence" }] };
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: request.id, result }),
        { headers: { "content-type": "application/json" } },
      );
    },
  );
  return calls;
}
function config() {
  const config = testConfig();
  config.mcp.docs = {
    transport: "http",
    url: "http://127.0.0.1:15555/mcp",
    allowedOrigins: ["http://127.0.0.1:15555"],
    args: [],
    env: {},
    oauth: false,
    allowedData: ["private"],
    local: false,
    tools: { lookup: { schemaSha256: schemaHash(approved), readOnly: true } },
  };
  return config;
}
async function mutationFixture(handler?: ToolApprovalHandler) {
  const settings = config();
  settings.mcp.docs!.tools.lookup = {
    schemaSha256: schemaHash(approved),
    readOnly: false,
    effect: "publish",
  };
  validateConfig(settings);
  const f = await fixture(
    new ScriptedRuntime(async () => completed()),
    settings,
  );
  const initial = await f.harness.create({
    kind: "research",
    objective: "test explicit operation approval",
    access: "change",
  });
  const run = f.store.claim(initial.id);
  const root = join(f.store.runDir(run.id), "work");
  const sandbox = new Sandbox(f.config.execution);
  const task = {
    id: "work",
    role: "worker" as const,
    objective: "test",
    dependsOn: [],
    write: true,
    state: "pending" as const,
    attempts: 0,
  };
  const manager = new McpTools(
    f.config,
    f.p,
    sandbox,
    root,
    new AbortController().signal,
    handler,
  );
  const dispatcher = new TaskTools(f.config, f.store, run, task, root, sandbox);
  return {
    ...f,
    run,
    task,
    manager,
    dispatcher,
    close: async () => {
      await manager.close();
      f.store.release(run);
      await f.cleanup();
    },
  };
}

test("MCP mutations require one-time exact approval and retain prepared state until confirmation", async (t) => {
  const payloads: unknown[] = [];
  const calls = mockMcp(t, () => [approved], payloads);
  let handler: ToolApprovalHandler | undefined;
  const original = { query: "original" };
  const seen: ToolApprovalRequest[] = [];
  const f = await mutationFixture((request, signal) =>
    handler ? handler(request, signal) : Promise.resolve(false),
  );
  try {
    const [tool] = await f.manager.tools(f.run, f.dispatcher);
    await assert.rejects(
      () => tool!.execute(original, new AbortController().signal),
      /did not approve/,
    );
    assert.equal(calls.includes("tools/call"), false);
    assert.equal(f.store.operations(f.run.id).at(-1)!.status, "failed");
    handler = async (request) => {
      seen.push(request);
      assert.equal(f.store.operations(f.run.id).at(-1)!.status, "prepared");
      assert.equal(request.argumentsJson, '{"query":"original"}');
      assert.equal(request.destination, "http://127.0.0.1:15555/mcp");
      original.query = "changed after preview";
      return true;
    };
    await tool!.execute(original, new AbortController().signal);
    assert.deepEqual(payloads, [
      { name: "lookup", arguments: { query: "original" } },
    ]);
    original.query = "original";
    await tool!.execute(original, new AbortController().signal);
    assert.equal(seen.length, 2);
    assert.equal(seen[1]!.previousCompletions, 1);
    assert.ok(
      f.store
        .events(f.run.id)
        .some(
          (event) =>
            event.type === "tool_approval_decided" &&
            JSON.parse(event.detail).outcome === "approved",
        ),
    );
    const reader = { ...f.task, write: false };
    assert.deepEqual(
      await f.manager.tools(
        f.run,
        new TaskTools(
          f.config,
          f.store,
          f.run,
          reader,
          f.dispatcher.root,
          f.dispatcher.sandbox,
        ),
      ),
      [],
    );
  } finally {
    await f.close();
  }
});

test("MCP approval fails closed without UI, after schema changes or cancellation, and after an uncertain mutation", async (t) => {
  let changed = false;
  const calls = mockMcp(t, () => [
    {
      ...approved,
      inputSchema: changed
        ? { type: "object", properties: {} }
        : approved.inputSchema,
    },
  ]);
  const missing = await mutationFixture();
  try {
    const [tool] = await missing.manager.tools(missing.run, missing.dispatcher);
    await assert.rejects(
      () => tool!.execute({ query: "test" }, new AbortController().signal),
      /no approval handler/,
    );
    assert.equal(
      missing.store.operations(missing.run.id).at(-1)!.status,
      "failed",
    );
  } finally {
    await missing.close();
  }
  let handler: ToolApprovalHandler = async () => {
    changed = true;
    return true;
  };
  const f = await mutationFixture((request, signal) =>
    handler(request, signal),
  );
  try {
    const [tool] = await f.manager.tools(f.run, f.dispatcher);
    await assert.rejects(
      () =>
        tool!.execute({ query: "schema change" }, new AbortController().signal),
      /schema changed/,
    );
    changed = false;
    const controller = new AbortController();
    handler = async () => {
      controller.abort();
      return true;
    };
    await assert.rejects(() =>
      tool!.execute({ query: "cancel" }, controller.signal),
    );
    assert.equal(f.store.operations(f.run.id).at(-1)!.status, "failed");
    assert.equal(calls.includes("tools/call"), false);
    handler = async () => {
      f.config.mcp.docs!.url = "http://127.0.0.1:15555/other";
      return true;
    };
    await assert.rejects(
      () =>
        tool!.execute(
          { query: "destination change" },
          new AbortController().signal,
        ),
      /destination or permissions changed/,
    );
    f.config.mcp.docs!.url = "http://127.0.0.1:15555/mcp";
    let approvals = 0,
      dispatched = 0;
    handler = async () => {
      approvals++;
      return true;
    };
    t.mock.method(await f.manager.connect("docs"), "callTool", async () => {
      dispatched++;
      throw new Error("Lost response after a possible side effect");
    });
    await assert.rejects(
      () => tool!.execute({ query: "uncertain" }, new AbortController().signal),
      /Lost response/,
    );
    assert.equal(f.store.operations(f.run.id).at(-1)!.status, "unknown");
    await assert.rejects(
      () => tool!.execute({ query: "uncertain" }, new AbortController().signal),
      /Resolve uncertain/,
    );
    assert.equal(approvals, 1);
    assert.equal(dispatched, 1);
  } finally {
    await f.close();
  }
});

test("MCP permission configuration preserves read-only legacy shape and rejects contradictory effects", () => {
  const settings = config();
  assert.deepEqual(validateConfig(settings), settings);
  settings.mcp.docs!.tools.lookup!.effect = "delete";
  assert.throws(() => validateConfig(settings), /remove the mutation effect/);
  settings.mcp.docs!.tools.lookup!.readOnly = false;
  assert.doesNotThrow(() => validateConfig(settings));
  settings.mcp.docs!.url += "?token=not-a-real-secret";
  assert.throws(() => validateConfig(settings), /must not contain a URL query/);
});
test("MCP mutation authentication challenges cannot trigger SDK POST replay", async (t) => {
  let posts = 0,
    recoveries = 0;
  t.mock.method(globalThis, "fetch", async () => {
    posts++;
    return new Response("auth required", { status: 401 });
  });
  for (const readOnly of [false, true]) {
    const settings = config();
    settings.mcp.docs!.tools.lookup!.readOnly = readOnly;
    const transport = new StreamableHttpTransport({
      url: settings.mcp.docs!.url!,
      fetch: serverFetch(settings.mcp.docs!, new AbortController().signal),
      openGetStream: false,
      reconnect: { maxRetries: 0 },
      authProvider: {
        token: async () => undefined,
        onUnauthorized: async () => {
          recoveries++;
        },
      },
    });
    try {
      await transport.start();
      const before = posts;
      await assert.rejects(() =>
        transport.send({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "lookup", arguments: { query: "test" } },
        }),
      );
      assert.equal(posts - before, readOnly ? 2 : 1);
      assert.equal(recoveries, readOnly ? 1 : 0);
    } finally {
      await transport.close();
    }
  }
});
test("MCP only exposes explicitly pinned tools and preserves returned source evidence", async (t) => {
  const calls = mockMcp(t, () => [
      approved,
      {
        ...approved,
        name: "delete_everything",
        annotations: { readOnlyHint: true },
      },
    ]),
    f = await fixture(new ScriptedRuntime(async () => completed()), config());
  let manager: McpTools | undefined;
  try {
    const initial = await f.harness.create({
        kind: "research",
        objective: "look up",
      }),
      run = f.store.claim(initial.id),
      root = join(f.store.runDir(run.id), "work"),
      sandbox = new Sandbox(f.config.execution);
    manager = new McpTools(
      f.config,
      f.p,
      sandbox,
      root,
      new AbortController().signal,
    );
    const task = {
      id: "work",
      role: "worker" as const,
      objective: "test",
      dependsOn: [],
      write: true,
      state: "pending" as const,
      attempts: 0,
    };
    const tools = await manager.tools(
      run,
      new TaskTools(f.config, f.store, run, task, root, sandbox),
    );
    assert.deepEqual(
      tools.map((t) => t.name),
      ["mcp_docs_lookup"],
    );
    await assert.rejects(
      () => tools[0]!.execute({ query: 42 }, new AbortController().signal),
      /approved schema/,
    );
    const result = JSON.parse(
      await tools[0]!.execute({ query: "test" }, new AbortController().signal),
    );
    assert.ok(result.sourceId);
    assert.equal(
      f.store.artifacts(run.id).filter((a) => a.kind === "source").length,
      1,
    );
    assert.equal(calls.filter((c) => c === "tools/call").length, 1);
    f.store.release(run);
  } finally {
    await manager?.close();
    await f.cleanup();
  }
});
test("changed MCP schema is rejected at dispatch without calling the tool", async (t) => {
  let changed = false;
  const calls = mockMcp(t, () => [
      {
        ...approved,
        inputSchema: changed
          ? { type: "object", properties: { secret: { type: "string" } } }
          : approved.inputSchema,
      },
    ]),
    f = await fixture(new ScriptedRuntime(async () => completed()), config());
  let manager: McpTools | undefined;
  try {
    const initial = await f.harness.create({
        kind: "research",
        objective: "lookup",
      }),
      run = f.store.claim(initial.id),
      root = join(f.store.runDir(run.id), "work"),
      sandbox = new Sandbox(f.config.execution);
    manager = new McpTools(
      f.config,
      f.p,
      sandbox,
      root,
      new AbortController().signal,
    );
    const task = {
      id: "work",
      role: "worker" as const,
      objective: "test",
      dependsOn: [],
      write: true,
      state: "pending" as const,
      attempts: 0,
    };
    const tools = await manager.tools(
      run,
      new TaskTools(f.config, f.store, run, task, root, sandbox),
    );
    changed = true;
    await assert.rejects(
      () => tools[0]!.execute({ query: "test" }, new AbortController().signal),
      /schema changed/,
    );
    assert.equal(calls.includes("tools/call"), false);
    f.store.release(run);
  } finally {
    await manager?.close();
    await f.cleanup();
  }
});
test("local-only does not even initialize remote MCP connections", async (t) => {
  const calls = mockMcp(t, () => [approved]),
    f = await fixture(new ScriptedRuntime(async () => completed()), config());
  let manager: McpTools | undefined;
  try {
    const initial = await f.harness.create({
        kind: "writing",
        objective: "offline",
        localOnly: true,
      }),
      run = f.store.claim(initial.id),
      root = join(f.store.runDir(run.id), "work"),
      sandbox = new Sandbox(f.config.execution);
    manager = new McpTools(
      f.config,
      f.p,
      sandbox,
      root,
      new AbortController().signal,
    );
    const task = {
      id: "work",
      role: "worker" as const,
      objective: "test",
      dependsOn: [],
      write: true,
      state: "pending" as const,
      attempts: 0,
    };
    assert.deepEqual(
      await manager.tools(
        run,
        new TaskTools(f.config, f.store, run, task, root, sandbox),
      ),
      [],
    );
    assert.equal(calls.length, 0);
    f.store.release(run);
  } finally {
    await manager?.close();
    await f.cleanup();
  }
});
test("strict wire verification rejects malformed tool JSON even after a finish reason", async () => {
  const wire = new StreamCompletion(false, 10000),
    response = wire.wrap(
      new Response(
        'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\\"x\\\":1"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n',
      ),
    );
  await response.text();
  assert.throws(() => wire.verify(), /incomplete JSON/);
});
test("strict wire verification requires completion marker across split chunks", async () => {
  const wire = new StreamCompletion(false, 10000),
    encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("data: [DO"));
      controller.enqueue(encoder.encode("NE]\n\n"));
      controller.close();
    },
  });
  await wire.wrap(new Response(stream)).text();
  assert.doesNotThrow(() => wire.verify());
  const incomplete = new StreamCompletion(false, 10000);
  await incomplete.wrap(new Response('data: {"choices":[]}\n\n')).text();
  assert.throws(() => incomplete.verify(), /completion marker/);
});

test("stdio MCP executes only its pinned program inside the network-isolated sandbox", async (t) => {
  const { writeFile, chmod, mkdir } = await import("node:fs/promises");
  const { sha256 } = await import("../src/util.js");
  const config = testConfig();
  config.execution.backend = "bubblewrap";
  const f = await fixture(new ScriptedRuntime(async () => completed()), config);
  let manager: McpTools | undefined;
  try {
    const work = join(f.root, "stdio-work");
    await mkdir(work);
    const sandbox = new Sandbox(config.execution),
      probe = await sandbox.probe(work);
    if (!probe.ok) {
      if (process.env.AGENT_REQUIRE_SANDBOX === "1") assert.fail(probe.detail);
      t.skip(probe.detail);
      return;
    }
    const script = `#!/usr/bin/python3
import json, os, sys
assert os.environ.get('HOME') == '/tmp'
assert not os.path.exists('/etc/shadow')
for line in sys.stdin:
    request = json.loads(line)
    if 'id' not in request:
        continue
    method = request['method']
    if method == 'initialize':
        result = {'protocolVersion': request['params']['protocolVersion'], 'capabilities': {'tools': {}}, 'serverInfo': {'name': 'fixture', 'version': '1'}}
    elif method == 'tools/list':
        result = {'tools': [json.loads(${JSON.stringify(JSON.stringify(approved))})]}
    else:
        result = {'content': [{'type': 'text', 'text': 'isolated stdio evidence'}]}
    print(json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'result': result}), flush=True)
`;
    const command = join(f.root, "mcp-fixture");
    await writeFile(command, script);
    await chmod(command, 0o755);
    config.mcp.stdio = {
      transport: "stdio",
      command,
      commandSha256: sha256(script),
      args: [],
      env: {},
      allowedOrigins: [],
      oauth: false,
      local: true,
      allowedData: ["private"],
      tools: { lookup: { schemaSha256: schemaHash(approved), readOnly: true } },
    };
    manager = new McpTools(
      config,
      f.p,
      sandbox,
      work,
      new AbortController().signal,
    );
    assert.equal(
      (await manager.catalog("stdio"))[0]!.schemaSha256,
      schemaHash(approved),
    );
    const client = await manager.connect("stdio");
    const result = await client.callTool("lookup", { query: "fixture" });
    assert.match(JSON.stringify(result), /isolated stdio evidence/);
  } finally {
    await manager?.close();
    await f.cleanup();
  }
});

test("MCP OAuth refresh uses approved origins and rotates only its connection token", async (t) => {
  const { writeFile, mkdir, readFile } = await import("node:fs/promises");
  const config = testConfig();
  config.mcp.docs = {
    transport: "http",
    url: "https://docs.example.invalid/mcp",
    allowedOrigins: [
      "https://docs.example.invalid",
      "https://login.example.invalid",
    ],
    args: [],
    env: {},
    oauth: true,
    allowedData: ["private"],
    local: false,
    tools: {},
  };
  const f = await fixture(new ScriptedRuntime(async () => completed()), config);
  const authDir = join(f.p.auth, "mcp-docs");
  await mkdir(authDir, { mode: 0o700 });
  await writeFile(
    join(authDir, "oauth.json"),
    JSON.stringify({
      serverUrl: config.mcp.docs.url,
      clientInformation: { client_id: "fixture-client" },
      tokens: {
        access_token: "fixture-old",
        refresh_token: "fixture-refresh",
        token_type: "Bearer",
      },
    }),
    { mode: 0o600 },
  );
  let refreshes = 0,
    authenticated = 0,
    manager: McpTools | undefined;
  t.mock.method(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      assert.equal(init?.redirect, "error");
      if (url.includes("/.well-known/oauth-protected-resource"))
        return Response.json({
          resource: config.mcp.docs!.url,
          authorization_servers: ["https://login.example.invalid"],
        });
      if (url.includes("/.well-known/oauth-authorization-server"))
        return Response.json({
          issuer: "https://login.example.invalid",
          authorization_endpoint: "https://login.example.invalid/authorize",
          token_endpoint: "https://login.example.invalid/token",
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
          grant_types_supported: ["authorization_code", "refresh_token"],
        });
      if (url === "https://login.example.invalid/token") {
        refreshes++;
        assert.match(String(init?.body), /grant_type=refresh_token/);
        return Response.json({
          access_token: "fixture-new",
          refresh_token: "fixture-rotated",
          token_type: "Bearer",
          expires_in: 3600,
        });
      }
      assert.equal(url, config.mcp.docs!.url);
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      if (
        new Headers(init?.headers).get("authorization") !== "Bearer fixture-new"
      )
        return new Response(null, {
          status: 401,
          headers: {
            "www-authenticate":
              'Bearer resource_metadata="https://docs.example.invalid/.well-known/oauth-protected-resource"',
          },
        });
      authenticated++;
      const request = JSON.parse(String(init?.body));
      if (request.id === undefined) return new Response(null, { status: 202 });
      const result =
        request.method === "initialize"
          ? {
              protocolVersion: request.params.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "fixture", version: "1" },
            }
          : { tools: [approved] };
      return Response.json({ jsonrpc: "2.0", id: request.id, result });
    },
  );
  try {
    manager = new McpTools(
      config,
      f.p,
      new Sandbox(config.execution),
      f.root,
      new AbortController().signal,
    );
    assert.equal((await manager.catalog("docs")).length, 1);
    assert.equal(refreshes, 1);
    assert.ok(authenticated >= 2);
    const state = JSON.parse(
      await readFile(join(authDir, "oauth.json"), "utf8"),
    );
    assert.equal(state.tokens.refresh_token, "fixture-rotated");
  } finally {
    await manager?.close();
    await f.cleanup();
  }
});
