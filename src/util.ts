import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  mkdir,
  writeFile,
  rename,
  lstat,
  realpath,
  chmod,
  open,
  rm,
} from "node:fs/promises";
import { dirname, resolve, relative, isAbsolute, join } from "node:path";
import { AgentError } from "./types.js";

export const id = () => randomUUID();
export const sha256 = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function within(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return (
    rel === "" ||
    (!rel.startsWith(".." + "/") && rel !== ".." && !isAbsolute(rel))
  );
}
export async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  ) {
    throw new AgentError(
      "UNSAFE_STORAGE",
      `Storage directory must be owned by you and mode 0700: ${path}`,
    );
  }
}
export async function atomicWrite(
  path: string,
  data: string | Buffer,
  mode = 0o600,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${id()}.tmp`;
  try {
    await writeFile(temporary, data, { mode: 0o600, flag: "wx" });
    const file = await open(temporary, "r");
    try {
      await file.sync();
    } finally {
      await file.close();
    }
    await chmod(temporary, mode);
    await rename(temporary, path);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
}
// Every component is checked: rejecting symlinks also covers links to paths inside the copy.
export async function safePath(
  root: string,
  path: string,
  allowMissing = false,
): Promise<string> {
  if (
    !path ||
    isAbsolute(path) ||
    path.includes("\0") ||
    path.split(/[\\/]/).some((p) => p === ".." || p === ".git")
  )
    throw new AgentError("PATH_DENIED", `Invalid workspace path: ${path}`);
  const base = await realpath(root);
  const target = resolve(base, path);
  if (!within(base, target) || target === base)
    throw new AgentError("PATH_DENIED", "Path leaves the workspace");
  let current = base;
  for (const component of relative(base, target).split("/")) {
    current = join(current, component);
    try {
      const stat = await lstat(current);
      if (
        stat.isSymbolicLink() ||
        (!stat.isDirectory() && !stat.isFile()) ||
        (stat.isFile() && stat.nlink > 1)
      )
        throw new AgentError(
          "PATH_DENIED",
          "Links and special files are not accessible",
        );
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT")
        return target;
      throw error;
    }
  }
  return target;
}
export async function readText(
  path: string,
  maxBytes = 1_000_000,
): Promise<string> {
  const data = await readBoundedFile(path, maxBytes);
  if (data.includes(0))
    throw new AgentError(
      "BINARY_INPUT",
      `Binary file is not supported: ${path}`,
    );
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    throw new AgentError(
      "BINARY_INPUT",
      `Binary file is not supported: ${path}`,
    );
  }
}
export async function readBoundedFile(
  path: string,
  maxBytes: number,
  options: {
    expectedBytes?: number;
    expectedSha256?: string;
    privateStorage?: boolean;
  } = {},
): Promise<Buffer> {
  const stat = await lstat(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    (options.privateStorage &&
      process.getuid &&
      stat.uid !== process.getuid()) ||
    (options.privateStorage && (stat.mode & 0o077) !== 0) ||
    stat.size > maxBytes ||
    (options.expectedBytes !== undefined && stat.size !== options.expectedBytes)
  )
    throw new AgentError(
      "INPUT_SIZE",
      `Expected a regular file of at most ${maxBytes} bytes: ${path}`,
    );
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const opened = await file.stat();
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.dev !== stat.dev ||
      opened.ino !== stat.ino ||
      opened.size !== stat.size ||
      opened.mtimeMs !== stat.mtimeMs ||
      (options.privateStorage &&
        process.getuid &&
        opened.uid !== process.getuid()) ||
      opened.mode !== stat.mode ||
      opened.uid !== stat.uid ||
      (options.privateStorage && (opened.mode & 0o077) !== 0)
    )
      throw new AgentError(
        "INPUT_CHANGED",
        `Input changed while opening: ${path}`,
      );
    const buffer = Buffer.alloc(opened.size);
    let length = 0;
    while (length < buffer.length) {
      const read = await file.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const after = await file.stat();
    if (
      length !== opened.size ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ino !== opened.ino ||
      after.dev !== opened.dev
    )
      throw new AgentError(
        "INPUT_CHANGED",
        `Input changed while reading: ${path}`,
      );
    const data = buffer.subarray(0, length);
    if (options.expectedSha256 && sha256(data) !== options.expectedSha256)
      throw new AgentError(
        "INPUT_INTEGRITY",
        `Input digest does not match its reference: ${path}`,
      );
    return data;
  } finally {
    await file.close();
  }
}
export function errorMessage(error: unknown): string {
  return error instanceof AgentError
    ? `${error.code}: ${error.message}`
    : error instanceof Error
      ? error.message
      : "Unknown failure";
}
export function jsonObject(text: string): unknown {
  const value = text
    .trim()
    .replace(/^```(?:json)?\s*\n/, "")
    .replace(/\n```$/, "");
  try {
    return JSON.parse(value);
  } catch {
    throw new AgentError(
      "INVALID_RESULT",
      "The model did not return a complete JSON result",
    );
  }
}
export function throwIfAborted(signal: AbortSignal): void {
  signal.throwIfAborted();
}
export function terminalText(value: string): string {
  // Strip terminal control sequences, including OSC hyperlinks and bidirectional controls.
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, "");
}
