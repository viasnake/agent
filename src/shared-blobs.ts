import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  opendirSync,
  fstatSync,
  fsyncSync,
  realpathSync,
  unlinkSync,
  type Stats,
} from "node:fs";
import { lstat, mkdir, open, rename } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import type { Paths } from "./config.js";
import { AgentError } from "./types.js";
import { canonical } from "./util.js";

const known =
  /^(?:images\/[a-f0-9]{64}\.img|attachments\/(?:[a-f0-9]{64}\.raw|doc-[a-f0-9]{64}\.selected)|checkpoints\/blobs\/[a-f0-9]{64})$/;
const maxPaths = 5000;
const maxBytes = 4_000_000;
const maxManifests = 10_000;
const maxAggregatePaths = 100_000;
const maxAggregateBytes = 64_000_000;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const processUuid = randomUUID();
const manifests = new Map<string, string>();
let chain: Promise<void> = Promise.resolve();

export function validateSharedBlobPath(path: string): void {
  if (typeof path !== "string" || path.length > 160 || !known.test(path))
    throw new AgentError("UNSAFE_STORAGE", "Unknown shared blob path");
}

function pinDirectory(paths: Paths): string {
  return join(paths.home, "shared-blob-pins");
}
function lockPath(paths: Paths): string {
  return join(paths.home, "shared-blob-pins.lock");
}

async function ensurePrivate(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new AgentError("UNSAFE_STORAGE", "Shared blob pin storage is unsafe");
}

