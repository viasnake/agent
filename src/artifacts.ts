import { mkdir, readdir, readFile, realpath } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { Config, Paths } from "./config.js";
import { configHash } from "./config.js";
import { Sandbox } from "./sandbox.js";
import type { Store } from "./storage.js";
import { AgentError } from "./types.js";
import { atomicWrite, errorMessage, within } from "./util.js";
import { Evaluator } from "./validation.js";
import { applyFiles, readSnapshot, verifyOriginal } from "./workspace.js";
export async function exportArtifacts(
  store: Store,
  p: Paths,
  runId: string,
  target: string,
) {
  const artifacts = store.artifacts(runId);
  const requested = resolve(target);
  await mkdir(requested, { recursive: true, mode: 0o700 });
  const destination = await realpath(requested);
  const home = await realpath(p.home);
  if (within(home, destination) || within(destination, home))
    throw new AgentError("EXPORT", "Export must be outside agent storage");
  if ((await readdir(destination)).length)
    throw new AgentError("EXPORT", "Export directory must be empty");
  for (const artifact of artifacts)
    await atomicWrite(
      join(
        destination,
        `${artifact.kind}-${artifact.id}-${basename(artifact.name)
          .replace(/[^a-zA-Z0-9._-]/g, "_")
          .slice(0, 100)}`,
      ),
      await store.content(artifact),
    );
  await atomicWrite(
    join(destination, "manifest.json"),
    JSON.stringify(artifacts, null, 2),
  );
  return artifacts;
}
export async function applyRun(
  config: Config,
  store: Store,
  runId: string,
  dryRun = false,
  signal?: AbortSignal,
) {
  const run = store.claim(runId, true);
  let operation: string | undefined;
  let leaseError: unknown;
  const checkLease = () => {
    signal?.throwIfAborted();
    if (leaseError) throw leaseError;
    store.assertLease(run.id, run.generation);
  };
  const heartbeat = setInterval(() => {
    try {
      store.heartbeat(run);
    } catch (error) {
      leaseError = error;
    }
  }, 1000);
  heartbeat.unref();
  try {
    if (run.forkCheckpointId)
      throw new AgentError("FORK_SEED", "保存状態復元シードは適用できません。");
    if (run.state !== "succeeded" || run.kind !== "coding")
      throw new AgentError(
        "APPLY",
        "Only successful coding runs can be applied",
      );
    if (run.configHash !== configHash(config))
      throw new AgentError(
        "POLICY_CHANGED",
        "Restore the run configuration before applying",
      );
    const previous = store.operations(runId).filter((o) => o.name === "apply");
    if (previous.some((o) => o.status === "unknown"))
      throw new AgentError(
        "UNKNOWN_OPERATION",
        "Reconcile the previous apply before proceeding",
      );
    if (previous.some((o) => o.status === "completed")) {
      return { runId, alreadyApplied: true };
    }
    const directory = store.runDir(runId),
      evaluator = new Evaluator(config, store, new Sandbox(config.execution));
    await evaluator.verifyPublished(run);
    await verifyOriginal(await readSnapshot(directory));
    const approved = JSON.parse(
      await readFile(join(directory, "validated-manifest.json"), "utf8"),
    );
    if (dryRun) {
      return { runId, applicable: true };
    }
    checkLease();
    operation = store.prepare(run, "apply", "apply", { approved });
    store.operation(run, operation, "dispatched");
    const changed = await applyFiles(directory, approved, config, checkLease);
    store.operation(
      run,
      operation,
      "completed",
      JSON.stringify(changed.map((c) => c.path)),
    );
    return { runId, applied: changed.map((c) => c.path) };
  } catch (error) {
    if (operation)
      store.operation(run, operation, "unknown", errorMessage(error));
    throw error;
  } finally {
    clearInterval(heartbeat);
    store.release(run);
  }
}
