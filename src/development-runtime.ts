import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";
import { AgentError, type Run, type Task } from "./types.js";
import { canonical, privateDirectory, safePath, sha256 } from "./util.js";

export function canUseProfiles(run: Run, task: Task): boolean {
  return (
    run.kind === "coding" &&
    run.access === "change" &&
    !task.delegatedBy &&
    task.purpose !== "synthesis" &&
    ((task.role === "worker" && task.write) || task.role === "reviewer")
  );
}

export async function developmentDirectory(
  runDirectory: string,
  run: Run,
  task: Task,
): Promise<string> {
  const parent = await safePath(runDirectory, "development", true);
  await privateDirectory(parent);
  const context = run.contextState;
  const scope = sha256(
    canonical({
      taskId: task.id,
      role: task.role,
      configHash: run.configHash,
      redactedImageIds: context?.redactedImageIds ?? [],
      excludedSourceIds: context?.excludedSourceIds ?? [],
      excludedSourceHashes: context?.excludedSourceHashes ?? [],
      excludedSourceUrls: context?.excludedSourceUrls ?? [],
    }),
  );
  const root = await safePath(parent, scope, true);
  await privateDirectory(root);
  return root;
}

// Runtime links are only consumed inside the sandbox, never traversed by host tooling.
export async function measureDevelopmentDirectory(
  root: string,
  maxBytes: number,
): Promise<{ bytes: number; entries: number }> {
  let bytes = 0,
    entries = 0;
  const deadline = Date.now() + 10_000;
  async function walk(path: string): Promise<void> {
    for await (const entry of await opendir(path)) {
      if (++entries > 20_000 || Date.now() > deadline)
        throw new AgentError(
          "DEVELOPMENT_SIZE",
          "Runtime scan exceeds its entry or time limit",
        );
      const target = join(path, entry.name);
      const stat = await lstat(target);
      if (stat.isDirectory()) await walk(target);
      else if (stat.isFile() || stat.isSymbolicLink()) {
        bytes += stat.size;
        if (bytes > maxBytes)
          throw new AgentError(
            "DEVELOPMENT_SIZE",
            "Runtime storage exceeds limits.maxWorkspaceBytes; review it before reusing this task",
          );
      } else
        throw new AgentError(
          "DEVELOPMENT_CONTENT",
          "Runtime contains an unsupported filesystem object",
        );
    }
  }
  await walk(root);
  return { bytes, entries };
}
