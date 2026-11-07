import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { googleVertexProvider } from "@earendil-works/pi-ai/providers/google-vertex";
import { amazonBedrockProvider } from "@earendil-works/pi-ai/providers/amazon-bedrock";
import type { Provider } from "@earendil-works/pi-ai";
import type { ModelConfig } from "./settings.js";
import { bedrockProvider } from "./bedrock.js";

const catalogs = {
  openai: openaiProvider,
  anthropic: anthropicProvider,
  google: googleProvider,
  "google-vertex": googleVertexProvider,
  "amazon-bedrock": amazonBedrockProvider,
};

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
