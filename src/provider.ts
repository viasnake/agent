import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type {
  Provider,
  AssistantMessage,
  AssistantMessageEventStream,
} from "@earendil-works/pi-ai";

// Generation hooks may be skipped on failure. The provider boundary must refuse dispatch itself.
export function guardedProvider(
  provider: Provider,
  reserve: (sessionId: string | undefined, modelId: string) => Promise<void>,
  onError: (
    message: string,
    sessionId: string | undefined,
    modelId: string,
  ) => void,
): Provider {
  function guarded(
    start: () => AssistantMessageEventStream,
    sessionId: string | undefined,
    modelId: string,
  ): AssistantMessageEventStream {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      try {
        await reserve(sessionId, modelId);
        const upstream = start();
        for await (const event of upstream) {
          if (event.type === "error")
            onError(
              event.error.errorMessage ?? "provider error",
              sessionId,
              modelId,
            );
          stream.push(event);
        }
        stream.end(await upstream.result());
      } catch {
        // No request was dispatched when admission fails; don't expose host exceptions to prompts.
        const error: AssistantMessage = {
          role: "assistant",
          api: "host-gate",
          provider: provider.id,
          model: "",
          content: [],
          stopReason: "error",
          errorMessage: "HOST_GATE: dispatch refused",
          timestamp: Date.now(),
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
        };
        stream.push({ type: "error", reason: "error", error });
        stream.end(error);
      }
    })();
    return stream;
  }
  return {
    ...provider,
    stream: (model, context, options) =>
      guarded(
        () =>
          provider.stream(
            model,
            context,
            Object.assign({}, options, { maxRetries: 0, maxTokens: 8192 }),
          ),
        options?.sessionId,
        model.id,
      ),
    streamSimple: (model, context, options) =>
      guarded(
        () =>
          provider.streamSimple(
            model,
            context,
            Object.assign({}, options, { maxRetries: 0, maxTokens: 8192 }),
          ),
        options?.sessionId,
        model.id,
      ),
  };
}
