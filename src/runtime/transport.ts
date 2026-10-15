import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Connection } from "../config.js";
import { endpointFetch } from "../network.js";
import { AgentError, type RuntimeRequest } from "../types.js";
import { endpoint } from "./providers.js";
import { StreamCompletion } from "./stream.js";
import {
  maxConversationImageBytes,
  maxConversationImages,
  maxImageBytes,
  validateImage,
} from "../images.js";
import { sha256 } from "../util.js";
export function normalizePayload(
  payload: unknown,
  connection: Connection,
  maxTokens: number,
): unknown {
  if (!payload || typeof payload !== "object")
    throw new AgentError("PROVIDER", "Expected a model request object");
  const body = { ...(payload as Record<string, unknown>) };
  if (connection.type === "sarashina") {
    delete body.stream_options;
    delete body.max_tokens;
    delete body.store;
    body.max_completion_tokens = Math.min(maxTokens, 8000);
    if (Array.isArray(body.tools) && body.tools.length)
      body.tool_choice = "auto";
  }
  if (connection.type === "chatgpt") {
    body.store = false;
    body.stream = true;
    delete body.max_output_tokens;
  }
  return body;
}
function failure(model: Model<Api>, error: unknown): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage:
      error instanceof AgentError
        ? error.message
        : "Model request failed; inspect connection status",
    timestamp: Date.now(),
  };
}
function responseFailureCode(
  result: AssistantMessage,
  runSignal: AbortSignal,
  requestSignal: AbortSignal,
): string {
  if (runSignal.aborted) return "CANCELLED";
  if (requestSignal.aborted) return "REQUEST_TIMEOUT";
  if (
    result.stopReason === "length" ||
    /stream ended|unfinished tool call/i.test(result.errorMessage ?? "")
  )
    return "INCOMPLETE_RESPONSE";
  if (/\b429\b|RESOURCE_EXHAUSTED/.test(result.errorMessage ?? ""))
    return "QUOTA";
  if (
    /\b40[13]\b|UNAUTHENTICATED|PERMISSION_DENIED/.test(
      result.errorMessage ?? "",
    )
  )
    return "AUTH";
  return "PROVIDER";
}
export function guardModelStream(
  runtime: ModelRuntime,
  model: Model<Api>,
  conn: Connection,
  request: RuntimeRequest,
  timeoutSeconds: number,
): () => void {
  const originalStream = runtime.streamSimple.bind(runtime);
  let lastFailure: unknown;
  // All SDK inference paths go through this per-session instance. Automatic compaction,
  // retries and cache warming are disabled; the harness owns retry and context boundaries.
  runtime.streamSimple = (requested, context, options) => {
    const output = createAssistantMessageEventStream();
    void (async () => {
      try {
        request.signal.throwIfAborted();
        if (
          requested.id !== model.id ||
          requested.provider !== model.provider ||
          requested.baseUrl !== model.baseUrl
        )
          throw new AgentError(
            "MODEL_SWITCH",
            "Model changes inside a task are forbidden",
          );
        const imageData = new Map<string, { data: Buffer; mimeType: string }>();
        let imageOccurrences = 0;
        let occurrenceBytes = 0;
        const visitImages = (value: unknown): void => {
          if (!value || typeof value !== "object") return;
          if (Array.isArray(value)) {
            for (const item of value) visitImages(item);
            return;
          }
          const record = value as Record<string, unknown>;
          if (record.type === "image") {
            if (
              typeof record.data !== "string" ||
              typeof record.mimeType !== "string"
            )
              throw new AgentError(
                "IMAGE_INVALID",
                "Invalid image in model history",
              );
            const encoded = record.data;
            const maxEncodedBytes = Math.ceil(maxImageBytes / 3) * 4;
            if (
              encoded.length > maxEncodedBytes ||
              encoded.length % 4 !== 0 ||
              !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
                encoded,
              )
            )
              throw new AgentError(
                "IMAGE_INVALID",
                "Invalid image in model history",
              );
            const padding = encoded.endsWith("==")
              ? 2
              : encoded.endsWith("=")
                ? 1
                : 0;
            const decodedBytes = (encoded.length / 4) * 3 - padding;
            if (!decodedBytes || decodedBytes > maxImageBytes)
              throw new AgentError(
                "IMAGE_SIZE",
                "Image history exceeds the per-image size limit",
              );
            imageOccurrences++;
            occurrenceBytes += decodedBytes;
            if (
              imageOccurrences > maxConversationImages ||
              occurrenceBytes > maxConversationImageBytes
            )
              throw new AgentError(
                "IMAGE_LIMIT",
                "Image history exceeds the conversation image limits",
              );
            const digest = sha256(encoded);
            const existing = imageData.get(digest);
            if (existing && existing.mimeType !== record.mimeType)
              throw new AgentError(
                "IMAGE_FORMAT",
                "Conflicting image MIME types",
              );
            if (!existing) {
              const data = Buffer.from(encoded, "base64");
              if (
                data.length !== decodedBytes ||
                data.toString("base64") !== encoded
              )
                throw new AgentError(
                  "IMAGE_INVALID",
                  "Invalid image in model history",
                );
              imageData.set(digest, { data, mimeType: record.mimeType });
            }
          }
          for (const item of Object.values(record)) visitImages(item);
        };
        visitImages(context);
        if (imageOccurrences && !model.input.includes("image"))
          throw new AgentError(
            "NO_IMAGE_MODEL",
            `Model ${model.id} does not accept image content`,
          );
        for (const image of imageData.values())
          await validateImage(image.data, image.mimeType);
        const textContext = JSON.parse(JSON.stringify(context)) as unknown;
        const removeImageData = (value: unknown): void => {
          if (!value || typeof value !== "object") return;
          if (Array.isArray(value)) {
            for (const item of value) removeImageData(item);
            return;
          }
          const record = value as Record<string, unknown>;
          if (record.type === "image") record.data = "";
          for (const item of Object.values(record)) removeImageData(item);
        };
        removeImageData(textContext);
        const textBytes = Buffer.byteLength(JSON.stringify(textContext));
        const imageCount = imageOccurrences;
        const estimatedImageTokens = imageCount * 8192;
        const bytes = textBytes + estimatedImageTokens * 3;
        const reservation = request.beforeRequest(
          bytes,
          imageCount,
          estimatedImageTokens,
        );
        const signal = AbortSignal.any([
          request.signal,
          AbortSignal.timeout(timeoutSeconds * 1000),
        ]);
        let dispatched = false;
        const completion = new StreamCompletion(
          conn.type === "chatgpt",
          model.maxTokens * 128 + 1_000_000,
        );
        const guardedFetch = endpointFetch(
          endpoint(conn),
          signal,
          (status, retryAfter) => {
            request.onEvent("provider_response", { status, retryAfter });
            if (status === 429)
              lastFailure = new AgentError(
                "QUOTA",
                "Provider rate limit reached",
              );
            else if (status === 401 || status === 403)
              lastFailure = new AgentError(
                "AUTH",
                "Provider authentication or model access failed",
              );
          },
        );
        const stream = originalStream(requested, context, {
          ...options,
          signal,
          maxTokens: model.maxTokens,
          maxRetries: 0,
          timeoutMs: timeoutSeconds * 1000,
          // Pi's native Gemini adapter rejects custom fetch. Its fixed native endpoint,
          // explicit key, disabled retries, and abort signal are checked at this boundary.
          fetch:
            conn.type === "gemini"
              ? undefined
              : async (input, init) => {
                  if (dispatched)
                    throw new AgentError(
                      "RETRY_DENIED",
                      "Unexpected SDK retry was blocked",
                    );
                  dispatched = true;
                  return completion.wrap(await guardedFetch(input, init));
                },
          transport: "sse",
          cacheRetention: "none",
          onPayload: (payload) =>
            normalizePayload(payload, conn, model.maxTokens),
        });
        // Preview text is explicitly uncommitted. Tool arguments and final state
        // remain behind completion verification before reaching Pi's dispatcher.
        for await (const event of stream) {
          if (event.type === "text_delta")
            request.onEvent("text_delta", { text: event.delta });
        }
        const result = await stream.result();
        const cost =
          conn.billing === "local" || conn.billing === "beta"
            ? 0
            : conn.billing === "api" && result.usage.cost.total > 0
              ? result.usage.cost.total
              : null;
        request.afterRequest(reservation, {
          input: result.usage.totalTokens > 0 ? result.usage.input : null,
          output: result.usage.totalTokens > 0 ? result.usage.output : null,
          costUsd: cost,
        });
        if (!["stop", "toolUse"].includes(result.stopReason)) {
          if (!lastFailure) {
            const code = responseFailureCode(result, request.signal, signal);
            lastFailure = new AgentError(
              code,
              `Model response ended with ${result.stopReason}`,
            );
          }
          output.push({
            type: "error",
            reason: "error",
            error: {
              ...result,
              content: [],
              stopReason: "error",
              errorMessage: (lastFailure as Error).message,
            },
          });
          return;
        }
        if (conn.type !== "gemini") completion.verify();
        // No partial tool arguments escape this adapter. Only a complete final response
        // reaches Pi's dispatcher, which then validates every registered tool schema.
        output.push({ type: "start", partial: result });
        output.push({
          type: "done",
          reason: result.stopReason as "stop" | "toolUse",
          message: result,
        });
      } catch (error) {
        lastFailure =
          error instanceof AgentError
            ? error
            : new AgentError(
                "PROVIDER",
                "Model request failed; inspect connection status",
              );
        output.push({
          type: "error",
          reason: "error",
          error: failure(model, error),
        });
      }
    })();
    return output;
  };
  return () => {
    if (lastFailure) throw lastFailure;
  };
}
