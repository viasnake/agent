import {
  readdir,
  lstat,
  mkdir,
  readFile,
  chmod,
  rm,
  copyFile,
} from "node:fs/promises";
import { join, dirname, relative, resolve } from "node:path";
import { createTwoFilesPatch } from "diff";
import { AgentError } from "./types.js";
import type { Config } from "./config.js";
import { atomicWrite, canonical, safePath, sha256, within } from "./util.js";
import { cleanEnvironment, runProcess } from "./process.js";

export interface FileEntry {
  hash: string;
  mode: number;
  bytes: number;
}
export interface Snapshot {
  extraPaths?: string[];
  origin?: string;
  head?: string;
  includeUntracked: boolean;
  files: Record<string, FileEntry>;
  redactedPaths?: string[];
}
export interface Change {
  path: string;
  before?: FileEntry;
  after?: FileEntry;
}
const excluded = new Set([
  ".git",
  ".aws",
  ".ssh",
  ".codex",
  ".agents",
  "node_modules",
  ".venv",
  "__pycache__",
]);
export function secretPath(path: string): boolean {
  return path
    .split("/")
    .some(
      (p) =>
        excluded.has(p) ||
        /^\.env(?:\.|$)/.test(p) ||
        /\.(?:pem|key|p12|pfx)$/i.test(p) ||
        /^(?:id_rsa|id_ed25519|credentials|auth\.json)$/.test(p),
    );
}
export async function inventory(
  root: string,
  maxBytes: number,
): Promise<Record<string, FileEntry>> {
  const files: Record<string, FileEntry> = {};
  let total = 0;
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name),
        rel = relative(root, path);
      if (secretPath(rel))
        throw new AgentError(
          "WORKSPACE_CONTENT",
          `Protected or credential-like path in working copy: ${rel}`,
        );
      const stat = await lstat(path);
      if (
        stat.isSymbolicLink() ||
        (!stat.isDirectory() && !stat.isFile()) ||
        (stat.isFile() && stat.nlink > 1)
      )
        throw new AgentError(
          "WORKSPACE_CONTENT",
          `Links and special files are not allowed: ${rel}`,
        );
      if (stat.isDirectory()) await walk(path);
      else {
        total += stat.size;
        if (total > maxBytes)
          throw new AgentError(
            "WORKSPACE_SIZE",
            "Workspace exceeds its configured byte limit",
          );
        files[rel] = {
          hash: sha256(await readFile(path)),
          mode: stat.mode & 0o777,
          bytes: stat.size,
        };
      }
    }
  }
  await walk(root);
  return files;
}
const gitEnv = {
  ...cleanEnvironment,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_OPTIONAL_LOCKS: "0",
};
async function originalFiles(
  root: string,
  includeUntracked: boolean,
): Promise<string[]> {
  const args = [
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.hooksPath=/dev/null",
    "ls-files",
    "-z",
    "--cached",
  ];
  if (includeUntracked) args.push("--others", "--exclude-standard");
  const result = await runProcess("git", args, {
    cwd: root,
    env: gitEnv,
    maxBytes: 8_000_000,
    timeoutMs: 10000,
  });
  if (result.code !== 0)
    throw new AgentError(
      "WORKSPACE",
      "Coding workspace must be a Git repository",
    );
  if (result.truncated)
    throw new AgentError(
      "WORKSPACE_SIZE",
      "Repository file list exceeds limit",
    );
  return [...new Set(result.stdout.split("\0").filter(Boolean))].sort();
}
export async function snapshotWorkspace(
  runDir: string,
  origin: string | undefined,
  includeUntracked: boolean,
  config: Config,
  extraPaths: string[] = [],
  redactedHashes: string[] = [],
): Promise<Snapshot> {
  const base = join(runDir, "baseline"),
    work = join(runDir, "work");
  await mkdir(base, { recursive: true, mode: 0o700 });
  await mkdir(work, { recursive: true, mode: 0o700 });
  const snapshot: Snapshot = {
    origin,
    includeUntracked,
    files: {},
    ...(extraPaths.length ? { extraPaths } : {}),
    redactedPaths: [],
  };
  let total = 0;
  if (origin) {
    const head = await runProcess("git", ["rev-parse", "--verify", "HEAD"], {
      cwd: origin,
      env: gitEnv,
      timeoutMs: 10000,
    });
    if (head.code === 0) snapshot.head = head.stdout.trim();
    for (const path of new Set([
      ...(await originalFiles(origin, includeUntracked)),
      ...extraPaths,
    ])) {
      if (secretPath(path)) continue;
      let source: string;
      try {
        source = await safePath(origin, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const stat = await lstat(source);
      if (!stat.isFile())
        throw new AgentError(
          "WORKSPACE_CONTENT",
          `Submodules and directories cannot be copied as files: ${path}`,
        );
      total += stat.size;
      if (total > config.limits.maxWorkspaceBytes)
        throw new AgentError(
          "WORKSPACE_SIZE",
          "Workspace exceeds its configured byte limit",
        );
      const content = await readFile(source);
      snapshot.files[path] = {
        hash: sha256(content),
        mode: stat.mode & 0o777,
        bytes: content.length,
      };
      await atomicWrite(join(base, path), content);
      await chmod(join(base, path), stat.mode & 0o777);
      if (redactedHashes.includes(snapshot.files[path]!.hash)) {
        snapshot.redactedPaths!.push(path);
        continue;
      }
      await atomicWrite(join(work, path), content);
      await chmod(join(work, path), stat.mode & 0o777);
    }
  }
  await atomicWrite(
    join(runDir, "snapshot.json"),
    JSON.stringify(snapshot, null, 2),
  );
  return snapshot;
}
export async function readSnapshot(runDir: string): Promise<Snapshot> {
  return JSON.parse(
    await readFile(join(runDir, "snapshot.json"), "utf8"),
  ) as Snapshot;
}
// Keep the original baseline while carrying forward the last private working copy.
// This makes every unapplied turn's diff cumulative and preserves origin conflict checks.
export async function continueWorkspace(
  parentDir: string,
  runDir: string,
  config: Config,
): Promise<void> {
  const snapshot = await readSnapshot(parentDir);
  if (snapshot.origin) await verifyOriginal(snapshot);
  await copyWorkspace(
    join(parentDir, "baseline"),
    join(runDir, "baseline"),
    config.limits.maxWorkspaceBytes,
  );
  await copyWorkspace(
    join(parentDir, "work"),
    join(runDir, "work"),
    config.limits.maxWorkspaceBytes,
  );
  await atomicWrite(join(runDir, "snapshot.json"), JSON.stringify(snapshot));
}
export async function sanitizeWorkCopy(
  runDir: string,
  hashes: string[],
  maxBytes: number,
): Promise<void> {
  const snapshot = await readSnapshot(runDir);
  const work = join(runDir, "work"),
    current = await inventory(work, maxBytes),
    redacted = new Set(snapshot.redactedPaths ?? []);
  for (const path of new Set([
    ...Object.keys(snapshot.files),
    ...Object.keys(current),
  ])) {
    const target = join(work, path);
    if (redacted.has(path)) {
      await rm(target, { recursive: true, force: true });
      continue;
    }
    if (current[path] && hashes.includes(current[path]!.hash)) {
      await rm(target);
      redacted.add(path);
    }
  }
  snapshot.redactedPaths = [...redacted].sort();
  await atomicWrite(join(runDir, "snapshot.json"), JSON.stringify(snapshot));
}
export function changes(
  before: Record<string, FileEntry>,
  after: Record<string, FileEntry>,
): Change[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .sort()
    .filter(
      (path) =>
        canonical(before[path] ?? null) !== canonical(after[path] ?? null),
    )
    .map((path) => ({ path, before: before[path], after: after[path] }));
}
export async function workspaceDiff(
  runDir: string,
  maxBytes: number,
): Promise<{ changes: Change[]; patch: string }> {
  const snapshot = await readSnapshot(runDir);
  const current = await inventory(join(runDir, "work"), maxBytes);
  const redacted = new Set(snapshot.redactedPaths ?? []);
  for (const path of redacted) {
    try {
      await lstat(join(runDir, "work", path));
      throw new AgentError(
        "IMAGE_REDACTED",
        `A redacted image path was reintroduced into the working copy: ${path}`,
      );
    } catch (error) {
      if (
        error instanceof AgentError ||
        (error as NodeJS.ErrnoException).code !== "ENOENT"
      )
        throw error;
    }
  }
  const delta = changes(snapshot.files, current).filter(
    (change) => !redacted.has(change.path),
  );
  let patch = "";
  for (const change of delta) {
    const before = change.before
      ? await readFile(join(runDir, "baseline", change.path))
      : Buffer.alloc(0);
    const after = change.after
      ? await readFile(join(runDir, "work", change.path))
      : Buffer.alloc(0);
    if (before.includes(0) || after.includes(0))
      throw new AgentError(
        "BINARY_CHANGE",
        `Binary modifications cannot be applied: ${change.path}`,
      );
    patch += createTwoFilesPatch(
      change.before ? `a/${change.path}` : "/dev/null",
      change.after ? `b/${change.path}` : "/dev/null",
      before.toString("utf8"),
      after.toString("utf8"),
      "",
      "",
    );
  }
  return { changes: delta, patch };
}
export async function copyWorkspace(
  source: string,
  target: string,
  maxBytes: number,
): Promise<void> {
  const files = await inventory(source, maxBytes);
  await mkdir(target, { recursive: true, mode: 0o700 });
  for (const [path, entry] of Object.entries(files)) {
    await mkdir(dirname(join(target, path)), { recursive: true, mode: 0o700 });
    await copyFile(join(source, path), join(target, path));
    await chmod(join(target, path), entry.mode);
  }
}
export async function verifyOriginal(snapshot: Snapshot): Promise<void> {
  if (!snapshot.origin)
    throw new AgentError("APPLY", "This run has no source workspace");
  const current: Record<string, FileEntry> = {};
  for (const path of new Set([
    ...(await originalFiles(snapshot.origin, snapshot.includeUntracked)),
    ...(snapshot.extraPaths ?? []),
  ])) {
    if (secretPath(path)) continue;
    try {
      const target = await safePath(snapshot.origin, path),
        stat = await lstat(target);
      current[path] = {
        hash: sha256(await readFile(target)),
        mode: stat.mode & 0o777,
        bytes: stat.size,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (canonical(current) !== canonical(snapshot.files))
    throw new AgentError(
      "WORKSPACE_CHANGED",
      "Source workspace changed since the run started; changes were not applied",
    );
  const head = await runProcess("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: snapshot.origin,
    env: gitEnv,
    timeoutMs: 10000,
  });
  if ((head.code === 0 ? head.stdout.trim() : undefined) !== snapshot.head)
    throw new AgentError(
      "WORKSPACE_CHANGED",
      "Source HEAD changed since the run started",
    );
}
export async function applyFiles(
  runDir: string,
  approved: Record<string, FileEntry>,
  config: Config,
  beforeWrite: () => void = () => {},
): Promise<Change[]> {
  const snapshot = await readSnapshot(runDir);
  const redacted = new Set(snapshot.redactedPaths ?? []);
  if (Object.keys(approved).some((path) => redacted.has(path)))
    throw new AgentError(
      "IMAGE_REDACTED",
      "A protected image path cannot be reintroduced into the working copy",
    );
  await verifyOriginal(snapshot);
  const work = join(runDir, "work");
  if (
    canonical(await inventory(work, config.limits.maxWorkspaceBytes)) !==
    canonical(approved)
  )
    throw new AgentError(
      "ARTIFACT_CHANGED",
      "Working copy changed after validation",
    );
  const delta = changes(snapshot.files, approved).filter(
    (change) => !redacted.has(change.path),
  );
  const origin = snapshot.origin!;
  // Check every target before touching any file, including previously untracked destinations.
  for (const change of delta) {
    const target = await safePath(origin, change.path, true);
    if (
      !change.before &&
      (await lstat(target).then(
        () => true,
        () => false,
      ))
    )
      throw new AgentError(
        "WORKSPACE_CHANGED",
        `Refusing to overwrite existing untracked file: ${change.path}`,
      );
  }
  await atomicWrite(
    join(runDir, "apply-manifest.json"),
    JSON.stringify(delta, null, 2),
  );
  for (const change of delta) {
    const target = await safePath(origin, change.path, true);
    if (!within(origin, target) || resolve(target) === resolve(origin))
      throw new AgentError("APPLY", "Invalid destination");
    beforeWrite();
    if (change.after) {
      const content = await readFile(await safePath(work, change.path));
      beforeWrite();
      await atomicWrite(target, content);
      await chmod(target, change.after.mode);
    } else await rm(target);
  }
  return delta;
}
