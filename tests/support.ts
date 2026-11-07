import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import type { JsonObject } from "@earendil-works/pi-durable";
import type { Config } from "../src/config.js";
import type {
  Runner,
  WorkerRequest,
  WorkerResult,
} from "../src/execution/protocol.js";
import { Worker } from "../src/execution/worker.js";
import { AgentService } from "../src/service.js";
import type { ServiceOptions } from "../src/service.js";
import { DEFAULT_LIMITS } from "../src/state.js";

// Test-only injection exercises actual Pi tools and files; it does not prove the production UID boundary.
export class TestRunner implements Runner {
  readonly worker: Worker;
  available = true;
  constructor(readonly root: string) {
    this.worker = new Worker({ root, production: false });
  }
  async ready() {
    if (!this.available) throw new Error("Boundary unavailable");
  }
  call(
    conversationId: string,
    op: WorkerRequest["op"],
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<WorkerResult> {
    return this.worker.execute(
      { id: randomUUID(), conversationId, op, args },
      signal ?? new AbortController().signal,
    );
  }
  async close() {
    await this.worker.cleanup();
  }
}
export const call = (name: string, args: JsonObject): FauxResponseStep =>
  fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
export const answer = (text: string): FauxResponseStep =>
  fauxAssistantMessage(text);
export async function fixture(
  responses: FauxResponseStep[] = [],
  options: ServiceOptions & {
    root?: string;
    noModel?: boolean;
    mcp?: Config["mcp"];
  } = {},
) {
  const root =
    options.root ?? (await mkdtemp(join(tmpdir(), "agent-conversation-")));
  for (const name of ["control", "control/secrets", "work"])
    await mkdir(join(root, name), { recursive: true, mode: 0o700 });
  const config: Config = {
    schemaVersion: 2,
    dataRoot: root,
    expectedMountLabel: "AGENT_DATA",
    server: {
      host: "127.0.0.1",
      port: 8080,
      origins: ["http://127.0.0.1:8080"],
    },
    model: null,
    mcp: options.mcp ?? [],
    instructions: "",
    limits: { ...DEFAULT_LIMITS, commandSeconds: 10 },
  };
  const faux = fauxProvider({
    tokensPerSecond: Infinity,
    models: [{ id: "faux-1" }, { id: "gpt-4.1" }],
  });
  faux.setResponses(responses);
  const runner = options.runner ?? new TestRunner(join(root, "work"));
  const service = await AgentService.open(config, {
    ...options,
    runner,
    provider: options.noModel ? undefined : (options.provider ?? faux.provider),
    modelId: "faux-1",
  });
  return { service, runner, root, config, faux };
}
export async function until(check: () => Promise<boolean>, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error("Timed out");
}
export const csvResponses = () => [
  call("read", { path: "attachments/input.csv" }),
  call("write", {
    path: "outputs/clean.csv",
    content: "name,total\nAlice,12\nBob,3\n",
  }),
  call("bash", {
    command:
      "python3 -c \"import csv; r=list(csv.reader(open('outputs/clean.csv'))); assert len(r)==3; print('CSV verified')\"",
  }),
  answer("整形した CSV を outputs/clean.csv に保存しました。"),
];
