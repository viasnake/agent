import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
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
export class WorkerClient implements Runner {
  private child?: ChildProcessWithoutNullStreams;
  private pending?: {
    id: string;
    resolve: (value: WorkerResult) => void;
    reject: (error: Error) => void;
  };
  private buffer = Buffer.alloc(0);
  private broken = false;
  async ready(): Promise<void> {
    if (this.broken)
      throw new AppError(
        503,
        "作業プロセスの状態確認が必要です。サービスを再起動してください",
      );
    if (this.child) return;
    await trusted("/usr/local/libexec/agent-work");
    await trusted("/opt/agent-node/bin/node");
    await trusted("/opt/agent/dist/src/execution/worker-main.js");
    await trusted("/run/agent-egress.ready");
    if (
      (await readFile("/run/agent-egress.ready", "utf8")).trim() !==
      "agent-work-egress-v1"
    )
      throw new Error("Worker egress policy is unavailable");
    this.child = spawn(
      "/usr/bin/sudo",
      ["-n", "-u", "agent-work", "--", "/usr/local/libexec/agent-work"],
      {
        env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.child.stdout.on("data", (data: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, data]);
      if (this.buffer.length > PROTOCOL_BYTES) {
        this.fail();
        return;
      }
      const end = this.buffer.indexOf(10);
      if (end < 0) return;
      try {
        const reply = replySchema.parse(
          JSON.parse(this.buffer.subarray(0, end).toString("utf8")),
        );
        this.buffer = this.buffer.subarray(end + 1);
        const pending = this.pending;
        if (!pending || reply.id !== pending.id || this.buffer.length)
          throw new Error("Unsolicited runner response");
        this.pending = undefined;
        if (reply.ok && reply.result) pending.resolve(reply.result);
        else
          pending.reject(
            new AppError(503, reply.error ?? "作業プロセスで失敗しました"),
          );
      } catch {
        this.fail();
      }
    });
    // Worker stderr is intentionally not a service log channel.
    this.child.stderr.resume();
    this.child.on("error", () => this.fail());
    this.child.on("exit", () => this.fail());
    const health = await this.call(randomUUID(), "health", {});
    if (health.uid !== 981 || health.uid === process.getuid?.()) {
      this.fail();
      throw new Error("Worker identity is not separated");
    }
  }
  private fail(): void {
    this.broken = true;
    this.pending?.reject(
      new AppError(503, "作業プロセスが応答しません。処理結果の確認が必要です"),
    );
    this.pending = undefined;
  }
  async call(
    jobId: string,
    op: WorkerRequest["op"],
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<WorkerResult> {
    if (!this.child || this.broken || this.pending)
      throw new AppError(503, "作業環境を利用できません");
    if (signal?.aborted) throw new AppError(409, "処理は停止されています");
    const id = randomUUID(),
      wire = JSON.stringify({ id, jobId, op, args }) + "\n";
    if (Buffer.byteLength(wire) > PROTOCOL_BYTES)
      throw new AppError(413, "作業入力が上限を超えています");
    let timer: NodeJS.Timeout | undefined;
    const cancel = () =>
      this.child?.stdin.write(JSON.stringify({ type: "cancel", id }) + "\n");
    try {
      return await new Promise<WorkerResult>((resolve, reject) => {
        this.pending = { id, resolve, reject };
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
