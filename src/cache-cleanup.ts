import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  lstat,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import type { Config, Paths } from "./config.js";
import { readSharedBlobPins, validateSharedBlobPath } from "./shared-blobs.js";
import { AgentError } from "./types.js";
import type { Store } from "./storage.js";
import { canonical, sha256 } from "./util.js";

const maxCandidates = 500;
const maxEntries = 10_000;
const grace = 86_400_000;
const kinds = [
  ["images", /^([a-f0-9]{64})\.img$/],
  ["attachments", /^([a-f0-9]{64})\.raw$/],
  ["attachments", /^doc-([a-f0-9]{64})\.selected$/],
  ["checkpoints/blobs", /^([a-f0-9]{64})$/],
] as const;
type Candidate = {
  path: string;
  bytes: number;
  identity: {
    dev: string;
    ino: string;
    size: number;
    mtimeMs: number;
    ctimeMs: number;
  };
  reason?: string;
};
export interface CacheCleanupRequest {
  kind: "selection" | "eligible";
  paths: string[];
  cutoff?: number;
}
export interface CacheCleanupPreview {
  request: CacheCleanupRequest;
  binding: string;
  selected: Candidate[];
  retained: Array<{ path: string; reason: string }>;
  moreCandidates: number;
}
export interface CacheCleanupResult {
  removed: string[];
  pending: Array<{ id: string; paths: string[]; error?: string }>;
}
type Job = {
  version: 1;
  id: string;
  paths: Array<{ path: string; identity: Candidate["identity"] }>;
  error?: string;
};
function idOf(stat: Awaited<ReturnType<typeof lstat>>): Candidate["identity"] {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: Number(stat.size),
    mtimeMs: Number(stat.mtimeMs),
    ctimeMs: Number(stat.ctimeMs),
  };
}
async function privateRoot(path: string): Promise<void> {
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.mode & 0o077 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new AgentError("UNSAFE_STORAGE", "Shared cache parent is unsafe");
}
async function references(store: Store): Promise<Set<string>> {
  const out = new Set<string>();
  for (const table of [
    "runs",
    "events",
    "operations",
    "requests",
    "artifacts",
    "cooldowns",
    "conversations",
    "conversation_runs",
    "messages",
    "source_links",
    "boundaries",
    "message_boundaries",
    "boundary_artifacts",
    "fork_lineages",
    "deletion_queue",
  ]) {
    const exists = store.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
      .get(table);
    if (!exists) continue;
    for (const row of store.db.prepare(`SELECT * FROM ${table}`).iterate()) {
      const text = canonical(row);
      for (const match of text.matchAll(/[a-f0-9]{64}/g)) out.add(match[0]);
    }
  }
  return out;
}
async function enumerate(paths: Paths, cutoff: number): Promise<Candidate[]> {
  const result: Candidate[] = [];
  let count = 0;
  for (const [relative, re] of kinds) {
    const directory = join(paths.home, relative);
    try {
      await privateRoot(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for await (const entry of await import("node:fs/promises").then((fs) =>
      fs.opendir(directory),
    )) {
      if (++count > maxEntries)
        throw new AgentError(
          "DELETE_LIMIT",
          "Shared cache contains too many entries",
        );
      if (!re.test(entry.name)) continue;
      const path = `${relative}/${entry.name}`;
      const stat = await lstat(join(paths.home, path));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) continue;
      if (stat.mtimeMs >= cutoff) continue;
      result.push({ path, bytes: stat.size, identity: idOf(stat) });
    }
  }
  return result;
}
function journalDir(paths: Paths): string {
  return join(paths.home, "cache-cleanup-jobs");
}
async function writeJob(paths: Paths, job: Job): Promise<void> {
  await mkdir(journalDir(paths), { recursive: true, mode: 0o700 });
  const target = join(journalDir(paths), `${job.id}.json`);
  const tmp = `${target}.${randomUUID()}.tmp`;
  const file = await open(
    tmp,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(JSON.stringify(job));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(tmp, target);
}
async function ensureLock(path: string): Promise<void> {
  const file = await open(
    path,
    constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  await file.close();
}
async function jobRows(paths: Paths): Promise<Job[]> {
  try {
    await privateRoot(journalDir(paths));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const entries = await readdir(journalDir(paths));
  const result: Job[] = [];
  for (const name of entries) {
    if (!/^[0-9a-f-]{36}\.json$/.test(name))
      throw new AgentError("UNSAFE_STORAGE", "Malformed cache cleanup job");
    const value = JSON.parse(
      await readFile(join(journalDir(paths), name), "utf8"),
    ) as Job;
    if (
      value.version !== 1 ||
      !/^[0-9a-f-]{36}$/.test(value.id) ||
      !Array.isArray(value.paths)
    )
      throw new AgentError("UNSAFE_STORAGE", "Malformed cache cleanup job");
    for (const item of value.paths) validateSharedBlobPath(item.path);
    result.push(value);
  }
  return result;
}
function binding(preview: Omit<CacheCleanupPreview, "binding">): string {
  return sha256(canonical(preview));
}
export async function previewCacheCleanup(
  store: Store,
  _config: Config,
  request: CacheCleanupRequest,
): Promise<CacheCleanupPreview> {
  if (
    request.kind === "selection" &&
    (!request.paths.length || request.paths.length > maxCandidates)
  )
    throw new AgentError(
      "DELETE_REQUEST",
      "Select between 1 and 500 cache paths",
    );
  const cutoff = request.cutoff ?? Date.now() - grace;
  const [all, refs, pins] = await Promise.all([
    enumerate(store.paths, cutoff),
    references(store),
    readSharedBlobPins(store.paths),
  ]);
  const pinned = new Set(pins.flatMap((pin) => pin.paths));
  const retained: CacheCleanupPreview["retained"] = [];
  const eligible = all.filter((item) => {
    const digestValue = item.path.match(/[a-f0-9]{64}/)?.[0];
    if (refs.has(digestValue ?? "")) {
      retained.push({
        path: item.path,
        reason: "データベースから参照されています",
      });
      return false;
    }
    if (pinned.has(item.path)) {
      retained.push({
        path: item.path,
        reason: "稼働中プロセスが保持しています",
      });
      return false;
    }
    return true;
  });
  const selectedPaths =
    request.kind === "selection"
      ? new Set(request.paths)
      : new Set(eligible.slice(0, maxCandidates).map((item) => item.path));
  const selected = eligible.filter((item) => selectedPaths.has(item.path));
  const preview = {
    request: { ...request, cutoff },
    selected,
    retained,
    moreCandidates: Math.max(0, eligible.length - selected.length),
  };
  return { ...preview, binding: binding(preview) };
}
export async function confirmCacheCleanup(
  store: Store,
  config: Config,
  preview: CacheCleanupPreview,
  signal?: AbortSignal,
): Promise<CacheCleanupResult> {
  signal?.throwIfAborted();
  const current = await previewCacheCleanup(store, config, preview.request);
  if (canonical(current) !== canonical(preview))
    throw new AgentError("STALE_VIEW", "Cache cleanup preview is stale");
  await ensureLock(join(store.paths.home, "shared-blob-pins.lock"));
  const release = await lockfile.lock(
    join(store.paths.home, "shared-blob-pins.lock"),
    { retries: 0, stale: 30_000 },
  );
  const id = randomUUID();
  try {
    const refs = await references(store);
    const pins = new Set(
      (await readSharedBlobPins(store.paths)).flatMap((pin) => pin.paths),
    );
    const paths = preview.selected.filter(
      (item) =>
        !refs.has(item.path.match(/[a-f0-9]{64}/)?.[0] ?? "") &&
        !pins.has(item.path),
    );
    const job: Job = {
      version: 1,
      id,
      paths: paths.map((item) => ({
        path: item.path,
        identity: item.identity,
      })),
    };
    await writeJob(store.paths, job);
    const removed: string[] = [];
    let error: string | undefined;
    for (const item of job.paths) {
      signal?.throwIfAborted();
      const stat = await lstat(join(store.paths.home, item.path)).catch(
        () => undefined,
      );
      if (!stat) {
        removed.push(item.path);
        continue;
      }
      if (
        String(stat.dev) !== item.identity.dev ||
        String(stat.ino) !== item.identity.ino
      ) {
        error = "ファイルの識別子が変わりました";
        continue;
      }
      try {
        await unlink(join(store.paths.home, item.path));
        removed.push(item.path);
      } catch (caught) {
        error =
          caught instanceof Error
            ? caught.message
            : "共有キャッシュの削除に失敗しました";
        job.error = error;
        await writeJob(store.paths, job);
        return {
          removed,
          pending: [{ id, paths: job.paths.map((entry) => entry.path), error }],
        };
      }
    }
    if (error) {
      job.error = error;
      await writeJob(store.paths, job);
      return {
        removed,
        pending: [{ id, paths: job.paths.map((entry) => entry.path), error }],
      };
    }
    await rm(join(journalDir(store.paths), `${id}.json`), { force: true });
    return { removed, pending: [] };
  } finally {
    await release();
  }
}
export async function pendingCacheCleanups(
  paths: Paths,
): Promise<Array<{ id: string; paths: string[]; error?: string }>> {
  return (await jobRows(paths)).map((job) => ({
    id: job.id,
    paths: job.paths.map((item) => item.path),
    ...(job.error ? { error: job.error } : {}),
  }));
}
export async function retryCacheCleanup(
  store: Store,
  config: Config,
  id: string,
  signal?: AbortSignal,
): Promise<CacheCleanupResult> {
  const jobs = await jobRows(store.paths);
  const job = jobs.find((entry) => entry.id === id);
  if (!job)
    throw new AgentError("NOT_FOUND", "Cache cleanup job does not exist");
  const preview = await previewCacheCleanup(store, config, {
    kind: "selection",
    paths: job.paths.map((entry) => entry.path),
  });
  return confirmCacheCleanup(store, config, preview, signal);
}
