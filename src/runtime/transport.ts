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
        const bytes = Buffer.byteLength(JSON.stringify(context));
        const reservation = request.beforeRequest(bytes);
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
        lastFailure = error;
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
