import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import type { Paths } from "./config.js";
import { AgentError } from "./types.js";

const known =
  /^(?:images\/[a-f0-9]{64}\.img|attachments\/(?:[a-f0-9]{64}\.raw|doc-[a-f0-9]{64}\.selected)|checkpoints\/blobs\/[a-f0-9]{64})$/;
const maxPaths = 5000;
const maxBytes = 4_000_000;
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
  await file.close();
}

export async function pinSharedBlobs(
  paths: Paths,
  relativePaths: string[],
): Promise<void> {
  if (relativePaths.length > maxPaths)
    throw new AgentError("DELETE_LIMIT", "Too many shared blob pins");
  for (const path of relativePaths) validateSharedBlobPath(path);
  const next = chain.then(async () => {
    await ensurePrivate(paths.home);
    await ensurePrivate(pinDirectory(paths));
    await ensureLock(lockPath(paths));
    const release = await lockfile.lock(lockPath(paths), {
      retries: 3,
      stale: 30_000,
    });
    try {
      let previous: string[] = [];
      const name = manifests.get(paths.home);
      if (name) {
        try {
          const value = JSON.parse(
            await readFile(join(pinDirectory(paths), name), "utf8"),
          ) as { paths?: unknown };
          if (Array.isArray(value.paths))
            previous = value.paths.filter(
              (path): path is string => typeof path === "string",
            );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      await writeManifest(paths, [...previous, ...relativePaths]);
    } finally {
      await release();
    }
  });
  chain = next.catch(() => {});
  await next;
}

export interface SharedBlobPin {
  paths: string[];
  pid: number;
  processUuid: string;
  live: boolean;
  file: string;
}

export async function readSharedBlobPins(
  paths: Paths,
): Promise<SharedBlobPin[]> {
  await ensurePrivate(paths.home);
  await ensurePrivate(pinDirectory(paths));
  const directory = await import("node:fs/promises").then((fs) =>
    fs.readdir(pinDirectory(paths)),
  );
  const result: SharedBlobPin[] = [];
  for (const name of directory) {
    const entry = { name };
    if (entry.name.length > 200 || !/^\d+-[0-9a-f-]+\.json$/.test(entry.name))
      throw new AgentError("UNSAFE_STORAGE", "Malformed shared blob pin");
    const stat = await lstat(join(pinDirectory(paths), entry.name));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
      throw new AgentError("UNSAFE_STORAGE", "Unsafe shared blob pin");
    const raw = JSON.parse(
      await readFile(join(pinDirectory(paths), entry.name), "utf8"),
    ) as Record<string, unknown>;
    const pidValue = raw.pid;
    if (
      raw.version !== 1 ||
      !Number.isSafeInteger(pidValue) ||
      (pidValue as number) < 1 ||
      typeof raw.processUuid !== "string" ||
      !Array.isArray(raw.paths) ||
      raw.paths.length > maxPaths
    )
      throw new AgentError("UNSAFE_STORAGE", "Malformed shared blob pin");
    const pid = pidValue as number;
    for (const path of raw.paths) validateSharedBlobPath(path);
    let live = true;
    try {
      process.kill(pid, 0);
    } catch (error) {
      live = (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
    result.push({
      paths: [...new Set(raw.paths as string[])].sort(),
      pid,
      processUuid: raw.processUuid,
      live,
      file: entry.name,
    });
  }
  return result;
}