async function writeManifest(
  paths: Paths,
  relativePaths: string[],
): Promise<void> {
  await ensurePrivate(paths.home);
  await ensurePrivate(pinDirectory(paths));
  let name = manifests.get(paths.home);
  if (!name) {
    name = `${process.pid}-${processUuid}.json`;
    manifests.set(paths.home, name);
  }
  const payload = JSON.stringify({
    version: 1,
    pid: process.pid,
    processUuid,
    paths: [...new Set(relativePaths)].sort(),
  });
  if (Buffer.byteLength(payload) > maxBytes)
    throw new AgentError(
      "DELETE_LIMIT",
      "Shared blob pin manifest is too large",
    );
  const target = join(pinDirectory(paths), name);
  const temporary = `${target}.${randomUUID()}.tmp`;
  const file = await open(
    temporary,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(payload);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, target);
  const directory = await open(pinDirectory(paths), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
async function ensureLock(path: string): Promise<void> {
  const file = await open(
    path,
    constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const stat = await file.stat();
    const current = await lstat(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid()) ||
      stat.dev !== current.dev ||
      stat.ino !== current.ino ||
      stat.size !== current.size
    )
      throw new AgentError("UNSAFE_STORAGE", "Shared blob lock is unsafe");
  } finally {
    await file.close();
  }
}
export function sharedBlobLockPath(paths: Paths): string {
  return lockPath(paths);
}
function ensurePrivateSync(path: string): void {
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new AgentError("UNSAFE_STORAGE", "Shared blob pin storage is unsafe");
}
export function ensureSharedBlobLockSync(paths: Paths): void {
  ensurePrivateSync(paths.home);
  const fd = openSync(
    lockPath(paths),
    constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const stat = lstatSync(lockPath(paths));
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o077) !== 0
    )
      throw new AgentError("UNSAFE_STORAGE", "Shared blob lock is unsafe");
  } finally {
    closeSync(fd);
  }
}
export async function withSharedBlobLock<T>(
  paths: Paths,
  work: () => Promise<T>,
): Promise<T> {
  const next = chain.then(async () => {
    await ensurePrivate(paths.home);
    await ensurePrivate(pinDirectory(paths));
    await ensureLock(lockPath(paths));
    const release = await lockfile.lock(lockPath(paths), {
      retries: 3,
      stale: 30_000,
    });
    try {
      return await work();
    } finally {
      await release();
    }
  });
  chain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

export async function pinSharedBlobs(
  paths: Paths,
  relativePaths: string[],
): Promise<void> {
  if (relativePaths.length > maxPaths)
    throw new AgentError("DELETE_LIMIT", "Too many shared blob pins");
  for (const path of relativePaths) validateSharedBlobPath(path);
  return withSharedBlobLock(paths, async () => {
    let previous: string[] = [];
    const name = manifests.get(paths.home);
    if (name) {
      try {
        previous =
          readSharedBlobPinsSync(paths).find((pin) => pin.file === name)
            ?.paths ?? [];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (new Set([...previous, ...relativePaths]).size > maxPaths)
      throw new AgentError(
        "DELETE_LIMIT",
        "Too many lifetime shared blob pins",
      );
    await writeManifest(paths, [...previous, ...relativePaths]);
  });
}

export interface SharedBlobPin {
  paths: string[];
  pid: number;
  processUuid: string;
  live: boolean;
  file: string;
}
function sameIdentity(a: Stats, b: Stats): boolean {
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
function safePinStat(stat: Stats): boolean {
  return (
    stat.isFile() &&
    !stat.isSymbolicLink() &&
    stat.nlink === 1 &&
    (stat.mode & 0o077) === 0 &&
    (process.getuid ? stat.uid === process.getuid() : true) &&
    stat.size <= maxBytes
  );
}
function readPinFile(
  path: string,
  deadline: number,
  beforeRead?: (bytes: number) => void,
): { data: Buffer; stat: Stats } {
  const stat = lstatSync(path);
  if (!safePinStat(stat))
    throw new AgentError("UNSAFE_STORAGE", "Unsafe shared blob pin");
  beforeRead?.(stat.size + 1);
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const opened = fstatSync(fd);
    if (!safePinStat(opened) || !sameIdentity(stat, opened))
      throw new AgentError(
        "UNSAFE_STORAGE",
        "Shared blob pin changed while opening",
      );
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      if (Date.now() >= deadline)
        throw new AgentError("DELETE_LIMIT", "Shared blob pin scan timed out");
      const read = readSync(fd, bytes, length, bytes.length - length, null);
      if (read === 0) break;
      length += read;
    }
    if (length > maxBytes)
      throw new AgentError("DELETE_LIMIT", "Shared blob pin is too large");
    const after = fstatSync(fd);
    const pathAfter = lstatSync(path);
    if (
      !sameIdentity(stat, after) ||
      !sameIdentity(stat, pathAfter) ||
      !safePinStat(after) ||
      length !== stat.size
    )
      throw new AgentError(
        "UNSAFE_STORAGE",
        "Shared blob pin changed while reading",
      );
    return { data: bytes.subarray(0, length), stat };
  } finally {
    closeSync(fd);
  }
}
function parsePin(path: string, name: string, deadline: number): SharedBlobPin {
  return decodePin(readPinFile(path, deadline).data, name);
}
function decodePin(data: Buffer, name: string): SharedBlobPin {
  const parsed: unknown = JSON.parse(data.toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new AgentError("UNSAFE_STORAGE", "Malformed shared blob pin");
  const value = parsed as Record<string, unknown>;
  const pid = value.pid;
  const expected = name.slice(0, -5);
  if (
    Object.keys(value).sort().join(",") !== "paths,pid,processUuid,version" ||
    value.version !== 1 ||
    typeof pid !== "number" ||
    !Number.isSafeInteger(pid) ||
    pid < 1 ||
    typeof value.processUuid !== "string" ||
    !uuidPattern.test(value.processUuid) ||
    expected !== `${pid}-${value.processUuid}` ||
    !Array.isArray(value.paths) ||
    value.paths.length > maxPaths ||
    new Set(value.paths).size !== value.paths.length ||
    !(value.paths as unknown[]).every(
      (item) => typeof item === "string" && item.length <= 160,
    )
  )
    throw new AgentError("UNSAFE_STORAGE", "Malformed shared blob pin");
  const paths = value.paths as string[];
  for (const relative of paths) validateSharedBlobPath(relative);
  if (paths.some((item, index) => index > 0 && paths[index - 1]! >= item))
    throw new AgentError(
      "UNSAFE_STORAGE",
      "Shared blob pins are not canonical",
    );
  return {
    paths: [...paths].sort(),
    pid,
    processUuid: value.processUuid,
    live: pinOwnerLive(pid),
    file: name,
  };
}
function pinOwnerLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
export function readSharedBlobPinsSync(
  paths: Paths,
  deadline = Date.now() + 10_000,
): SharedBlobPin[] {
  ensurePrivateSync(paths.home);
  try {
    lstatSync(pinDirectory(paths));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      mkdirSync(pinDirectory(paths), { mode: 0o700 });
    } catch (mkdirError) {
      if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST")
        throw mkdirError;
    }
  }
  ensurePrivateSync(pinDirectory(paths));
  const directory = opendirSync(pinDirectory(paths));
  const result: SharedBlobPin[] = [];
  let entries = 0;
  let totalBytes = 0;
  let totalPaths = 0;
  try {
    while (true) {
      if (Date.now() >= deadline)
        throw new AgentError("DELETE_LIMIT", "Shared blob pin scan timed out");
      const entry = directory.readSync();
      if (!entry) break;
      if (++entries > maxManifests)
        throw new AgentError(
          "DELETE_LIMIT",
          "Too many shared blob pin manifests",
        );
      const name = entry.name;
      const path = join(pinDirectory(paths), name);
      if (name.endsWith(".tmp")) {
        if (!/^\d+-[0-9a-f-]{36}\.json\.[0-9a-f-]{36}\.tmp$/.test(name))
          throw new AgentError(
            "UNSAFE_STORAGE",
            "Malformed shared blob pin temporary file",
          );
        const stat = lstatSync(path);
        if (!safePinStat(stat))
          throw new AgentError(
            "UNSAFE_STORAGE",
            "Unsafe shared blob pin temporary file",
          );
        totalBytes += stat.size;
        if (totalBytes > maxAggregateBytes)
          throw new AgentError(
            "DELETE_LIMIT",
            "Shared blob pin metadata is too large",
          );
        continue;
      }
      if (!/^\d+-[0-9a-f-]{36}\.json$/.test(name))
        throw new AgentError("UNSAFE_STORAGE", "Malformed shared blob pin");
      const stat = lstatSync(path);
      totalBytes += stat.size;
      if (totalBytes > maxAggregateBytes)
        throw new AgentError(
          "DELETE_LIMIT",
          "Shared blob pin metadata is too large",
        );
      const pin = parsePin(path, name, deadline);
      totalPaths += pin.paths.length;
      if (totalPaths > maxAggregatePaths)
        throw new AgentError("DELETE_LIMIT", "Too many shared blob pins");
      result.push(pin);
    }
  } finally {
    directory.closeSync();
  }
  return result.sort((a, b) => a.file.localeCompare(b.file));
}

export async function readSharedBlobPins(
  paths: Paths,
): Promise<SharedBlobPin[]> {
  await ensurePrivate(paths.home);
  await ensurePrivate(pinDirectory(paths));
  return readSharedBlobPinsSync(paths);
}

export const pinCleanupWarning =
  "終了を確認できたプロセスの添付保護記録だけを整理します。画像・資料・履歴は削除しません。生存・状態不明・不正な記録は保持し、推論・プロセス停止・自動再試行は行いません。";
type PinCandidate = {
  file: string;
  pid: number;
  temporary: boolean;
  bytes: number;
  fingerprint: string;
};
export interface PinCleanupPreview {
  selected: PinCandidate[];
  retained: { file: string; reason: string }[];
  offset: number;
  nextOffset?: number;
  scanned: number;
  limited: boolean;
  blocked: boolean;
  binding: string;
}
export interface PinCleanupResult {
  removed: string[];
  pending: { file: string; reason: string }[];
  syncFailed: boolean;
}
function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
function cleanupRoot(paths: Paths): string {
  ensurePrivateSync(paths.home);
  ensurePrivateSync(pinDirectory(paths));
  return digest(
    canonical(
      [paths.home, pinDirectory(paths)].map((path) => {
        const stat = lstatSync(path);
        return {
          path: realpathSync(path),
          dev: stat.dev,
          ino: stat.ino,
          uid: stat.uid,
          mode: stat.mode,
        };
      }),
    ),
  );
}
function cleanupCandidate(
  paths: Paths,
  file: string,
  deadline: number,
  beforeRead?: (bytes: number) => void,
): PinCandidate {
  const match = /^(\d+)-([0-9a-f-]{36})\.json(?:\.([0-9a-f-]{36})\.tmp)?$/.exec(
    file,
  );
  const pid = Number(match?.[1]);
  if (
    !match ||
    !Number.isSafeInteger(pid) ||
    pid < 1 ||
    !uuidPattern.test(match[2]!) ||
    (match[3] && !uuidPattern.test(match[3]))
  )
    throw new AgentError("UNSAFE_STORAGE", "Unknown pin file");
  if (pinOwnerLive(pid))
    throw new AgentError("PIN_LIVE", "Pin owner is live or unknown");
  const { data, stat } = readPinFile(
    join(pinDirectory(paths), file),
    deadline,
    beforeRead,
  );
  if (!match[3] && decodePin(data, file).live)
    throw new AgentError("PIN_LIVE", "Pin owner is live or unknown");
  return {
    file,
    pid,
    temporary: !!match[3],
    bytes: data.length,
    fingerprint: digest(
      canonical({
        dev: stat.dev,
        ino: stat.ino,
        size: stat.size,
        mtime: stat.mtimeMs,
        ctime: stat.ctimeMs,
        uid: stat.uid,
        mode: stat.mode,
        nlink: stat.nlink,
        hash: digest(data),
      }),
    ),
  };
}
function pinPreview(
  paths: Paths,
  files: string[],
  offset: number,
  deadline: number,
): PinCleanupPreview {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > 1_000_000 ||
    files.length > 500 ||
    new Set(files).size !== files.length ||
    files.some(
      (file) =>
        typeof file !== "string" ||
        file.length > 140 ||
        file.includes("/") ||
        file.includes("\\"),
    )
  )
    throw new AgentError(
      "DELETE_REQUEST",
      "保持記録は一度に500件まで、ファイル名だけを指定してください。",
    );
  const root = cleanupRoot(paths);
  const preview: PinCleanupPreview = {
    selected: [],
    retained: [],
    offset,
    scanned: 0,
    limited: false,
    blocked: false,
    binding: "",
  };
  const names = [...files];
  if (!files.length) {
    const directory = opendirSync(pinDirectory(paths));
    try {
      let index = 0;
      while (true) {
        if (Date.now() >= deadline)
          throw new AgentError(
            "DELETE_LIMIT",
            "保持記録の列挙が時間上限に達しました。",
          );
        const entry = directory.readSync();
        if (!entry) break;
        if (index++ < offset) continue;
        if (names.length === 500) {
          preview.nextOffset = offset + 500;
          break;
        }
        names.push(entry.name);
      }
    } finally {
      directory.closeSync();
    }
  }
  let bytes = 0;
  for (const file of names.sort()) {
    preview.scanned++;
    if (Date.now() >= deadline) {
      preview.limited = true;
      preview.retained.push({
        file,
        reason:
          "今回の時間・読取量の上限により未確認（名前を指定して再確認できます）",
      });
      continue;
    }
    try {
      const candidate = cleanupCandidate(paths, file, deadline, (size) => {
        if (bytes + size > maxAggregateBytes)
          throw new AgentError("PIN_LIMIT", "Pin read limit");
        bytes += size;
      });
      preview.selected.push(candidate);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "PIN_LIMIT" || code === "DELETE_LIMIT")
        preview.limited = true;
      preview.retained.push({
        file,
        reason:
          code === "PIN_LIVE"
            ? "稼働中、PID再利用、または終了を確認できません"
            : code === "PIN_LIMIT" || code === "DELETE_LIMIT"
              ? "読取量・時間の上限により未確認。名前を指定して再確認してください。"
              : "不正・変更済み・不明な記録のため保持します",
      });
    }
  }
  preview.blocked = !!files.length && !!preview.retained.length;
  if (cleanupRoot(paths) !== root)
    throw new AgentError("STALE_VIEW", "保持記録の保存場所が変化しました。");
  preview.binding = digest(canonical({ root, selected: preview.selected }));
  return preview;
}
export function previewPinCleanup(
  paths: Paths,
  files: string[] = [],
  offset = 0,
): Promise<PinCleanupPreview> {
  return withSharedBlobLock(paths, async () =>
    pinPreview(paths, files, offset, Date.now() + 10_000),
  );
}
export function confirmPinCleanup(
  paths: Paths,
  preview: PinCleanupPreview,
  signal: AbortSignal,
  beforeDelete: () => void = () => {},
): Promise<PinCleanupResult> {
  signal.throwIfAborted();
  return withSharedBlobLock(paths, async () => {
    signal.throwIfAborted();
    beforeDelete();
    if (preview.blocked)
      throw new AgentError(
        "DELETE_REQUEST",
        "選択に保持対象があります。選び直してください。",
      );
    const result: PinCleanupResult = {
      removed: [],
      pending: [],
      syncFailed: false,
    };
    if (!preview.selected.length) return result;
    const deadline = Date.now() + 10_000;
    const root = cleanupRoot(paths);
    const current = pinPreview(
      paths,
      preview.selected.map((item) => item.file),
      0,
      deadline,
    );
    if (current.blocked || current.binding !== preview.binding)
      throw new AgentError(
        "STALE_VIEW",
        "保持記録が変化しました。削除候補を選び直してください。",
      );
    for (let index = 0; index < current.selected.length; index++) {
      const item = current.selected[index]!;
      try {
        signal.throwIfAborted();
        beforeDelete();
        if (cleanupRoot(paths) !== root)
          throw new AgentError("STALE_VIEW", "Pin directory changed");
        const checked = cleanupCandidate(paths, item.file, deadline);
        if (
          checked.fingerprint !== item.fingerprint ||
          cleanupRoot(paths) !== root ||
          pinOwnerLive(item.pid)
        )
          throw new AgentError("STALE_VIEW", "Pin changed");
        signal.throwIfAborted();
        unlinkSync(join(pinDirectory(paths), item.file));
        if (
          lstatSync(join(pinDirectory(paths), item.file), {
            throwIfNoEntry: false,
          })
        )
          throw new AgentError(
            "STALE_VIEW",
            "Pin removal could not be verified",
          );
        result.removed.push(item.file);
      } catch {
        result.pending.push(
          ...current.selected.slice(index).map((pending) => ({
            file: pending.file,
            reason:
              "取消・状態変更・削除失敗のため未完了。候補を再確認してください。",
          })),
        );
        break;
      }
    }
    if (result.removed.length) {
      try {
        if (cleanupRoot(paths) !== root)
          throw new Error("Pin directory changed");
        const expected = lstatSync(pinDirectory(paths));
        const fd = openSync(
          pinDirectory(paths),
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          if (
            !sameIdentity(expected, fstatSync(fd)) ||
            cleanupRoot(paths) !== root
          )
            throw new Error("Pin directory changed");
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      } catch {
        result.syncFailed = true;
      }
    }
    return result;
  });
}
