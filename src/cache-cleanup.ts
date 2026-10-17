import { randomUUID } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { join, resolve } from "node:path";
import { configHash, type Config, type Paths } from "./config.js";
import {
  readSharedBlobPinsSync,
  withSharedBlobLock,
  validateSharedBlobPath,
} from "./shared-blobs.js";
import { snapshotMetadata } from "./metadata-snapshot.js";
import type { Store } from "./storage.js";
import { AgentError, terminalStates } from "./types.js";
import { canonical, sha256 } from "./util.js";

const maxCandidates = 500;
const maxEntries = 10_000;
const maxJobs = 500;
const maxJobBytes = 4_000_000;
const grace = 86_400_000;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const kinds = [
  ["images", /^([a-f0-9]{64})\.img$/],
  ["attachments", /^([a-f0-9]{64})\.raw$/],
  ["attachments", /^doc-([a-f0-9]{64})\.selected$/],
  ["checkpoints/blobs", /^([a-f0-9]{64})$/],
] as const;
const directoryKinds = [...new Set(kinds.map(([directory]) => directory))].map(
  (directory) => ({
    directory,
    patterns: kinds
      .filter(([candidateDirectory]) => candidateDirectory === directory)
      .map(([, pattern]) => pattern),
  }),
);
type Identity = {
  dev: string;
  ino: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  uid: number;
  mode: number;
  nlink: number;
};
type DirIdentity = { dev: string; ino: string; uid: number; mode: number };
type Candidate = {
  path: string;
  bytes: number;
  identity: Identity;
  root: DirIdentity;
  parent: DirIdentity;
  parentPath: string;
  ancestors: Record<string, DirIdentity>;
};
type Retained = { path: string; reason: string };
export interface CacheCleanupRequest {
  kind: "selection" | "eligible";
  paths: string[];
  cutoff?: number;
  owner?: { sessionId: string; owner: string; idleSaved?: boolean };
}
export interface CacheCleanupPreview {
  request: CacheCleanupRequest;
  binding: string;
  selected: Candidate[];
  retained: Array<{ path: string; reason: string }>;
  moreCandidates: number;
  jobId?: string;
  snapshot: string;
}
export interface CacheCleanupResult {
  removed: string[];
  pending: Array<{ id: string; paths: string[]; error?: string }>;
}
type JobEntry = {
  path: string;
  identity: Identity;
  root: DirIdentity;
  parent: DirIdentity;
  parentPath: string;
  ancestors: Record<string, DirIdentity>;
  status: "pending" | "removed" | "retained";
  reason?: string;
};
type Job = { version: 3; id: string; entries: JobEntry[]; error?: string };

