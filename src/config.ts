import { readFile, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { isIP } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readInstallation } from "./installation.js";
import { z } from "zod";
import { parse } from "yaml";
import { DEFAULT_LIMITS } from "./state.js";

const limitShape = Object.fromEntries(
  Object.entries(DEFAULT_LIMITS).map(([key, value]) => [
    key,
    z.number().int().positive().max(value).default(value),
  ]),
);
export const mcpServerSchema = z
  .object({
    name: z.string().min(1).max(100),
    command: z.string().startsWith("/"),
    args: z.array(z.string()).max(100).default([]),
  })
  .strict();
const schema = z
  .object({
    schemaVersion: z.literal(2),
    dataRoot: z
      .string()
      .regex(/^\/[a-zA-Z0-9_./-]+$/)
      .refine((path) => resolve(path) === path && path !== "/"),
    server: z.object({
      host: z
        .string()
        .refine((value) => isIP(value) !== 0)
        .default("0.0.0.0"),
      // Work-side preview servers may use loopback ports 3000-3999.
      port: z
        .number()
        .int()
        .min(1)
        .max(65535)
        .refine(
          (port) => port < 3000 || port > 3999,
          "Web port overlaps work-side preview ports",
        )
        .default(8080),
      origins: z.array(z.string().url()).min(1),
    }),
    model: z
      .object({
        provider: z.literal("openai"),
        id: z.string().min(1),
        keyFile: z.string().startsWith("/"),
        disclosureApproved: z.literal(true),
      })
      .nullable()
      .default(null),
    mcp: z.array(mcpServerSchema).max(10).default([]),
    instructions: z.string().max(16000).default(""),
    limits: z.object(limitShape).default(DEFAULT_LIMITS),
  })
  .strict();
export type Config = z.infer<typeof schema> & { limits: typeof DEFAULT_LIMITS };
export function isLocalOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (
      url.origin === origin &&
      ["http:", "https:"].includes(url.protocol) &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
export async function loadConfig(path: string): Promise<Config> {
  const config = schema.parse(parse(await readFile(path, "utf8")));
  if (!config.server.origins.every(isLocalOrigin))
    throw new Error("Only loopback browser origins are supported");
  return config as Config;
}
export async function privateFile(path: string): Promise<string> {
  const info = await stat(path);
  if (
    !info.isFile() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0 ||
    info.size > 16384 ||
    (await realpath(path)) !== resolve(path)
  )
    throw new Error("Secret file must be private, owned, and regular");
  return (await readFile(path, "utf8")).trim();
}
export async function checkDataRoot(config: Config): Promise<void> {
  const installation = await readInstallation();
  if (
    config.dataRoot !== installation.dataRoot ||
    process.getuid?.() !== installation.controlUid
  )
    throw new Error(
      "Configuration does not match the installed data root or control identity",
    );
  await promisify(execFile)(
    "/opt/agent-python/bin/python3",
    ["-I", "-B", "/opt/agent/install/system.py", "check"],
    { timeout: 15000 },
  );
}
