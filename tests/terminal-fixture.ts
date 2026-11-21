import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { relayWorkerTerminal } from "../src/execution/terminal.js";
import type { TerminalIO } from "../src/execution/terminal.js";
import { TestRunner } from "./support.js";

// Exercise the real relay and PTY without claiming sudo/cgroup isolation.
export class TerminalRunner extends TestRunner {
  starts = 0;
  async terminal(io: TerminalIO, signal: AbortSignal): Promise<void> {
    await mkdir(join(this.root, "home"), { recursive: true });
    signal.throwIfAborted();
    this.starts++;
    const worker = spawn(
      process.execPath,
      [resolve(".test-dist/tests/worker-child.js"), this.root],
      {
        env: { ...process.env, AGENT_TERMINAL_TEST_SECRET: "control-only" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    worker.stderr.resume();
    const end = () => worker.stdin.end();
    signal.addEventListener("abort", end, { once: true });
    try {
      await relayWorkerTerminal(worker, io);
    } finally {
      signal.removeEventListener("abort", end);
      end();
    }
  }
}