function fail(message: string, code = "DELETE_REQUEST"): never {
  throw new AgentError(code, message);
}
function checkDeadline(deadline: number): void {
  if (Date.now() >= deadline)
    fail("共有キャッシュ処理の時間上限を超えました。", "DELETE_LIMIT");
}
function nowCutoff(cutoff: number | undefined): number {
  const now = Date.now();
  const value = cutoff ?? now - grace;
  if (!Number.isSafeInteger(value) || value > now - grace)
    fail("24時間以内の候補は削除できません。");
  return value;
}
function identity(stat: Stats): Identity {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: Number(stat.size),
    mtimeMs: Number(stat.mtimeMs),
    ctimeMs: Number(stat.ctimeMs),
    uid: stat.uid,
    mode: stat.mode,
    nlink: stat.nlink,
  };
}
function dirIdentity(stat: Stats): DirIdentity {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    uid: stat.uid,
    mode: stat.mode,
  };
}
function same(a: object, b: object): boolean {
  return canonical(a) === canonical(b);
}
function privateDirectory(path: string): DirIdentity {
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    fail(
      "共有キャッシュの root/parent が安全ではありません。",
      "UNSAFE_STORAGE",
    );
  return dirIdentity(stat);
}
function safeRoot(paths: Paths): DirIdentity {
  if (
    resolve(paths.attachments) !== join(resolve(paths.home), "attachments") ||
    resolve(paths.checkpoints) !== join(resolve(paths.home), "checkpoints")
  )
    fail("共有キャッシュの保存先設定が一致しません。", "UNSAFE_STORAGE");
  const home = privateDirectory(paths.home);
  realpathSync(paths.home);
  if (!same(home, dirIdentity(lstatSync(paths.home))))
    fail("共有キャッシュ root が変化しました。", "UNSAFE_STORAGE");
  return home;
}
function parents(paths: Paths, relative: string): Record<string, DirIdentity> {
  const root = safeRoot(paths);
  const home = realpathSync(paths.home);
  const result: Record<string, DirIdentity> = { "": root };
  let prefix = "";
  for (const part of relative.split("/")) {
    prefix = prefix ? `${prefix}/${part}` : part;
    const path = join(paths.home, prefix);
    result[prefix] = privateDirectory(path);
    if (realpathSync(path) !== join(home, prefix))
      fail(
        "共有キャッシュの親ディレクトリが保存領域外です。",
        "UNSAFE_STORAGE",
      );
  }
  return result;
}
function enumerate(
  paths: Paths,
  cutoff: number,
  deadline: number,
): { candidates: Candidate[]; retained: Retained[] } {
  const homeRoot = safeRoot(paths);
  const candidates: Candidate[] = [];
  const retained: Retained[] = [];
  let entries = 0;
  for (const { directory: relativeDir, patterns } of directoryKinds) {
    const directory = join(paths.home, relativeDir);
    try {
      parents(paths, relativeDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const handle = opendirSync(directory);
    try {
      const names: string[] = [];
      while (true) {
        checkDeadline(deadline);
        const item = handle.readSync();
        if (!item) break;
        if (++entries > maxEntries)
          fail(
            "共有キャッシュの directory entry 上限を超えました。",
            "DELETE_LIMIT",
          );
        names.push(item.name);
      }
      for (const name of names.sort()) {
        checkDeadline(deadline);
        const path = `${relativeDir}/${name}`;
        if (!patterns.some((pattern) => pattern.test(name))) {
          retained.push({ path, reason: "既知の共有 blob ではありません" });
          continue;
        }
        let stat: Stats;
        try {
          stat = lstatSync(join(paths.home, path));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            retained.push({ path, reason: "候補の検査中に消えました" });
            continue;
          }
          throw error;
        }
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.nlink !== 1 ||
          (stat.mode & 0o077) !== 0 ||
          (process.getuid && stat.uid !== process.getuid())
        ) {
          retained.push({ path, reason: "unsafe な file identity です" });
          continue;
        }
        if (stat.mtimeMs >= cutoff) {
          retained.push({ path, reason: "24時間以内に変更されています" });
          continue;
        }
        candidates.push({
          path,
          bytes: stat.size,
          identity: identity(stat),
          root: homeRoot,
          parent: dirIdentity(lstatSync(directory)),
          parentPath: relativeDir,
          ancestors: parents(paths, relativeDir),
        });
      }
    } finally {
      handle.closeSync();
    }
  }
  return { candidates, retained };
}
function journalDir(paths: Paths): string {
  return join(paths.home, "cache-cleanup-jobs");
}
function privateJournal(paths: Paths): void {
  const directory = journalDir(paths);
  try {
    lstatSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    mkdirSync(directory, { mode: 0o700 });
  }
  privateDirectory(directory);
}
function writeAtomic(paths: Paths, job: Job): void {
  privateJournal(paths);
  const target = join(journalDir(paths), `${job.id}.json`);
  const temporary = `${target}.${randomUUID()}.tmp`;
  const data = JSON.stringify(job);
  if (Buffer.byteLength(data) > maxJobBytes)
    fail("cleanup journal が大きすぎます。", "DELETE_LIMIT");
  const fd = openSync(
    temporary,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, target);
  const dir = openSync(journalDir(paths), "r");
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}
function validIdentity(value: unknown): value is Identity {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  if (
    Object.keys(item).sort().join(",") !==
    "ctimeMs,dev,ino,mode,mtimeMs,nlink,size,uid"
  )
    return false;
  return (
    ["dev", "ino"].every(
      (key) =>
        typeof item[key] === "string" && /^\d+$/.test(item[key] as string),
    ) &&
    ["size", "uid", "mode", "nlink"].every(
      (key) =>
        typeof item[key] === "number" &&
        Number.isSafeInteger(item[key]) &&
        (item[key] as number) >= 0,
    ) &&
    ["mtimeMs", "ctimeMs"].every(
      (key) => typeof item[key] === "number" && Number.isFinite(item[key]),
    )
  );
}
function validDir(value: unknown): value is DirIdentity {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).sort().join(",") !== "dev,ino,mode,uid") return false;
  return (
    typeof item.dev === "string" &&
    /^\d+$/.test(item.dev) &&
    typeof item.ino === "string" &&
    /^\d+$/.test(item.ino) &&
    ["uid", "mode"].every(
      (key) => typeof item[key] === "number" && Number.isSafeInteger(item[key]),
    )
  );
}
function sameStat(a: Stats, b: Stats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs &&
    a.uid === b.uid &&
    a.mode === b.mode &&
    a.nlink === b.nlink
  );
}
function readJournalFile(path: string): string {
  const before = lstatSync(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    (before.mode & 0o077) !== 0 ||
    (process.getuid && before.uid !== process.getuid()) ||
    before.size > maxJobBytes
  )
    fail("cleanup journal file が unsafe です。", "UNSAFE_STORAGE");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!sameStat(before, opened))
      fail("cleanup journal file が置き換えられました。", "UNSAFE_STORAGE");
    const buffer = Buffer.alloc(maxJobBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > maxJobBytes)
      fail("cleanup journal が大きすぎます。", "DELETE_LIMIT");
    const after = fstatSync(fd);
    const pathAfter = lstatSync(path);
    if (!sameStat(before, after) || !sameStat(before, pathAfter))
      fail(
        "cleanup journal file が読み取り中に変化しました。",
        "UNSAFE_STORAGE",
      );
    return buffer.subarray(0, length).toString("utf8");
  } finally {
    closeSync(fd);
  }
}
function readJobs(paths: Paths, deadline = Date.now() + 10_000): Job[] {
  privateJournal(paths);
  const handle = opendirSync(journalDir(paths));
  const names: string[] = [];
  let entries = 0;
  let bytes = 0;
  try {
    while (true) {
      const entry = handle.readSync();
      if (!entry) break;
      if (Date.now() >= deadline || ++entries > maxJobs + 100)
        fail("cleanup journal の件数上限を超えました。", "DELETE_LIMIT");
      bytes += lstatSync(join(journalDir(paths), entry.name)).size;
      if (bytes > 64_000_000)
        fail("cleanup journal の合計サイズ上限を超えました。", "DELETE_LIMIT");
      if (entry.name.endsWith(".tmp")) {
        if (!/^[0-9a-f-]{36}\.json\.[0-9a-f-]{36}\.tmp$/.test(entry.name))
          fail(
            "cleanup journal の temporary file が不正です。",
            "UNSAFE_STORAGE",
          );
        const temporary = lstatSync(join(journalDir(paths), entry.name));
        if (
          !temporary.isFile() ||
          temporary.isSymbolicLink() ||
          temporary.nlink !== 1 ||
          (temporary.mode & 0o077) !== 0 ||
          (process.getuid && temporary.uid !== process.getuid())
        )
          fail(
            "cleanup journal の temporary file が unsafe です。",
            "UNSAFE_STORAGE",
          );
        if (temporary.size > maxJobBytes)
          fail("cleanup journal が大きすぎます。", "DELETE_LIMIT");
        continue;
      }
      names.push(entry.name);
    }
  } finally {
    handle.closeSync();
  }
  if (names.length > maxJobs)
    fail("cleanup journal の件数上限を超えました。", "DELETE_LIMIT");
  names.sort();
  return names.map((name) => {
    checkDeadline(deadline);
    if (!name.endsWith(".json") || !uuidPattern.test(name.slice(0, -5)))
      fail("cleanup journal の名前が不正です。", "UNSAFE_STORAGE");
    const raw = readJournalFile(join(journalDir(paths), name));
    if (Buffer.byteLength(raw) > maxJobBytes)
      fail("cleanup journal が大きすぎます。", "DELETE_LIMIT");
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      fail("cleanup journal の JSON が不正です。", "UNSAFE_STORAGE");
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      fail("cleanup journal の JSON が不正です。", "UNSAFE_STORAGE");
    const id = name.slice(0, -5);
    if (
      Object.keys(value).sort().join(",") !== "entries,id,version" &&
      Object.keys(value).sort().join(",") !== "entries,error,id,version"
    )
      fail("cleanup journal に未知の field があります。", "UNSAFE_STORAGE");
    if (
      value.version !== 3 ||
      value.id !== id ||
      !Array.isArray(value.entries) ||
      !value.entries.length ||
      value.entries.length > maxCandidates
    )
      fail("cleanup journal の形式が不正です。", "UNSAFE_STORAGE");
    if (
      "error" in value &&
      (typeof value.error !== "string" || value.error.length > 2000)
    )
      fail("cleanup journal の error が不正です。", "UNSAFE_STORAGE");
    const entryPaths = new Set<string>();
    for (const entry of value.entries) {
      if (!entry || typeof entry !== "object")
        fail("cleanup journal の entry が不正です。", "UNSAFE_STORAGE");
      const item = entry as Record<string, unknown>;
      if (
        Object.keys(item).sort().join(",") !==
          "ancestors,identity,parent,parentPath,path,root,status" &&
        Object.keys(item).sort().join(",") !==
          "ancestors,identity,parent,parentPath,path,reason,root,status"
      )
        fail(
          "cleanup journal の entry に未知の field があります。",
          "UNSAFE_STORAGE",
        );
      if (
        typeof item.path !== "string" ||
        typeof item.parentPath !== "string" ||
        !validIdentity(item.identity) ||
        !validDir(item.root) ||
        !validDir(item.parent) ||
        !["pending", "removed", "retained"].includes(String(item.status))
      )
        fail("cleanup journal の identity が不正です。", "UNSAFE_STORAGE");
      validateSharedBlobPath(item.path);
      if (entryPaths.has(item.path))
        fail("cleanup journal に重複 path があります。", "UNSAFE_STORAGE");
      entryPaths.add(item.path);
      const expectedParent = item.path.slice(0, item.path.lastIndexOf("/"));
      const ancestorKeys = [
        "",
        ...expectedParent
          .split("/")
          .map((_, index, parts) => parts.slice(0, index + 1).join("/")),
      ].sort();
      if (
        item.parentPath !== expectedParent ||
        !item.ancestors ||
        typeof item.ancestors !== "object" ||
        !same(Object.keys(item.ancestors).sort(), ancestorKeys) ||
        !Object.values(item.ancestors).every(validDir) ||
        (item.status === "retained" &&
          (typeof item.reason !== "string" || item.reason.length > 1000)) ||
        (item.status !== "retained" && "reason" in item)
      )
        fail("cleanup journal の path/理由が不正です。", "UNSAFE_STORAGE");
    }
    return value as unknown as Job;
  });
}
function safety(store: Store, request: CacheCleanupRequest): void {
  for (const table of ["operations", "requests"]) {
    const statuses =
      table === "operations"
        ? ["prepared", "dispatched", "unknown"]
        : ["reserved", "unknown"];
    const row = store.db
      .prepare(
        `SELECT 1 FROM ${table} WHERE status IN (${statuses.map(() => "?").join(",")}) LIMIT 1`,
      )
      .get(...statuses);
    if (row)
      fail(
        "未解決の operation/request があるため削除できません。",
        "SESSION_BUSY",
      );
  }
  const liveRun = store.db
    .prepare(
      `SELECT id FROM runs WHERE heartbeat> ? OR state NOT IN (${terminalStates.map(() => "?").join(",")}) LIMIT 1`,
    )
    .get(Date.now() - 15_000, ...terminalStates);
  if (liveRun)
    fail("稼働中の実行があるため共有 cache を削除できません。", "SESSION_BUSY");
  const active = store.db
    .prepare(
      "SELECT id,owner,heartbeat FROM conversations WHERE owner IS NOT NULL AND heartbeat>?",
    )
    .all(Date.now() - 15_000) as Array<{
    id: string;
    owner: string;
    heartbeat: number;
  }>;
  for (const row of active) {
    if (
      !request.owner ||
      row.id !== request.owner.sessionId ||
      row.owner !== request.owner.owner ||
      !request.owner.idleSaved
    )
      fail("稼働中の会話があるため削除できません。", "SESSION_BUSY");
  }
  if (
    request.owner &&
    !active.some(
      (row) =>
        row.id === request.owner!.sessionId &&
        row.owner === request.owner!.owner,
    )
  )
    fail("現在の会話の所有権を確認できません。", "SESSION_BUSY");
}
function previewValue(
  store: Store,
  config: Config,
  request: CacheCleanupRequest,
  deadline = Date.now() + 10_000,
): Omit<CacheCleanupPreview, "binding"> {
  if (
    !request ||
    (request.kind !== "selection" && request.kind !== "eligible") ||
    !Array.isArray(request.paths) ||
    request.paths.some((path) => typeof path !== "string")
  )
    fail("cache cleanup request の形式が不正です。");
  if (request.kind === "eligible" && request.paths.length)
    fail("eligible cleanup に明示 path は指定できません。");
  const cutoff = nowCutoff(request.cutoff);
  const paths = [...new Set(request.paths)];
  if (
    request.kind === "selection" &&
    (paths.length === 0 ||
      paths.length > maxCandidates ||
      paths.some((path) => typeof path !== "string"))
  )
    fail("選択は1〜500件の既知相対パスで指定してください。");
  if (paths.length !== request.paths.length)
    fail("重複した cache path は指定できません。");
  for (const path of paths) validateSharedBlobPath(path);
  safety(store, request);
  const state = snapshotMetadata(store.db, deadline);
  const enumerated = enumerate(store.paths, cutoff, deadline);
  const all = enumerated.candidates;
  const pins = readSharedBlobPinsSync(store.paths, deadline);
  const pinned = new Set(
    pins.filter((pin) => pin.live).flatMap((pin) => pin.paths),
  );
  const retained: CacheCleanupPreview["retained"] = [...enumerated.retained];
  const eligible = all.filter((item) => {
    const digest = item.path.match(/[a-f0-9]{64}/)?.[0];
    if (state.referencedDigests.has(digest ?? "")) {
      retained.push({
        path: item.path,
        reason: "メタデータから参照されています",
      });
      return false;
    }
    if (pinned.has(item.path)) {
      retained.push({
        path: item.path,
        reason: "プロセス lifetime pin があります",
      });
      return false;
    }
    return true;
  });
  const byPath = new Map(all.map((item) => [item.path, item]));
  const eligiblePaths = new Set(eligible.map((item) => item.path));
  let selected: Candidate[];
  let moreCandidates = 0;
  if (request.kind === "selection") {
    for (const path of paths) {
      if (!byPath.has(path)) fail(`選択対象が見つかりません: ${path}`);
      if (!eligiblePaths.has(path)) fail(`選択対象は保持されています: ${path}`);
    }
    selected = paths.map((path) => byPath.get(path)!);
  } else {
    selected = eligible.slice(0, maxCandidates);
    moreCandidates = Math.max(0, eligible.length - selected.length);
  }
  return {
    request: { ...request, paths, cutoff },
    selected,
    retained,
    moreCandidates,
    snapshot: sha256(
      canonical({
        metadata: state.binding,
        pins,
        home: realpathSync(store.paths.home),
        config: configHash(config),
      }),
    ),
  };
}
export async function previewCacheCleanup(
  store: Store,
  config: Config,
  request: CacheCleanupRequest,
): Promise<CacheCleanupPreview> {
  return withSharedBlobLock(store.paths, async () => {
    const preview = store.transaction(() =>
      previewValue(store, config, request),
    );
    return { ...preview, binding: sha256(canonical(preview)) };
  });
}
function currentMatches(
  store: Store,
  config: Config,
  preview: CacheCleanupPreview,
  deadline: number,
): void {
  const current = previewValue(store, config, preview.request, deadline);
  if (
    canonical({ ...current, binding: sha256(canonical(current)) }) !==
    canonical(preview)
  )
    fail("共有 cache preview が stale です。", "STALE_VIEW");
}
function pendingResult(job: Job): CacheCleanupResult {
  return {
    removed: job.entries
      .filter((entry) => entry.status === "removed")
      .map((entry) => entry.path),
    pending: job.entries.some((entry) => entry.status !== "removed")
      ? [
          {
            id: job.id,
            paths: job.entries
              .filter((entry) => entry.status !== "removed")
              .map((entry) => entry.path),
            ...(job.error ? { error: job.error } : {}),
          },
        ]
      : [],
  };
}
function jobPreview(job: Job): Omit<CacheCleanupPreview, "binding"> {
  const entries = job.entries.filter((entry) => entry.status !== "removed");
  return {
    request: {
      kind: "selection",
      paths: entries.map((entry) => entry.path),
      cutoff: 0,
    },
    selected: entries.map((entry) => ({
      path: entry.path,
      bytes: entry.identity.size,
      identity: entry.identity,
      root: entry.root,
      parent: entry.parent,
      parentPath: entry.parentPath,
      ancestors: entry.ancestors,
    })),
    retained: job.entries
      .filter((entry) => entry.status === "retained")
      .map((entry) => ({
        path: entry.path,
        reason: entry.reason ?? "前回の削除で保留しました",
      })),
    moreCandidates: 0,
    jobId: job.id,
    snapshot: sha256(canonical(job)),
  };
}
function retryValue(
  store: Store,
  config: Config,
  job: Job,
  owner?: CacheCleanupRequest["owner"],
  cutoff?: number,
  deadline = Date.now() + 10_000,
): Omit<CacheCleanupPreview, "binding"> {
  const state = previewValue(
    store,
    config,
    { kind: "eligible", paths: [], owner, cutoff },
    deadline,
  );
  const references = snapshotMetadata(store.db, deadline).referencedDigests;
  const pins = new Set(
    readSharedBlobPinsSync(store.paths, deadline)
      .filter((pin) => pin.live)
      .flatMap((pin) => pin.paths),
  );
  const preview = jobPreview(job);
  preview.request.owner = owner;
  preview.request.cutoff = state.request.cutoff;
  preview.retained = [];
  preview.selected = preview.selected.filter((entry) => {
    checkDeadline(deadline);
    let reason: string | undefined;
    if (references.has(entry.path.match(/[a-f0-9]{64}/)![0]))
      reason = "再参照されています";
    else if (pins.has(entry.path)) reason = "稼働中プロセスが保持しています";
    else {
      try {
        if (!same(parents(store.paths, entry.parentPath), entry.ancestors))
          reason = "親ディレクトリが変わりました";
        else {
          try {
            if (
              !same(
                identity(lstatSync(join(store.paths.home, entry.path))),
                entry.identity,
              )
            )
              reason = "ファイルが置き換えられました";
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT")
              reason = "ファイルを安全に確認できません";
          }
        }
      } catch {
        reason = "保存領域を安全に確認できません";
      }
    }
    if (reason) preview.retained.push({ path: entry.path, reason });
    return !reason;
  });
  preview.snapshot = sha256(
    canonical({ job, state, retained: preview.retained }),
  );
  return preview;
}
export async function previewCacheCleanupJob(
  store: Store,
  config: Config,
  id: string,
  owner?: CacheCleanupRequest["owner"],
): Promise<CacheCleanupPreview> {
  if (!uuidPattern.test(id)) fail("cleanup job ID が不正です。");
  return withSharedBlobLock(store.paths, async () =>
    store.transaction(() => {
      const deadline = Date.now() + 10_000;
      const job = readJobs(store.paths, deadline).find(
        (item) => item.id === id,
      );
      if (!job) fail("cache cleanup job が存在しません。", "NOT_FOUND");
      const preview = retryValue(
        store,
        config,
        job,
        owner,
        undefined,
        deadline,
      );
      return { ...preview, binding: sha256(canonical(preview)) };
    }),
  );
}
function processJob(
  store: Store,
  job: Job,
  deadline: number,
  signal?: AbortSignal,
): CacheCleanupResult {
  const refs = snapshotMetadata(store.db, deadline).referencedDigests;
  const pins = new Set(
    readSharedBlobPinsSync(store.paths, deadline)
      .filter((pin) => pin.live)
      .flatMap((pin) => pin.paths),
  );
  for (const entry of job.entries) {
    if (entry.status !== "pending") continue;
    if (signal?.aborted || Date.now() >= deadline) {
      job.error = "処理が中断されたか、時間上限に達しました。";
      writeAtomic(store.paths, job);
      return pendingResult(job);
    }
    const digest = entry.path.match(/[a-f0-9]{64}/)?.[0] ?? "";
    if (refs.has(digest) || pins.has(entry.path)) {
      entry.status = "retained";
      entry.reason = refs.has(digest)
        ? "再参照されました"
        : "pin が追加されました";
      writeAtomic(store.paths, job);
      continue;
    }
    try {
      if (!same(parents(store.paths, entry.parentPath), entry.ancestors))
        fail("親ディレクトリが置き換えられました。", "UNSAFE_STORAGE");
    } catch {
      entry.status = "retained";
      entry.reason = "保存領域または親ディレクトリが変わりました";
      writeAtomic(store.paths, job);
      continue;
    }
    let stat;
    try {
      stat = lstatSync(join(store.paths.home, entry.path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        entry.status = "removed";
        writeAtomic(store.paths, job);
        continue;
      }
      entry.status = "retained";
      entry.reason = "対象を安全に検査できません";
      job.error = String((error as Error).message).slice(0, 2000);
      writeAtomic(store.paths, job);
      continue;
    }
    let parent: Stats;
    let root: Stats;
    try {
      parent = lstatSync(join(store.paths.home, entry.parentPath));
      root = lstatSync(store.paths.home);
    } catch (error) {
      entry.status = "retained";
      entry.reason = "parent/root を安全に検査できません";
      job.error = String((error as Error).message).slice(0, 2000);
      writeAtomic(store.paths, job);
      return pendingResult(job);
    }
    if (
      !same(identity(stat), entry.identity) ||
      !same(dirIdentity(parent), entry.parent) ||
      !same(dirIdentity(root), entry.root)
    ) {
      entry.status = "retained";
      entry.reason = "ファイルまたは parent identity が変わりました";
      writeAtomic(store.paths, job);
      continue;
    }
    if (Date.now() >= deadline) {
      job.error = "時間上限に達したため、残りの処理を保留しました。";
      writeAtomic(store.paths, job);
      return pendingResult(job);
    }
    try {
      unlinkSync(join(store.paths.home, entry.path));
      const fd = openSync(join(store.paths.home, entry.parentPath), "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      entry.status = "removed";
      writeAtomic(store.paths, job);
    } catch (error) {
      entry.status = "retained";
      entry.reason = "unlink に失敗したため保留しています";
      job.error = String((error as Error).message).slice(0, 2000);
      writeAtomic(store.paths, job);
      return pendingResult(job);
    }
  }
  if (job.entries.every((entry) => entry.status === "removed")) {
    unlinkSync(join(journalDir(store.paths), `${job.id}.json`));
    const dir = openSync(journalDir(store.paths), "r");
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
    return pendingResult(job);
  }
  return pendingResult(job);
}
export async function confirmCacheCleanup(
  store: Store,
  config: Config,
  preview: CacheCleanupPreview,
  signal?: AbortSignal,
  options?: {
    beforeCommit?: () => void;
    owner?: CacheCleanupRequest["owner"];
  },
): Promise<CacheCleanupResult> {
  signal?.throwIfAborted();
  return withSharedBlobLock(store.paths, async () => {
    signal?.throwIfAborted();
    options?.beforeCommit?.();
    return store.transaction(() => {
      const deadline = Date.now() + 10_000;
      options?.beforeCommit?.();
      if (preview.jobId) {
        safety(store, {
          kind: "selection",
          paths: [],
          owner: options?.owner,
        });
        const job = readJobs(store.paths, deadline).find(
          (item) => item.id === preview.jobId,
        );
        if (!job) fail("cache cleanup job が存在しません。", "NOT_FOUND");
        const current = retryValue(
          store,
          config,
          job,
          options?.owner,
          preview.request.cutoff,
          deadline,
        );
        if (
          canonical({ ...current, binding: sha256(canonical(current)) }) !==
          canonical(preview)
        )
          fail("cache cleanup retry preview が stale です。", "STALE_VIEW");
        for (const entry of job.entries)
          if (entry.status === "retained") {
            entry.status = "pending";
            delete entry.reason;
          }
        return processJob(store, job, deadline, signal);
      }
      currentMatches(store, config, preview, deadline);
      if (!preview.selected.length) fail("削除対象がありません。");
      const job: Job = {
        version: 3,
        id: randomUUID(),
        entries: preview.selected.map((entry) => ({
          path: entry.path,
          identity: entry.identity,
          root: entry.root,
          parent: entry.parent,
          parentPath: entry.parentPath,
          ancestors: entry.ancestors,
          status: "pending" as const,
        })),
      };
      writeAtomic(store.paths, job);
      return processJob(store, job, deadline, signal);
    });
  });
}
export async function pendingCacheCleanups(
  paths: Paths,
): Promise<Array<{ id: string; paths: string[]; error?: string }>> {
  return readJobs(paths)
    .filter((job) => job.entries.some((entry) => entry.status !== "removed"))
    .map((job) => ({
      id: job.id,
      paths: job.entries
        .filter((entry) => entry.status !== "removed")
        .map((entry) => entry.path),
      ...(job.error ? { error: job.error } : {}),
    }));
}
export async function retryCacheCleanup(
  store: Store,
  config: Config,
  id: string,
  signal?: AbortSignal,
): Promise<CacheCleanupResult> {
  signal?.throwIfAborted();
  const preview = await previewCacheCleanupJob(store, config, id);
  return confirmCacheCleanup(store, config, preview, signal);
}
