import { lstat, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";

const schema = z
  .object({
    schemaVersion: z.literal(1),
    dataRoot: z
      .string()
      .regex(/^\/[a-zA-Z0-9_./-]+$/)
      .refine((value) => resolve(value) === value && value !== "/"),
    controlUid: z.number().int().positive(),
    workUid: z.number().int().positive(),
  })
  .refine((value) => value.controlUid !== value.workUid);

// Work processes may read identities and paths, but only root can grant them.
export async function readInstallation() {
  const path = "/etc/agent/installation.json";
  for (let current = path; current !== "/"; current = dirname(current)) {
    const info = await lstat(current);
    if (info.uid !== 0 || info.mode & 0o022 || info.isSymbolicLink())
      throw new Error("Installation metadata must be root-owned and immutable");
    if (current === path && (!info.isFile() || info.size > 16384))
      throw new Error("Invalid installation metadata");
  }
  return schema.parse(JSON.parse(await readFile(path, "utf8")));
}
