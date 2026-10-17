import { randomUUID } from "node:crypto";
import {
  constants,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  opendirSync,
  fstatSync,
  type Stats,
} from "node:fs";
import { lstat, mkdir, open, rename } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import type { Paths } from "./config.js";
import { AgentError } from "./types.js";

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
function parsePin(path: string, name: string, deadline: number): SharedBlobPin {
  const stat = lstatSync(path);
  if (!safePinStat(stat))
    throw new AgentError("UNSAFE_STORAGE", "Unsafe shared blob pin");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let value: Record<string, unknown>;
  try {
    const opened = fstatSync(fd);
    if (!safePinStat(opened) || !sameIdentity(stat, opened))
      throw new AgentError(
        "UNSAFE_STORAGE",
        "Shared blob pin changed while opening",
      );
    const bytes = Buffer.alloc(maxBytes + 1);
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
      !safePinStat(after)
    )
      throw new AgentError(
        "UNSAFE_STORAGE",
        "Shared blob pin changed while reading",
      );
    const parsed: unknown = JSON.parse(
      bytes.subarray(0, length).toString("utf8"),
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new AgentError("UNSAFE_STORAGE", "Malformed shared blob pin");
    value = parsed as Record<string, unknown>;
  } finally {
    closeSync(fd);
  }
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
  let live = true;
  try {
    process.kill(pid, 0);
  } catch (error) {
    live = (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
  return {
    paths: [...paths].sort(),
    pid,
    processUuid: value.processUuid,
    live,
    file: name,
  };
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
