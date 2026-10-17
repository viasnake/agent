import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configSchema, paths, type Config } from "../src/config.js";
import { Store } from "../src/storage.js";
import { Harness } from "../src/harness.js";
import type { Runtime, RuntimeRequest } from "../src/types.js";
import { runProcess, cleanEnvironment } from "../src/process.js";

export function testConfig(): Config {
  return configSchema.parse({
    schemaVersion: 1,
    connections: {
      local: {
        type: "local",
        enabled: true,
        account: "test",
        billing: "local",
        allowedData: ["public", "private", "restricted"],
        endpoint: "http://127.0.0.1:12345/v1",
        requestsPerMinute: 1000,
      },
    },
    models: {
      worker: {
        connection: "local",
        id: "worker-fixture",
        roles: ["lead", "worker"],
        kinds: ["coding", "research", "writing"],
        tools: true,
      },
      reviewer: {
        connection: "local",
        id: "reviewer-fixture",
        roles: ["reviewer"],
        kinds: ["coding", "research", "writing"],
        tools: true,
      },
    },
    execution: { backend: "disabled" },
    defaults: { mode: "single", dataClass: "private" },
  });
}
export class ScriptedRuntime implements Runtime {
  readonly contract = {
    version: 1 as const,
    context: "messages-v1" as const,
    tools: true,
    images: true,
    sessionFormat: "scripted-v1",
  };
  requests: RuntimeRequest[] = [];
  constructor(
    readonly respond: (
      request: RuntimeRequest,
      index: number,
    ) => Promise<string>,
  ) {}
  async run(request: RuntimeRequest): Promise<string> {
    request.signal.throwIfAborted();
    const index = this.requests.length;
    this.requests.push(request);
    const reservation = request.beforeRequest(
      Buffer.byteLength(request.objective),
    );
    const result = await this.respond(request, index);
    request.afterRequest(reservation, { input: 20, output: 10, costUsd: 0 });
    return result;
  }
  async close(): Promise<void> {}
}
export const completed = (
  artifacts: string[] = [],
  summary = "Verified fixture output",
) =>
  JSON.stringify({ outcome: "completed", summary, artifacts, unresolved: [] });
export async function call(
  request: RuntimeRequest,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const tool = request.tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool unavailable: ${name}`);
  return tool.execute(args, request.signal);
}
export async function fixture(runtime: Runtime, config = testConfig()) {
  const root = await mkdtemp(join(tmpdir(), "local-agent-test-")),
    p = paths(join(root, "state"));
  await mkdir(p.home, { mode: 0o700 });
  await mkdir(p.runs, { mode: 0o700 });
  await mkdir(p.auth, { mode: 0o700 });
  const store = new Store(p),
    harness = new Harness(config, p, store, runtime);
  return {
    root,
    p,
    store,
    harness,
    config,
    cleanup: async () => {
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
export async function gitWorkspace(
  root: string,
  files: Record<string, string>,
): Promise<string> {
  const origin = join(root, "origin");
  await mkdir(origin);
  for (const [path, content] of Object.entries(files)) {
    const target = join(origin, path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, content);
  }
  const env = {
    ...cleanEnvironment,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  for (const args of [
    ["init", "-q"],
    ["add", "."],
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-qm",
      "test baseline",
    ],
  ]) {
    const result = await runProcess("git", args, { cwd: origin, env });
    if (result.code !== 0) throw new Error(result.stderr);
  }
  return origin;
}
