import {
  BedrockRuntimeClient,
  ConverseStreamCommand,
  type ContentBlock,
  type ConverseStreamCommandInput,
  type Message,
  type ImageBlock,
  type ToolInputSchema,
} from "@aws-sdk/client-bedrock-runtime";
import {
  calculateCost,
  createAssistantMessageEventStream,
  createProvider,
  type AssistantMessage,
  type ImageContent,
  type ProviderStreams,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { amazonBedrockProvider } from "@earendil-works/pi-ai/providers/amazon-bedrock";
import {
  collapseSystemMessages,
  getCurrentTools,
  getInitialSystemMessage,
} from "@earendil-works/pi-ai/utils/transcript";
import { getSystemMessageText } from "@earendil-works/pi-ai/utils/text";
import type { ModelConfig } from "./settings.js";
type Connection = Pick<ModelConfig, "region" | "profile" | "key" | "auth">;
class AgentError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function bedrockImage(part: ImageContent): ImageBlock {
  const format = part.mimeType.slice("image/".length);
  if (!["png", "jpeg", "webp"].includes(format))
    throw new AgentError("IMAGE_FORMAT", "Unsupported Bedrock image content");
  return {
    format: format as "png" | "jpeg" | "webp",
    source: { bytes: Buffer.from(part.data, "base64") },
  };
}

export function bedrockEndpoint(connection: Connection): string {
  const suffix = connection.region?.startsWith("cn-")
    ? "amazonaws.com.cn"
    : "amazonaws.com";
  return `https://bedrock-runtime.${connection.region}.${suffix}`;
}

// The upstream Pi Bedrock adapter constructs a client with implicit AWS retries.
// Own the client here so one host reservation permits exactly one inference call.
export function bedrockProvider(connection: Connection) {
  const native = amazonBedrockProvider();
  const stream: ProviderStreams["streamSimple"] = (
    model,
    context,
    options = {},
  ) => {
    const output = createAssistantMessageEventStream();
    void (async () => {
      const result: AssistantMessage = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [],
        stopReason: "error",
        timestamp: Date.now(),
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      let client: BedrockRuntimeClient | undefined;
      try {
        options.signal?.throwIfAborted();
        if (options.reasoning)
          throw new AgentError(
            "MODEL_CAPABILITY",
            "Bedrock thinking levels are not supported by this adapter",
          );
        const normalized = collapseSystemMessages(context);
        const messages: Message[] = [];
        for (const message of normalized.messages) {
          if (message.role === "system") continue;
          const role = message.role === "assistant" ? "assistant" : "user";
          const content: ContentBlock[] = [];
          if (message.role === "toolResult") {
            content.push({
              toolResult: {
                toolUseId: message.toolCallId,
                status: message.isError ? "error" : "success",
                content: message.content.map((part) => {
                  if (part.type === "text") return { text: part.text };
                  if (part.type === "image")
                    return { image: bedrockImage(part) };
                  throw new AgentError(
                    "PROVIDER",
                    "Unsupported Bedrock tool result",
                  );
                }),
              },
            });
          } else if (message.role === "user" || message.role === "assistant") {
            const parts =
              typeof message.content === "string"
                ? [{ type: "text" as const, text: message.content }]
                : message.content;
            for (const part of parts) {
              if (part.type === "text") {
                if (part.text) content.push({ text: part.text });
              } else if (part.type === "image") {
                if (role !== "user")
                  throw new AgentError(
                    "IMAGE_FORMAT",
                    "Unsupported Bedrock image content",
                  );
                content.push({ image: bedrockImage(part) });
              } else if (part.type === "toolCall") {
                content.push({
                  toolUse: {
                    toolUseId: part.id,
                    name: part.name,
                    input: part.arguments as NonNullable<
                      ContentBlock.ToolUseMember["toolUse"]
                    >["input"],
                  },
                });
              } else {
                throw new AgentError(
                  "MODEL_CAPABILITY",
                  "Bedrock reasoning history cannot be replayed by this adapter",
                );
              }
            }
          } else {
            throw new AgentError(
              "PROVIDER",
              "Unsupported Bedrock message role",
            );
          }
          if (!content.length) continue;
          const previous = messages.at(-1);
          if (previous?.role === role) previous.content!.push(...content);
          else messages.push({ role, content });
        }
        const system = getInitialSystemMessage(normalized.messages);
        const tools = getCurrentTools(normalized.messages);
        let payload: ConverseStreamCommandInput = {
          modelId: model.id,
          messages,
          ...(system
            ? { system: [{ text: getSystemMessageText(system) }] }
            : {}),
          inferenceConfig: { maxTokens: options.maxTokens ?? model.maxTokens },
          ...(tools.length
            ? {
                toolConfig: {
                  tools: tools.map((tool) => ({
                    toolSpec: {
                      name: tool.name,
                      description: tool.description,
                      inputSchema: {
                        json: tool.parameters as ToolInputSchema.JsonMember["json"],
                      },
                    },
                  })),
                },
              }
            : {}),
        };
        const transformed = await options.onPayload?.(payload, model);
        if (transformed !== undefined)
          payload = transformed as ConverseStreamCommandInput;
        const token = connection.auth === "aws" ? undefined : connection.key;
        client = new BedrockRuntimeClient({
          region: connection.region,
          profile: connection.profile,
          endpoint: bedrockEndpoint(connection),
          maxAttempts: 1,
          authSchemePreference: [token ? "httpBearerAuth" : "sigv4"],
          ...(token ? { token: { token } } : {}),
        });
        const response = await client.send(new ConverseStreamCommand(payload), {
          abortSignal: options.signal,
        });
        await options.onResponse?.(
          { status: response.$metadata.httpStatusCode ?? 200, headers: {} },
          model,
        );
        if (!response.stream)
          throw new AgentError(
            "INCOMPLETE_RESPONSE",
            "Bedrock returned no event stream",
          );
        const blocks = new Map<
          number,
          {
            text?: string;
            tool?: { id: string; name: string; json: string };
            closed: boolean;
          }
        >();
        let started = false,
          stopped = false,
          metadata = false;
        let streamBytes = 0;
        for await (const event of response.stream) {
          options.signal?.throwIfAborted();
          streamBytes += Buffer.byteLength(JSON.stringify(event));
          if (streamBytes > model.maxTokens * 128 + 1_000_000)
            throw new AgentError(
              "INCOMPLETE_RESPONSE",
              "Bedrock response exceeds the bounded stream size",
            );
          if (event.messageStart) {
            if (started || event.messageStart.role !== "assistant")
              throw new AgentError(
                "INCOMPLETE_RESPONSE",
                "Invalid Bedrock message start",
              );
            started = true;
          } else if (event.metadata) {
            const usage = event.metadata.usage;
            if (
              !stopped ||
              metadata ||
              !usage ||
              usage.inputTokens === undefined ||
              usage.outputTokens === undefined
            )
              throw new AgentError(
                "INCOMPLETE_RESPONSE",
                "Missing or invalid Bedrock usage",
              );
            result.usage.input = usage.inputTokens;
            result.usage.output = usage.outputTokens;
            result.usage.cacheRead = usage.cacheReadInputTokens ?? 0;
            result.usage.cacheWrite = usage.cacheWriteInputTokens ?? 0;
            result.usage.cacheWrite1h = usage.cacheDetails?.reduce(
              (total, detail) =>
                total + (detail.ttl === "1h" ? (detail.inputTokens ?? 0) : 0),
              0,
            );
            result.usage.totalTokens =
              usage.totalTokens ?? usage.inputTokens + usage.outputTokens;
            calculateCost(model, result.usage);
            metadata = true;
          } else if (event.messageStop) {
            if (
              !started ||
              stopped ||
              [...blocks.values()].some((block) => !block.closed)
            )
              throw new AgentError(
                "INCOMPLETE_RESPONSE",
                "Bedrock stopped with unfinished content",
              );
            const reason = event.messageStop.stopReason;
            result.stopReason =
              reason === "end_turn" || reason === "stop_sequence"
                ? "stop"
                : reason === "tool_use"
                  ? "toolUse"
                  : reason === "max_tokens"
                    ? "length"
                    : "error";
            stopped = true;
          } else if (
            event.contentBlockStart ||
            event.contentBlockDelta ||
            event.contentBlockStop
          ) {
            if (!started || stopped)
              throw new AgentError(
                "INCOMPLETE_RESPONSE",
                "Bedrock content outside a message",
              );
            const index =
              event.contentBlockStart?.contentBlockIndex ??
              event.contentBlockDelta?.contentBlockIndex ??
              event.contentBlockStop?.contentBlockIndex;
            if (index === undefined)
              throw new AgentError(
                "INCOMPLETE_RESPONSE",
                "Bedrock content has no index",
              );
            const block = blocks.get(index) ?? { closed: false };
            if (block.closed)
              throw new AgentError(
                "INCOMPLETE_RESPONSE",
                "Bedrock content already closed",
              );
            blocks.set(index, block);
            if (event.contentBlockStart) {
              const tool = event.contentBlockStart.start?.toolUse;
              if (
                !tool?.toolUseId ||
                !tool.name ||
                block.tool ||
                block.text !== undefined
              )
                throw new AgentError(
                  "INCOMPLETE_RESPONSE",
                  "Invalid Bedrock tool start",
                );
              block.tool = { id: tool.toolUseId, name: tool.name, json: "" };
            } else if (event.contentBlockDelta) {
              const delta = event.contentBlockDelta.delta;
              if (delta?.text !== undefined && !block.tool) {
                block.text = (block.text ?? "") + delta.text;
                output.push({
                  type: "text_delta",
                  contentIndex: index,
                  delta: delta.text,
                  partial: result,
                });
              } else if (delta?.toolUse?.input !== undefined && block.tool)
                block.tool.json += delta.toolUse.input;
              else
                throw new AgentError(
                  "MODEL_CAPABILITY",
                  "Unsupported Bedrock content delta",
                );
            } else {
              if (block.tool) {
                const args: unknown = JSON.parse(block.tool.json);
                if (!args || typeof args !== "object" || Array.isArray(args))
                  throw new AgentError(
                    "INCOMPLETE_RESPONSE",
                    "Invalid Bedrock tool arguments",
                  );
                result.content.push({
                  type: "toolCall",
                  id: block.tool.id,
                  name: block.tool.name,
                  arguments: args as ToolCall["arguments"],
                });
              } else if (block.text !== undefined)
                result.content.push({ type: "text", text: block.text });
              else
                throw new AgentError(
                  "INCOMPLETE_RESPONSE",
                  "Empty Bedrock content block",
                );
              block.closed = true;
            }
          } else
            throw new AgentError(
              "PROVIDER",
              "Bedrock stream reported an error or unsupported event",
            );
        }
        options.signal?.throwIfAborted();
        if (!started || !stopped || !metadata || !result.content.length)
          throw new AgentError(
            "INCOMPLETE_RESPONSE",
            "Bedrock stream ended before completion",
          );
        if (result.stopReason !== "stop" && result.stopReason !== "toolUse")
          throw new AgentError(
            "INCOMPLETE_RESPONSE",
            "Bedrock did not complete the response",
          );
        output.push({
          type: "done",
          reason: result.stopReason,
          message: result,
        });
      } catch (error) {
        const status = (
          error as { $metadata?: { httpStatusCode?: number } } | null
        )?.$metadata?.httpStatusCode;
        if (status) {
          try {
            await options.onResponse?.({ status, headers: {} }, model);
          } catch (callbackError) {
            error = callbackError;
          }
        }
        result.content = [];
        result.stopReason = options.signal?.aborted ? "aborted" : "error";
        result.errorMessage =
          error instanceof AgentError
            ? `${error.code}: ${error.message}`
            : status
              ? `Bedrock request failed: HTTP ${status}`
              : "Bedrock request failed";
        output.push({
          type: "error",
          reason: result.stopReason,
          error: result,
        });
      } finally {
        client?.destroy();
      }
    })();
    return output;
  };
  return createProvider({
    id: native.id,
    name: native.name,
    auth: native.auth,
    models: native.getModels(),
    api: { stream, streamSimple: stream },
  });
}
