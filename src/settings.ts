import { randomUUID } from "node:crypto";
import {
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { Config } from "./config.js";
import { privateFile } from "./config.js";
import { DEFAULT_LIMITS } from "./state.js";
import { AppError } from "./security.js";
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

const secret = z.string().max(16384);
const identifier = z.string().uuid();
export const modelInput = z
  .object({
    id: identifier,
    provider: z.literal("openai"),
    model: z.string().trim().min(1).max(200),
    key: secret.optional(),
  })
  .strict();
export const mcpInput = z
  .object({
    id: identifier,
    name: z.string().trim().min(1).max(100),
    enabled: z.boolean(),
    transport: z.enum(["stdio", "http"]),
    command: z.string().max(1000).default(""),
    args: z.array(z.string().max(4000)).max(100).default([]),
    env: z
      .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), secret)
      .optional(),
    url: z.string().max(2000).default(""),
    // Explicit host grants apply to private addresses, never loopback or metadata.
    privateHosts: z
      .array(
        z
          .string()
          .regex(/^[a-zA-Z0-9.-]+$/)
          .max(253),
      )
      .max(20)
      .default([]),
    auth: z.enum(["none", "bearer", "oauth"]).default("none"),
    bearer: secret.optional(),
    clientId: z.string().max(1000).default(""),
    clientSecret: secret.optional(),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (s.transport === "stdio") {
      if (!s.command.startsWith("/") || s.auth !== "none")
        ctx.addIssue({
          code: "custom",
          message:
            "stdio requires an absolute command and environment authentication",
        });
    } else {
      try {
        const u = new URL(s.url);
        if (u.protocol !== "https:" || u.username || u.password || u.hash)
          throw new Error();
      } catch {
        ctx.addIssue({ code: "custom", message: "HTTPS URL required" });
      }
    }
  });
export const settingsInput = z
  .object({
    revision: z.number().int().nonnegative(),
    models: z.array(modelInput).max(10),
    defaultModel: identifier.nullable(),
    mcp: z.array(mcpInput).max(10),
    instructions: z.string().max(16000),
    limits: z
      .object({
        modelRequests: z
          .number()
          .int()
          .min(1)
          .max(DEFAULT_LIMITS.modelRequests),
        runSeconds: z.number().int().min(1).max(DEFAULT_LIMITS.runSeconds),
        commandSeconds: z
          .number()
          .int()
          .min(1)
          .max(DEFAULT_LIMITS.commandSeconds),
      })
      .strict(),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (
      new Set(s.models.map((m) => m.id)).size !== s.models.length ||
      new Set(s.mcp.map((m) => m.id)).size !== s.mcp.length ||
      (s.defaultModel && !s.models.some((m) => m.id === s.defaultModel))
    )
      ctx.addIssue({
        code: "custom",
        message: "Invalid or duplicate identifier",
      });
  });
