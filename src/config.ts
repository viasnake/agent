import { readFile, realpath, stat } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { z } from "zod";
import { parse } from "yaml";
import { DEFAULT_LIMITS } from "./state.js";

const maxima = {
  ...DEFAULT_LIMITS,
  modelRequests: 600,
  deadlineSeconds: 86400,
  repairs: 10,
};
const limitShape = Object.fromEntries(
  Object.entries(DEFAULT_LIMITS).map(([key, value]) => [
    key,
    z
      .number()
      .int()
      .min(key === "logBytes" ? 1024 : 1)
      .max(maxima[key as keyof typeof maxima])
      .default(value),
  ]),
);
const schema = z
  .object({
    schemaVersion: z.literal(1),
    dataRoot: z
      .string()
      .refine(
        (path): boolean => path === "/srv/agent-data",
        "The fixed guest data mount is required",
      ),
    expectedMountLabel: z.string().default("AGENT_DATA"),
    server: z.object({
      host: z.string().default("0.0.0.0"),
      port: z.number().int().min(1).max(65535).default(8080),
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
    github: z
      .object({
        repositories: z.array(
          z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
        ),
        tokenFile: z.string().startsWith("/"),
      })
      .nullable()
      .default(null),
    limits: z.object(limitShape).default(DEFAULT_LIMITS),
    recoveryHold: z.boolean().default(false),
  })
  .strict();
export type Config = z.infer<typeof schema> & { limits: typeof DEFAULT_LIMITS };
export async function loadConfig(path: string): Promise<Config> {
  const config = schema.parse(parse(await readFile(path, "utf8")));
  for (const origin of config.server.origins) {
    const url = new URL(origin);
    if (
      url.origin !== origin ||
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error("Invalid origin");
  }
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
  const root = await realpath(config.dataRoot);
  if (root !== resolve(config.dataRoot))
    throw new Error("Data root cannot contain symlinks");
  const mounts = await readFile("/proc/self/mountinfo", "utf8");
  const mount = mounts.split("\n").find((line) => line.split(" ")[4] === root);
  if (!mount) throw new Error("Required data disk is not mounted");
  const rootInfo = await stat(root);
  if (rootInfo.uid !== 0 || rootInfo.mode & 0o022)
    throw new Error(
      "Data mount must be root-owned and non-writable by other users",
    );
  const expectedUuid = (await readFile("/etc/agent-data.uuid", "utf8")).trim();
  const label = await realpath(
    `/dev/disk/by-label/${config.expectedMountLabel}`,
  );
  const device = mount.split(" - ")[1]?.split(" ")[1];
  if (
    !device ||
    (await realpath(device)) !== label ||
    (await realpath(`/dev/disk/by-uuid/${expectedUuid}`)) !== label
  )
    throw new Error("Unexpected data disk");
  for (const name of [
    "control",
    "control/secrets",
    "control/artifacts",
    "control/uploads",
  ]) {
    const path = resolve(root, name),
      info = await stat(path);
    if (
      !info.isDirectory() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0 ||
      (await realpath(path)) !== path
    )
      throw new Error(`Unsafe control directory: ${name}`);
  }
  const parent = await stat(dirname(root));
  if (parent.mode & 0o002) throw new Error("Unsafe data parent");
}
