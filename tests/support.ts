import { mkdtemp, mkdir, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
import type { WorkerOptions } from "../src/execution/worker.js";
import { Worker } from "../src/execution/worker.js";
import { AgentService } from "../src/service.js";
import type { ServiceOptions, CreateJob } from "../src/service.js";
import { DEFAULT_LIMITS } from "../src/state.js";
import type { Job } from "../src/state.js";

// Explicit test injection only. Production always uses the fixed sudo launcher and refuses missing OS isolation.
export class TestRunner implements Runner {
  readonly worker: Worker;
  available = true;
  constructor(
    readonly root: string,
    private codeFixture = false,
    workerOptions: Partial<WorkerOptions> = {},
  ) {
    this.worker = new Worker({ ...workerOptions, root, production: false });
  }
  async ready(): Promise<void> {
    if (!this.available) throw new Error("Boundary unavailable");
  }
  async call(
    jobId: string,
    op: WorkerRequest["op"],
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<WorkerResult> {
    const result = await this.worker.execute(
      { id: randomUUID(), jobId, op, args },
      signal ?? new AbortController().signal,
    );
    if (op === "init" && this.codeFixture) {
      await cp(
        resolve("tests/fixtures/code"),
        join(this.root, "jobs", jobId, "project"),
        { recursive: true },
      );
      const initial = await this.worker.process(
        "/usr/bin/git",
        [
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "-c",
          "core.hooksPath=/dev/null",
          "add",
          ".",
        ],
        join(this.root, "jobs", jobId, "project"),
        new AbortController().signal,
      );
      if (initial.exitCode) throw new Error(initial.text);
      const commit = await this.worker.process(
        "/usr/bin/git",
        [
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "-c",
          "core.hooksPath=/dev/null",
          "commit",
          "-m",
          "fixture",
        ],
        join(this.root, "jobs", jobId, "project"),
        new AbortController().signal,
      );
      if (commit.exitCode) throw new Error(commit.text);
    }
    return result;
  }
  async close(): Promise<void> {
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
    codeFixture?: boolean;
    noModel?: boolean;
    dataRoot?: string;
    workerOptions?: Partial<WorkerOptions>;
  } = {},
) {
  const root =
    options.dataRoot ?? (await mkdtemp(join(tmpdir(), "agent-test-")));
  for (const name of [
    "control/artifacts",
    "control/uploads",
    "control/secrets",
    "work",
  ])
    await mkdir(join(root, name), { recursive: true, mode: 0o700 });
  const config: Config = {
    schemaVersion: 1,
    dataRoot: root,
    expectedMountLabel: "AGENT_DATA",
    server: {
      host: "127.0.0.1",
      port: 8080,
      origins: ["http://127.0.0.1:8080"],
    },
    model: null,
    github: null,
    limits: { ...DEFAULT_LIMITS, commandSeconds: 10 },
    recoveryHold: false,
  };
  const faux = fauxProvider({
    tokensPerSecond: Infinity,
    models: [
      { id: "faux-1", input: ["text", "image"] },
      { id: "faux-2", input: ["text", "image"] },
    ],
  });
  faux.setResponses(responses);
  const runner =
    options.runner ??
    new TestRunner(
      join(root, "work"),
      options.codeFixture,
      options.workerOptions,
    );
  const service = await AgentService.open(config, {
    ...options,
    runner,
    provider: options.noModel ? undefined : (options.provider ?? faux.provider),
    modelId: options.modelId ?? "faux-1",
  });
  return { service, root, runner, faux, config };
}
export function jobInput(overrides: Partial<CreateJob> = {}): CreateJob {
  return {
    requestId: randomUUID(),
    title: "計算バグを修正",
    objective:
      "計算バグを修正し、テストして patch を納品してください。外部送信は禁止。",
    kind: "code",
    acceptance: ["テスト成功", "差分の納品"],
    project: "fixture",
    attachmentIds: [],
    externalAllowed: false,
    ...overrides,
  };
}
export async function untilJob(
  service: AgentService,
  id: string,
  predicate: (job: Job) => boolean,
  timeout = 12000,
): Promise<Job> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const job = await service.job(id);
    if (predicate(job)) return job;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(`Timed out: ${JSON.stringify(await service.job(id))}`);
}
export const codeResponses = (): FauxResponseStep[] => [
  call("validate_command", {
    command: "cd project && python3 -B -m unittest -v",
  }),
  call("read_file", { path: "project/calc.py" }),
  call("write_file", {
    path: "project/calc.py",
    text: "def total(values):\n    return sum(values)\n",
  }),
  call("validate_command", {
    command: "cd project && python3 -B -m unittest -v",
  }),
  call("make_patch", {}),
  call("publish_artifact", {
    path: "changes.patch",
    name: "changes.patch",
    mediaType: "text/x-diff",
  }),
  call("self_review", {
    evidence:
      "境界値の失敗を再現し、修正後は空・単一・複数の入力を検証しました。既存 API の名前は維持しています。patch を確認しました。",
  }),
  call("finish_job", {
    summary: "計算バグを修正し、テストと patch を納品しました。",
    limitations: [],
    criteria: ["テスト成功", "差分の納品"],
  }),
];