export type SettingsInput = z.infer<typeof settingsInput>;
export type McpConfig = z.infer<typeof mcpInput> & {
  authVersion?: number;
  oauth?: {
    client?: OAuthClientInformationMixed;
    tokens?: OAuthTokens;
    expiresAt?: number;
  };
};
export type Settings = Omit<SettingsInput, "mcp"> & {
  schemaVersion: 1;
  mcp: McpConfig[];
};
export function connectionIdentity(s: McpConfig): string {
  return JSON.stringify([
    s.transport,
    s.url,
    s.auth,
    s.clientId,
    s.clientSecret,
    s.privateHosts,
    s.authVersion,
  ]);
}
export class SettingsStore {
  private value!: Settings;
  private retainedSecrets = new Set<string>();
  private serial: Promise<unknown> = Promise.resolve();
  private constructor(private path: string) {}
  static async open(config: Config): Promise<SettingsStore> {
    const store = new SettingsStore(
      join(config.dataRoot, "control/settings-v1.json"),
    );
    const info = await stat(store.path).catch((e) => {
      if (e.code !== "ENOENT") throw e;
      return null;
    });
    if (info) {
      if (
        !info.isFile() ||
        info.uid !== process.getuid?.() ||
        (info.mode & 0o077) !== 0 ||
        info.size > 1024 * 1024 ||
        (await realpath(store.path)) !== resolve(store.path)
      )
        throw new Error("Unsafe settings file");
      const saved = JSON.parse(await readFile(store.path, "utf8")) as Settings;
      if (saved.schemaVersion !== 1)
        throw new Error("Unknown settings version; preserve data");
      const { schemaVersion: _, ...savedInput } = saved;
      const parsed = settingsInput.parse({
        ...savedInput,
        mcp: saved.mcp.map(({ oauth: _, authVersion: __, ...s }) => s),
      });
      store.value = {
        ...parsed,
        schemaVersion: 1,
        mcp: parsed.mcp.map((s) => ({
          ...s,
          oauth: saved.mcp.find((v) => v.id === s.id)?.oauth,
          authVersion: saved.mcp.find((v) => v.id === s.id)?.authVersion,
        })),
      };
    } else {
      let key = "";
      if (config.model)
        try {
          key = await privateFile(config.model.keyFile);
        } catch {
          /* Configure missing credentials through the local UI. */
        }
      const modelId = config.model ? randomUUID() : null;
      store.value = {
        schemaVersion: 1,
        revision: 0,
        models: config.model
          ? [{ id: modelId!, provider: "openai", model: config.model.id, key }]
          : [],
        defaultModel: modelId,
        mcp: config.mcp.map((s) => ({
          ...s,
          id: randomUUID(),
          enabled: true,
          transport: "stdio",
          url: "",
          privateHosts: [],
          auth: "none",
          clientId: "",
        })),
        instructions: config.instructions,
        limits: {
          modelRequests: config.limits.modelRequests,
          runSeconds: config.limits.runSeconds,
          commandSeconds: config.limits.commandSeconds,
        },
      };
      await store.write(store.value);
    }
    return store;
  }
  snapshot(): Settings {
    return structuredClone(this.value);
  }
  public() {
    const s = this.snapshot();
    return {
      ...s,
      schemaVersion: undefined,
      models: s.models.map(({ key, ...m }) => ({ ...m, hasKey: !!key })),
      mcp: s.mcp.map(
        ({ env, bearer, clientSecret, oauth, authVersion: _, ...m }) => ({
          ...m,
          envNames: Object.keys(env ?? {}),
          hasBearer: !!bearer,
          hasClientSecret: !!clientSecret,
          authorized: !!oauth?.tokens,
        }),
      ),
    };
  }
  secrets(): string[] {
    return [
      ...this.retainedSecrets,
      ...this.value.models.map((m) => m.key ?? ""),
      ...this.value.mcp.flatMap((m) => [
        m.bearer ?? "",
        m.clientSecret ?? "",
        ...Object.values(m.env ?? {}),
        m.oauth?.tokens?.access_token ?? "",
        m.oauth?.tokens?.refresh_token ?? "",
        m.oauth?.client?.client_secret ?? "",
      ]),
    ].filter(Boolean);
  }
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.serial.then(fn);
    this.serial = result.catch(() => {});
    return result;
  }
  async save(input: unknown): Promise<void> {
    const parsed = settingsInput.parse(input);
    return this.exclusive(async () => {
      if (parsed.revision !== this.value.revision)
        throw new AppError(409, "設定が更新されています。読み直してください");
      const next: Settings = {
        ...parsed,
        schemaVersion: 1,
        revision: parsed.revision + 1,
        models: parsed.models.map((m) => ({
          ...m,
          key: m.key ?? this.value.models.find((v) => v.id === m.id)?.key,
        })),
        mcp: parsed.mcp.map((m) => {
          const old = this.value.mcp.find((v) => v.id === m.id);
          const sameTarget =
            old?.transport === m.transport &&
            old?.url === m.url &&
            old?.command === m.command;
          const merged = {
            ...m,
            env: m.env ?? (sameTarget ? old?.env : undefined),
            bearer: m.bearer ?? (sameTarget ? old?.bearer : undefined),
            clientSecret:
              m.clientSecret ??
              (sameTarget && old?.clientId === m.clientId
                ? old?.clientSecret
                : undefined),
          };
          const sameConnection =
            old &&
            connectionIdentity({ ...old, authVersion: undefined }) ===
              connectionIdentity(merged);
          return {
            ...merged,
            authVersion: (old?.authVersion ?? 0) + (sameConnection ? 0 : 1),
            oauth: sameConnection ? old.oauth : undefined,
          };
        }),
      };
      await this.write(next);
      this.value = next;
    });
  }
  async oauth(
    id: string,
    identity: string,
    update: (value: NonNullable<McpConfig["oauth"]>) => void,
  ): Promise<void> {
    return this.exclusive(async () => {
      const next = this.snapshot(),
        server = next.mcp.find((s) => s.id === id);
      if (!server || connectionIdentity(server) !== identity)
        throw new AppError(
          409,
          "MCP 設定が変更されています。認証をやり直してください",
        );
      server.oauth ??= {};
      update(server.oauth);
      await this.write(next);
      this.value = next;
    });
  }
  async beginOAuth(id: string): Promise<McpConfig> {
    return this.exclusive(async () => {
      const next = this.snapshot(),
        server = next.mcp.find((s) => s.id === id);
      if (!server || server.transport !== "http" || server.auth !== "oauth")
        throw new AppError(400, "OAuth MCP を選択してください");
      server.authVersion = (server.authVersion ?? 0) + 1;
      server.oauth = { client: server.oauth?.client };
      await this.write(next);
      this.value = next;
      return structuredClone(server);
    });
  }
  async disconnect(id: string): Promise<void> {
    return this.exclusive(async () => {
      const next = this.snapshot(),
        server = next.mcp.find((s) => s.id === id);
      if (!server) throw new AppError(404, "MCP がありません");
      server.oauth = undefined;
      server.authVersion = (server.authVersion ?? 0) + 1;
      server.bearer = "";
      server.clientSecret = "";
      server.env = {};
      next.revision++;
      await this.write(next);
      this.value = next;
    });
  }
  private async write(value: Settings): Promise<void> {
    if (Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024)
      throw new AppError(413, "設定の保存上限に達しました");
    for (const secret of this.value ? this.secrets() : [])
      this.retainedSecrets.add(secret);
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(value));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, this.path);
      const dir = await open(dirname(this.path), "r");
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
}
