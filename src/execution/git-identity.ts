import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { chmod, lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { hash } from "../security.js";

const configBytes = 1024 * 1024;
const revision = z.string().regex(/^[0-9a-f]{64}$/);
const field = z
  .string()
  .max(256)
  .regex(/^[^\p{Cc}<>]*$/u)
  .trim();
export const gitIdentityInput = z
  .object({ name: field, email: field, revision })
  .strict();
export const gitIdentityView = z
  .object({
    name: z.string().max(configBytes),
    email: z.string().max(configBytes),
    revision,
  })
  .strict();
type Identity = z.infer<typeof gitIdentityView>;
const fields = ["name", "email"] as const;
const exec = promisify(execFile);

async function existingConfig(path: string) {
  const entry = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  if (!entry) return undefined;
  return realpath(path);
}

async function readConfig(path: string) {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  if (!file) return { bytes: Buffer.alloc(0), mode: 0o600 };
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > configBytes)
      throw new Error("Invalid Git config file");
    const buffer = Buffer.allocUnsafe(configBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > configBytes) throw new Error("Git config is too large");
    return { bytes: buffer.subarray(0, length), mode: info.mode & 0o777 };
  } finally {
    await file.close();
  }
}

export async function gitIdentity(
  environment: Record<string, string>,
  signal: AbortSignal,
  input?: z.infer<typeof gitIdentityInput>,
): Promise<Identity | { conflict: true }> {
  const home = environment.HOME!;
  const primary = join(home, ".gitconfig");
  // Git --global selects XDG only when the home config is absent and XDG exists.
  const path =
    (await existingConfig(primary)) ??
    (await existingConfig(join(home, ".config", "git", "config"))) ??
    primary;
  const git = async (
    file: string | Buffer,
    args: string[],
    missingCode?: number,
  ) => {
    try {
      const command = exec(
        "/usr/bin/git",
        [
          "config",
          "--file",
          typeof file === "string" ? file : "-",
          "--no-includes",
          ...args,
        ],
        {
          cwd: home,
          env: environment,
          timeout: 3000,
          maxBuffer: configBytes,
          signal,
        },
      );
      if (Buffer.isBuffer(file)) {
        command.child.stdin!.on("error", () => {});
        command.child.stdin!.end(file);
      }
      return (await command).stdout;
    } catch (error) {
      if (
        missingCode !== undefined &&
        (error as { code?: unknown }).code === missingCode
      )
        return "";
      throw error;
    }
  };
  const view = (name: string, email: string): Identity => ({
    name,
    email,
    revision: hash([path, name, email]),
  });
  const read = async (bytes: Buffer) => {
    const values = { name: "", email: "" };
    const matches = await git(
      bytes,
      ["--null", "--get-regexp", "^user\\.(name|email)$"],
      1,
    );
    for (const record of matches.split("\0")) {
      const newline = record.indexOf("\n");
      if (newline < 0) continue;
      const key = record.slice(5, newline);
      if (key === "name" || key === "email")
        values[key] = record.slice(newline + 1);
    }
    return view(values.name, values.email);
  };
  if (!input) return read((await readConfig(path)).bytes);

  // Hold the same lock as git config while Git edits a staged copy of both keys.
  const lock = path + ".lock";
  const staged = await open(lock, "wx", 0o600).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    },
  );
  if (!staged) return { conflict: true };
  let published = false;
  try {
    const { bytes, mode } = await readConfig(path);
    const next = view(input.name, input.email);
    const current = await read(bytes);
    if (current.revision === next.revision) return current;
    if (input.revision !== current.revision) return { conflict: true };
    await staged.writeFile(bytes);
    for (const field of fields) {
      if (current[field] === next[field]) continue;
      const key = `user.${field}`;
      if (next[field])
        await git(lock, ["--replace-all", "--", key, next[field]]);
      else await git(lock, ["--unset-all", "--", key], 5);
    }
    if ((await lstat(lock)).size > configBytes)
      throw new Error("Git config is too large");
    await chmod(lock, mode);
    signal.throwIfAborted();
    await rename(lock, path);
    published = true;
    return next;
  } finally {
    await staged.close();
    if (!published) await unlink(lock);
  }
}
