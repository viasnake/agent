import { Command } from "commander";
import { stdout } from "node:process";
import { loadConfig, paths, type Config, type Paths } from "../config.js";
import { Harness } from "../harness.js";
import { PiRuntime } from "../runtime/pi.js";
import { Store } from "../storage.js";
import { type Run } from "../types.js";
import { privateDirectory, terminalText } from "../util.js";

export function createCliContext(program: Command, signal: AbortSignal) {
  const collect = (value: string, previous: string[]) => [...previous, value];
  const print = (value: unknown) => {
    stdout.write(
      typeof value === "string" && !program.opts().json
        ? terminalText(value) + "\n"
        : JSON.stringify(value, null, 2) + "\n",
    );
  };
  const progress = (type: string, detail: Record<string, unknown>) => {
    process.stderr.write(
      program.opts().json
        ? JSON.stringify({ event: type, ...detail }) + "\n"
        : terminalText(
            `[${type}] ${Object.entries(detail)
              .map(([k, v]) => `${k}=${String(v)}`)
              .join(" ")}`,
          ) + "\n",
    );
  };
  async function context<T>(
    fn: (config: Config, p: Paths, store: Store) => Promise<T>,
  ): Promise<T> {
    const p = paths(program.opts().home);
    await privateDirectory(p.home);
    const config = await loadConfig(p),
      store = new Store(p);
    try {
      return await fn(config, p, store);
    } finally {
      store.close();
    }
  }
  function harness(config: Config, p: Paths, store: Store): Harness {
    return new Harness(config, p, store, new PiRuntime(config, p), progress);
  }
  function status(store: Store, run: Run): void {
    const usage = store.usage(run.id),
      artifacts = store.artifacts(run.id);
    if (program.opts().json)
      print({
        run,
        usage,
        connections: store.usageByConnection(run.id),
        artifacts,
        operations: store.operations(run.id),
      });
    else
      print(
        [
          `${run.id}  ${run.state}`,
          run.reason ?? run.objective,
          `${run.kind} / ${run.mode} / ${run.dataClass}${run.localOnly ? " / local-only" : ""}`,
          ...run.tasks.map(
            (t) =>
              `  ${t.id}: ${t.state} · ${t.model ?? "unassigned"} · attempt ${t.attempts}`,
          ),
          `Requests: ${usage.requests} · known API cost: $${usage.knownCostUsd.toFixed(4)} · unknown cost: ${usage.unknownCostRequests} · reserved: $${usage.heldUsd.toFixed(4)}`,
          `Artifacts: ${artifacts.length} · ${store.runDir(run.id)}`,
        ].join("\n"),
      );
  }
  function exitForRun(run: Run): void {
    process.exitCode =
      run.state === "succeeded"
        ? 0
        : run.state === "cancelled"
          ? 130
          : run.state.startsWith("waiting_")
            ? 2
            : 1;
  }
  return {
    program,
    signal,
    collect,
    print,
    progress,
    context,
    harness,
    status,
    exitForRun,
  };
}
export type CliContext = ReturnType<typeof createCliContext>;
