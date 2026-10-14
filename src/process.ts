import { spawn } from "node:child_process";
import { AgentError } from "./types.js";

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}
export interface ProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
  input?: string;
}
export async function runProcess(
  command: string,
  args: string[],
  options: ProcessOptions = {},
): Promise<ProcessResult> {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    let stdout = Buffer.alloc(0),
      stderr = Buffer.alloc(0),
      truncated = false,
      stopping = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const max = options.maxBytes ?? 64000;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGTERM");
      } catch {
        /* Already exited. */
      }
      killTimer = setTimeout(() => {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          /* Already exited. */
        }
      }, 500);
      killTimer.unref();
    };
    const timer = setTimeout(stop, options.timeoutMs ?? 120000);
    timer.unref();
    options.signal?.addEventListener("abort", stop, { once: true });
    const append = (stream: "stdout" | "stderr", chunk: Buffer) => {
      const value = stream === "stdout" ? stdout : stderr;
      if (value.length + chunk.length > max) truncated = true;
      const next = Buffer.concat([
        value,
        chunk.subarray(0, Math.max(0, max - value.length)),
      ]);
      if (stream === "stdout") stdout = next;
      else stderr = next;
    };
    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    const cleanup = () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", stop);
    };
    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
    child.on("close", (code) => {
      // Descendants must not outlive a tool call and race subsequent file operations.
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        /* Process group is empty. */
      }
      cleanup();
      if (options.signal?.aborted)
        reject(new AgentError("CANCELLED", "Operation cancelled"));
      else if (stopping)
        reject(new AgentError("TIMEOUT", "Command exceeded its time limit"));
      else
        resolve({
          code: code ?? 1,
          stdout: stdout.toString("utf8"),
          stderr: stderr.toString("utf8"),
          truncated,
        });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(options.input);
  });
}
export const cleanEnvironment: Record<string, string> = {
  PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  HOME: "/tmp",
  TMPDIR: "/tmp",
};
