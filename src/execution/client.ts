import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { operationGroup, removeGroup } from "./cgroup.js";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { readInstallation } from "../installation.js";
import { AppError } from "../security.js";
import { PROTOCOL_BYTES, replySchema } from "./protocol.js";
import type { Runner, WorkerRequest, WorkerResult } from "./protocol.js";

async function trusted(path: string): Promise<void> {
  for (let current = path; current !== "/"; current = dirname(current)) {
    const info = await lstat(current);
    if (info.uid !== 0 || (info.mode & 0o022) !== 0 || info.isSymbolicLink())
      throw new Error("Worker launcher is not root-owned and immutable");
  }
}
class WorkerProcess implements Runner {
  constructor(private readonly group?: string) {}
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<
    string,
    { resolve: (value: WorkerResult) => void; reject: (error: Error) => void }
  >();
  private opening?: Promise<void>;
  private buffer = Buffer.alloc(0);
  private broken = false;
  ready(): Promise<void> {
    return (this.opening ??= this.open());
  }
  private async open(): Promise<void> {
    if (this.broken)
      throw new AppError(
        503,
        "作業プロセスの状態確認が必要です。サービスを再起動してください",
      );
    if (this.child) return;
    const installation = await readInstallation();
    await trusted("/usr/local/libexec/agent-work");
    await trusted("/opt/agent-node/bin/node");
    await trusted("/opt/agent-python");
    const python = await realpath("/opt/agent-python/bin/python3");
    if (!python.startsWith("/opt/agent-python/"))
      throw new Error("Worker Python must use the installed runtime");
    await trusted(python);
    await trusted("/opt/agent/dist/src/execution/worker-main.js");
    await trusted("/run/agent-egress.ready");
    if (
      (await readFile("/run/agent-egress.ready", "utf8")).trim() !==
      `agent-work-egress-v2:${installation.workUid}`
    )
      throw new Error("Worker egress policy is unavailable");
    const command = [
      "/usr/bin/sudo",
      "-n",
      "-u",
      "agent-work",
      "--",
      "/usr/local/libexec/agent-work",
    ];
    // Move the control-owned child before sudo changes identity or starts work.
    // The work UID cannot write the delegated control user's cgroup files.
    if (this.group)
      command.unshift(
        "/bin/sh",
        "-ec",
        'echo 0 > "$1/cgroup.procs"; shift; exec "$@"',
        "agent-launch",
        this.group,
      );
    this.child = spawn(command[0]!, command.slice(1), {
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.on("data", (data: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, data]);
      if (this.buffer.length > PROTOCOL_BYTES) {
        this.fail();
        return;
      }
      let end: number;
      while ((end = this.buffer.indexOf(10)) >= 0) {
        try {
          const reply = replySchema.parse(
            JSON.parse(this.buffer.subarray(0, end).toString("utf8")),
          );
          this.buffer = this.buffer.subarray(end + 1);
          const pending = this.pending.get(reply.id);
          if (!pending) throw new Error("Unsolicited runner response");
          this.pending.delete(reply.id);
          if (reply.ok && reply.result) pending.resolve(reply.result);
          else
            pending.reject(
              new AppError(503, reply.error ?? "作業プロセスで失敗しました"),
            );
        } catch {
          this.fail();
          return;
        }
      }
    });
    // Worker stderr is intentionally not a service log channel.
    this.child.stderr.resume();
    this.child.stdin.on("error", () => this.fail());
    this.child.on("error", () => this.fail());
    this.child.on("exit", () => this.fail());
    const health = await this.call(randomUUID(), "health", {});
    if (
      health.uid !== installation.workUid ||
      health.uid === process.getuid?.() ||
      (this.group !== undefined &&
        health.cgroup !== "0::" + this.group.slice("/sys/fs/cgroup".length))
    ) {
      this.fail();
      throw new Error("Worker identity is not separated");
    }
  }
  private fail(): void {
    this.broken = true;
    for (const pending of this.pending.values())
      pending.reject(
        new AppError(
          503,
          "作業プロセスが応答しません。処理結果の確認が必要です",
        ),
      );
    this.pending.clear();
    this.child?.stdin.end();
  }

  async call(
    conversationId: string,
    op: WorkerRequest["op"],
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<WorkerResult> {
    if (!this.child || this.broken)
      throw new AppError(503, "作業環境を利用できません");
    if (signal?.aborted) throw new AppError(409, "処理は停止されています");
    const id = randomUUID(),
      wire = JSON.stringify({ id, conversationId, op, args }) + "\n";
    if (Buffer.byteLength(wire) > PROTOCOL_BYTES)
      throw new AppError(413, "作業入力が上限を超えています");
    let timer: NodeJS.Timeout | undefined;
    const cancel = () =>
      this.child?.stdin.write(JSON.stringify({ type: "cancel", id }) + "\n");
    try {
      return await new Promise<WorkerResult>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        signal?.addEventListener("abort", cancel, { once: true });
        if (signal?.aborted) cancel();
        timer = setTimeout(() => {
          cancel();
          this.fail();
        }, 330_000);
        this.child!.stdin.write(wire, (error) => {
          if (error) this.fail();
        });
      });
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    }
  }
  async close(): Promise<void> {
    if (
      !this.child ||
      this.child.exitCode !== null ||
      this.child.signalCode !== null
    )
      return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Worker shutdown was not confirmed")),
        5000,
      );
      this.child!.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      this.child!.stdin.end();
    });
  }
}

export class WorkerClient implements Runner {
  private readonly files = new WorkerProcess();
  private readonly operations = new Map<
    string,
    { controller: AbortController; finished: Promise<WorkerResult> }
  >();
  private broken = false;
  ready() {
    return this.files.ready();
  }

  async call(
    id: string,
    op: WorkerRequest["op"],
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<WorkerResult> {
    if (this.broken)
      throw new Error("Worker cleanup failed; restart the service");
    if (op === "cleanup") {
      const current = this.operations.get(id);
      current?.controller.abort();
      await current?.finished.catch(() => {});
      return { cleanup: !this.broken };
    }
    if (!["tool", "mcp_call", "mcp_list", "worktrees"].includes(op))
      return this.files.call(id, op, args, signal);
    if (this.operations.has(id))
      throw new Error("Session tool already running");
    const controller = new AbortController();
    const combined = signal
      ? AbortSignal.any([controller.signal, signal])
      : controller.signal;
    const finished = this.execute(id, op, args, combined);
    this.operations.set(id, { controller, finished });
    try {
      return await finished;
    } finally {
      this.operations.delete(id);
    }
  }

  private async execute(
    id: string,
    op: WorkerRequest["op"],
    args: Record<string, unknown>,
    signal: AbortSignal,
  ) {
    const group = await operationGroup();
    const worker = new WorkerProcess(group);
    try {
      await worker.ready();
      signal.throwIfAborted();
      // Membership is confirmed before cancellation can kill this cgroup.
      const cancel = () => {
        void writeFile(join(group, "cgroup.kill"), "1").catch(() =>
          worker.close().catch(() => {}),
        );
      };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        return await worker.call(id, op, args);
      } finally {
        signal.removeEventListener("abort", cancel);
      }
    } finally {
      try {
        await removeGroup(group);
      } catch (error) {
        this.broken = true;
        throw error;
      }
      await worker.close();
    }
  }

  async close() {
    for (const task of this.operations.values()) task.controller.abort();
    await Promise.allSettled(
      [...this.operations.values()].map((task) => task.finished),
    );
    await this.files.close();
    if (this.broken) throw new Error("Worker cleanup failed");
  }
}
