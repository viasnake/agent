import { type AuthInteraction } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config, Connection, Paths } from "../config.js";
import { AgentError } from "../types.js";
import { atomicWrite, id, privateDirectory } from "../util.js";

export function providerId(connection: Connection): string {
  return connection.type === "chatgpt"
    ? "openai"
    : connection.type === "gemini"
      ? "google"
      : "agent-compatible";
}
export function endpoint(connection: Connection): string {
  if (connection.type === "chatgpt") return "https://api.openai.com/v1";
  if (connection.type === "gemini")
    return "https://generativelanguage.googleapis.com/v1beta";
  if (connection.type === "sarashina")
    return connection.endpoint ?? "https://api.sarashina.ai/v1";
  if (!connection.endpoint)
    throw new AgentError("CONFIG", "Endpoint is missing");
  return connection.endpoint;
}
export async function connectionRuntime(
  config: Config,
  paths: Paths,
  name: string,
): Promise<ModelRuntime> {
  const connection = config.connections[name];
  if (!connection) throw new AgentError("CONFIG", `Unknown connection ${name}`);
  const directory = join(paths.auth, name);
  await privateDirectory(directory);
  const runtime = await ModelRuntime.create({
    authPath: join(directory, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(directory, "models.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  if (connection.type === "chatgpt") return runtime;
  const key = connection.secretEnv
    ? process.env[connection.secretEnv]
    : connection.type === "local"
      ? "local-no-key"
      : undefined;
  if (connection.type === "gemini") {
    if (key) await runtime.setRuntimeApiKey("google", key);
  } else {
    runtime.registerProvider("agent-compatible", {
      baseUrl: endpoint(connection),
      api: "openai-completions",
      apiKey: key ?? "unconfigured",
      models: Object.entries(config.models)
        .filter(([, m]) => m.connection === name)
        .map(([alias, model]) => ({
          id: model.id,
          name: alias,
          reasoning: false,
          input: ["text"],
          contextWindow: model.contextWindow,
          maxTokens: model.maxOutputTokens,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          compat: {
            supportsStore: false,
            supportsDeveloperRole: false,
            supportsUsageInStreaming: connection.type !== "sarashina",
            maxTokensField:
              connection.type === "sarashina"
                ? "max_completion_tokens"
                : "max_tokens",
          },
        })),
    });
  }
  return runtime;
}
export async function login(
  config: Config,
  paths: Paths,
  name: string,
  interaction: AuthInteraction,
): Promise<void> {
  const connection = config.connections[name];
  if (connection?.type !== "chatgpt")
    throw new AgentError(
      "AUTH",
      "Only ChatGPT uses interactive login; other connections use the configured environment variable",
    );
  const runtime = await connectionRuntime(config, paths, name);
  const devicePath = join(paths.auth, "installation-id");
  let device = await readFile(devicePath, "utf8").catch(() => undefined);
  if (!device) {
    device = id();
    await atomicWrite(devicePath, device);
  }
  await runtime.login("openai", "oauth", interaction, {
    agentName: "Local Agent",
    getDeviceId: () => device!,
  });
}
