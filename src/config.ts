import { z } from "zod";
import { parse, stringify } from "yaml";
import { defaultBackend, defaultHome } from "./platform.js";
import { join, resolve } from "node:path";
import { lstat, readFile, realpath } from "node:fs/promises";
import { AgentError } from "./types.js";
import {
  canonical,
  sha256,
  privateDirectory,
  atomicWrite,
  within,
} from "./util.js";

const name = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
const envRef = z.string().regex(/^[A-Z][A-Z0-9_]*$/);
const dataClass = z.enum(["public", "private", "restricted"]);
const connection = z.strictObject({
  type: z.enum([
    "chatgpt",
    "gemini",
    "sarashina",
    "compatible",
    "local",
    "clef",
  ]),
  enabled: z.boolean().default(false),
  account: z.string().min(1),
  billing: z.enum(["subscription", "api", "beta", "local"]),
  allowedData: z.array(dataClass).default(["public"]),
  secretEnv: envRef.optional(),
  endpoint: z.url().optional(),
  accountEnv: envRef.optional(),
  requestsPerMinute: z.number().int().positive().max(10000).default(60),
  maxRequestUsd: z.number().nonnegative().max(1000).default(0),
});
const model = z.strictObject({
  connection: name,
  id: z.string().min(1).max(200),
  roles: z.array(z.enum(["lead", "worker", "reviewer"])).min(1),
  kinds: z.array(z.enum(["coding", "research", "writing", "chat"])).min(1),
  tools: z.boolean().default(false),
  images: z.boolean().optional(),
  contextWindow: z.number().int().min(2048).max(2_000_000).default(32000),
  maxOutputTokens: z.number().int().min(256).max(128000).default(4096),
  priority: z.number().int().default(0),
});
const mcp = z.strictObject({
  transport: z.enum(["stdio", "http"]),
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  commandSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  url: z.url().optional(),
  allowedOrigins: z.array(z.url()).default([]),
  env: z.record(envRef, envRef).default({}),
  bearerEnv: envRef.optional(),
  oauth: z.boolean().default(false),
  allowedData: z.array(dataClass).default(["public"]),
  local: z.boolean().default(false),
  tools: z.record(
    z.string().min(1),
    z.strictObject({
      schemaSha256: z.string().regex(/^[a-f0-9]{64}$/),
      readOnly: z.literal(true),
    }),
  ),
});
export const configSchema = z.strictObject({
  schemaVersion: z.literal(1),
  retentionDays: z.number().int().min(1).max(3650).default(30),
  connections: z.record(name, connection).default({}),
  models: z.record(name, model).default({}),
  defaults: z
    .strictObject({
      dataClass,
      mode: z.enum(["single", "assisted", "reviewed"]),
    })
    .default({ dataClass: "private", mode: "reviewed" }),
  limits: z
    .strictObject({
      maxRequests: z.number().int().min(1).max(1000).default(60),
      maxApiUsd: z.number().nonnegative().max(10000).default(0),
      maxSeconds: z.number().int().min(5).max(86400).default(1800),
      maxAgents: z.number().int().min(1).max(3).default(3),
      maxTasks: z.number().int().min(1).max(20).default(8),
      maxRepairs: z.number().int().min(0).max(2).default(2),
      maxInputBytes: z.number().int().min(1000).max(4_000_000).default(120000),
      maxFileBytes: z
        .number()
        .int()
        .min(1000)
        .max(10_000_000)
        .default(1_000_000),
      maxWorkspaceBytes: z
        .number()
        .int()
        .min(1000)
        .max(1_000_000_000)
        .default(100_000_000),
      requestTimeoutSeconds: z.number().int().min(1).max(1800).default(180),
    })
    .prefault({}),
  execution: z
    .strictObject({
      backend: z
        .enum(["bubblewrap", "podman", "disabled"])
        .default(defaultBackend),
      image: z
        .string()
        .regex(/^[^\s]+@sha256:[a-f0-9]{64}$/)
        .optional(),
      runtimePaths: z.array(z.string().startsWith("/")).default([]),
      commandTimeoutSeconds: z.number().int().min(1).max(3600).default(120),
      maxOutputBytes: z.number().int().min(1024).max(1_000_000).default(64000),
    })
    .prefault({}),
  checks: z
    .record(
      name,
      z.strictObject({
        command: z.string().min(1).max(8000),
        protectedPaths: z.array(z.string().min(1)).default([]),
      }),
    )
    .default({}),
  routing: z
    .strictObject({
      mode: z.enum(["rules", "shadow", "assisted"]).default("rules"),
      classifier: name.optional(),
    })
    .prefault({}),
  web: z
    .strictObject({
      allowedHosts: z.array(z.string().regex(/^[a-zA-Z0-9.-]+$/)).default([]),
      allowedData: z.array(dataClass).default(["public"]),
    })
    .prefault({}),
  mcp: z.record(name, mcp).default({}),
});
export type Config = z.infer<typeof configSchema>;
export type Connection = Config["connections"][string];
export type ModelConfig = Config["models"][string];
export interface Paths {
  home: string;
  config: string;
  database: string;
  runs: string;
  auth: string;
  attachments: string;
}
export function paths(home?: string): Paths {
  const root = resolve(home ?? process.env.AGENT_HOME ?? defaultHome());
  return {
    home: root,
    config: join(root, "config.yaml"),
    database: join(root, "state.sqlite"),
    runs: join(root, "runs"),
    auth: join(root, "auth"),
    attachments: join(root, "attachments"),
  };
}
export function validateConfig(input: unknown): Config {
  const parsed = configSchema.safeParse(input);
  if (!parsed.success)
    throw new AgentError(
      "CONFIG",
      parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("\n"),
    );
  const config = parsed.data;
  for (const [key, conn] of Object.entries(config.connections)) {
    if (conn.type === "local" && conn.billing !== "local")
      throw new AgentError(
        "CONFIG",
        `${key}: local connections require local billing`,
      );
    if (conn.type !== "local" && conn.billing === "local")
      throw new AgentError(
        "CONFIG",
        `${key}: cloud connections cannot use local billing`,
      );
    if (conn.type === "chatgpt" && conn.billing !== "subscription")
      throw new AgentError(
        "CONFIG",
        `${key}: ChatGPT requires subscription billing`,
      );
    if (
      ["gemini", "compatible", "clef"].includes(conn.type) &&
      conn.billing !== "api"
    )
      throw new AgentError(
        "CONFIG",
        `${key}: this provider requires explicit API billing authorization`,
      );
    if (conn.type === "sarashina" && !["api", "beta"].includes(conn.billing))
      throw new AgentError(
        "CONFIG",
        `${key}: Sarashina requires beta or API billing`,
      );
    if (
      conn.type === "sarashina" &&
      conn.allowedData.some((c) => c !== "public")
    )
      throw new AgentError("CONFIG", `${key}: Sarashina beta is public-only`);
    if (conn.type !== "local" && conn.allowedData.includes("restricted"))
      throw new AgentError(
        "CONFIG",
        `${key}: restricted data requires a local connection`,
      );
    if (["compatible", "local"].includes(conn.type) && !conn.endpoint)
      throw new AgentError("CONFIG", `${key}: endpoint required`);
    if (conn.endpoint) {
      if (["chatgpt", "gemini", "clef"].includes(conn.type))
        throw new AgentError(
          "CONFIG",
          `${key}: this native provider uses its fixed official endpoint`,
        );
      const url = new URL(conn.endpoint);
      if (url.username || url.password || url.search || url.hash)
        throw new AgentError(
          "CONFIG",
          `${key}: endpoint must not contain credentials, query, or fragment`,
        );
      if (conn.type === "local") {
        if (!["127.0.0.1", "[::1]"].includes(url.hostname))
          throw new AgentError(
            "CONFIG",
            `${key}: local endpoint must use a loopback IP literal`,
          );
        if (!["http:", "https:"].includes(url.protocol))
          throw new AgentError("CONFIG", `${key}: invalid local protocol`);
      } else if (url.protocol !== "https:")
        throw new AgentError(
          "CONFIG",
          `${key}: remote endpoints require HTTPS`,
        );
    }
  }
  for (const [key, value] of Object.entries(config.models)) {
    const conn = config.connections[value.connection];
    if (!conn)
      throw new AgentError(
        "CONFIG",
        `${key}: unknown connection ${value.connection}`,
      );
    if (conn.type === "clef")
      throw new AgentError(
        "CONFIG",
        `${key}: classifier cannot be used as an agent`,
      );
    if (conn.type === "sarashina" && value.maxOutputTokens > 8000)
      throw new AgentError(
        "CONFIG",
        `${key}: Sarashina output limit is 8000 tokens`,
      );
  }
  if (
    config.routing.mode !== "rules" &&
    (!config.routing.classifier ||
      config.connections[config.routing.classifier]?.type !== "clef")
  )
    throw new AgentError(
      "CONFIG",
      "Routing classifier must reference a Clef connection",
    );
  for (const [key, server] of Object.entries(config.mcp)) {
    if (
      server.transport === "stdio" &&
      (!server.command?.startsWith("/") || !server.commandSha256)
    )
      throw new AgentError(
        "CONFIG",
        `${key}: stdio requires an absolute command and its SHA-256`,
      );
    if (server.transport === "stdio" && config.execution.backend === "disabled")
      throw new AgentError(
        "CONFIG",
        `${key}: stdio MCP requires an enabled sandbox backend`,
      );
    if (server.transport === "http" && !server.url)
      throw new AgentError("CONFIG", `${key}: HTTP URL required`);
    if (server.local && server.transport !== "stdio")
      throw new AgentError(
        "CONFIG",
        `${key}: local MCP must run in the network-isolated stdio sandbox`,
      );
    if (server.url) {
      const url = new URL(server.url);
      if (url.username || url.password || url.hash)
        throw new AgentError(
          "CONFIG",
          `${key}: MCP URL must not contain credentials or a fragment`,
        );
      if (!server.allowedOrigins.includes(url.origin))
        throw new AgentError(
          "CONFIG",
          `${key}: MCP URL origin must be listed in allowedOrigins`,
        );
    }
    if (server.oauth && server.bearerEnv)
      throw new AgentError(
        "CONFIG",
        `${key}: choose OAuth or bearerEnv, not both`,
      );
  }
  return config;
}
export async function loadConfig(p: Paths): Promise<Config> {
  const stat = await lstat(p.config).catch(() => {
    throw new AgentError("NOT_INITIALIZED", "Run agent init first");
  });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o022)
    throw new AgentError(
      "CONFIG",
      "Configuration must be a regular file without group/other write access",
    );
  return validateConfig(
    parse(await readFile(p.config, "utf8"), { maxAliasCount: 0 }),
  );
}
export const configHash = (config: Config) => sha256(canonical(config));
export async function initialize(p: Paths, template?: unknown): Promise<void> {
  await privateDirectory(p.home);
  for (const path of [p.runs, p.auth, p.attachments])
    await privateDirectory(path);
  if (
    await lstat(p.config).then(
      () => true,
      () => false,
    )
  )
    throw new AgentError("EXISTS", "Configuration already exists");
  await atomicWrite(
    p.config,
    "# Trusted user configuration; never put API keys or tokens here.\n" +
      stringify(validateConfig(template ?? { schemaVersion: 1 })),
  );
}
export async function ensureOutsideWorkspace(
  p: Paths,
  workspace: string,
): Promise<void> {
  const home = await realpath(p.home);
  const source = await realpath(workspace);
  if (within(source, home) || within(home, source))
    throw new AgentError(
      "CONFIG",
      "Agent storage and source workspace must be separate trees",
    );
}
