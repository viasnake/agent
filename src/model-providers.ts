import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { googleVertexProvider } from "@earendil-works/pi-ai/providers/google-vertex";
import { amazonBedrockProvider } from "@earendil-works/pi-ai/providers/amazon-bedrock";
import type { CredentialStore, Models, Provider } from "@earendil-works/pi-ai";
import { z } from "zod";
import { AppError } from "./security.js";
import type { ModelConfig } from "./settings.js";
import { bedrockProvider } from "./bedrock.js";

const catalogs = {
  openai: openaiProvider,
  "github-copilot": githubCopilotProvider,
  anthropic: anthropicProvider,
  google: googleProvider,
  "google-vertex": googleVertexProvider,
  "amazon-bedrock": amazonBedrockProvider,
};

export async function copilotAccountModels(
  models: Models,
  credentials: CredentialStore,
  signal: AbortSignal,
) {
  // getAvailable checks stored credentials but does not refresh them. Pi refreshes
  // both the token and account model permissions through getAuth.
  const auth = await models.getAuth("github-copilot", { signal });
  if (!auth) throw new AppError(401, "認証が必要です");
  const credential = await credentials.read("github-copilot", { signal });
  // Pi falls back to its entire catalog when permission metadata is absent.
  if (
    credential?.type !== "oauth" ||
    !Array.isArray(credential.availableModelIds) ||
    !credential.availableModelIds.every((id) => typeof id === "string")
  )
    throw new AppError(
      401,
      "利用可能モデルを確認できません。再認証してください",
    );
  return (await models.getAvailable("github-copilot", { signal })).map(
    (model) => model.id,
  );
}

// Read account metadata without inference. Pi owns credential refresh and dispatch.
export async function openaiAccountModels(
  models: Models,
  signal: AbortSignal,
  authType: "oauth" | "api_key",
) {
  const auth = await models.getAuth("openai", { signal });
  if (!auth?.auth.apiKey) throw new AppError(401, "認証が必要です");
  const response = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${auth.auth.apiKey}` },
    redirect: "error",
    signal,
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new AppError(response.status, `接続失敗（HTTP ${response.status}）`);
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const reader = response.body?.getReader();
  if (!reader) throw new AppError(502, "モデル一覧を取得できません");
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1024 * 1024)
        throw new AppError(502, "モデル一覧が大きすぎます");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const payload: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const catalog = z
    .object({
      models: z
        .array(
          z.object({
            slug: z.string().min(1).max(200),
            visibility: z.string(),
          }),
        )
        .max(10000),
    })
    .safeParse(payload);
  const apiCatalog = z
    .object({
      data: z.array(z.object({ id: z.string().min(1).max(200) })).max(10000),
    })
    .safeParse(payload);
  const ids =
    authType === "oauth"
      ? catalog.success
        ? catalog.data.models
            .filter((model) => model.visibility === "list")
            .map((model) => model.slug)
        : undefined
      : apiCatalog.success
        ? apiCatalog.data.data.map((model) => model.id)
        : undefined;
  if (!ids) throw new AppError(502, "モデル一覧を取得できません");
  return [...new Set(ids)].filter((id) => models.getModel("openai", id));
}

export async function chatgptTestModel(
  models: Models,
  signal: AbortSignal,
  requested?: string,
) {
  const available = await openaiAccountModels(models, signal, "oauth");
  const selected = requested
    ? available.find((model) => model === requested)
    : available[0];
  if (!selected) throw new AppError(400, "利用できるモデルがありません");
  return selected;
}

export function modelTestFailure(error: unknown): string {
  if (error instanceof AppError) return error.message;
  // Never expose raw provider errors: they can echo credentials or request contents.
  const message = error instanceof Error ? error.message : "";
  const known: [string, string][] = [
    ["subscription_sharing_user_not_eligible", "ChatGPT の利用対象外"],
    ["subscription_sharing_usage_limit_exceeded", "利用上限"],
    ["subscription_sharing_usage_unavailable", "利用状況を確認できません"],
    ["subscription_sharing_unsupported_capability", "モデル・機能が非対応"],
    ["subscription_sharing_route_not_supported", "接続先が非対応"],
    ["subscription_sharing_invalid_user", "認証が必要です"],
    ["chatpass_v2_scope_not_authorized", "アクセス権限なし"],
    ["chatpass_v2_invalid_authorization_context", "アクセス権限なし"],
    ["model_not_found", "モデルを利用できません"],
    ["model_not_supported", "モデルを利用できません"],
    ["invalid_grant", "再認証が必要です"],
  ];
  const reason = known.find(([code]) => message.includes(code));
  if (reason) return reason[1];
  if (
    error instanceof Error &&
    ["TimeoutError", "AbortError"].includes(error.name)
  )
    return "タイムアウト";
  // Pi preserves Anthropic status prefixes and formats Responses errors separately.
  const status = message.match(
    /API error \(([45]\d{2})\):|^([45]\d{2})(?=[\s:])/,
  );
  return status ? `接続失敗（HTTP ${status[1] ?? status[2]}）` : "接続失敗";
}

export function modelCatalogs(): Record<ModelConfig["provider"], string[]> {
  return Object.fromEntries(
    Object.entries(catalogs).map(([id, create]) => [
      id,
      create()
        .getModels()
        .map((model) => model.id),
    ]),
  ) as Record<ModelConfig["provider"], string[]>;
}
export function modelProvider(config: ModelConfig): Provider {
  if (
    config.provider !== "google-vertex" &&
    config.provider !== "amazon-bedrock"
  )
    return catalogs[config.provider]();
  const native =
    config.provider === "google-vertex"
      ? googleVertexProvider()
      : bedrockProvider(config);
  const baseUrl =
    config.provider === "google-vertex"
      ? `https://${config.location === "global" ? "" : `${config.location}-`}aiplatform.googleapis.com/v1/projects/${config.project}/locations/${config.location}`
      : `https://bedrock-runtime.${config.region}.${config.region?.startsWith("cn-") ? "amazonaws.com.cn" : "amazonaws.com"}`;
  const models = native.getModels().map((model) => ({ ...model, baseUrl }));
  // Legacy explicit IDs can name an inference profile outside the SDK catalog.
  // Such IDs need a separate image declaration; catalog reads never probe credentials.
  if (config.model && !models.some((model) => model.id === config.model))
    models.push({
      id: config.model,
      name: config.model,
      provider: native.id,
      api:
        config.provider === "google-vertex"
          ? "google-vertex"
          : "bedrock-converse-stream",
      baseUrl,
      reasoning: false,
      input: config.images ? ["text", "image"] : ["text"],
      contextWindow: 32000,
      maxTokens: 8192,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
  return {
    ...native,
    getModels: () => models,
    getAllModels: () => models,
    auth: {
      apiKey: {
        name: "Cloud credential chain",
        resolve: async () => ({
          auth: {},
          env:
            config.provider === "google-vertex"
              ? {
                  GOOGLE_CLOUD_PROJECT: config.project!,
                  GOOGLE_CLOUD_LOCATION: config.location!,
                }
              : undefined,
        }),
      },
    },
  };
}
