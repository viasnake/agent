import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type {
  Provider,
  AssistantMessage,
  AssistantMessageEventStream,
  AssistantMessageEvent,
  Usage,
} from "@earendil-works/pi-ai";

// Generation hooks may be skipped on failure. The provider boundary must refuse dispatch itself.
export function guardedProvider(
  provider: Provider,
  reserve: (
    sessionId: string | undefined,
    modelId: string,
    tokenReservation: number,
  ) => Promise<void | ((usage: Usage) => Promise<void>)>,
): Provider {
  function guarded(
    start: () => AssistantMessageEventStream,
    sessionId: string | undefined,
    modelId: string,
    tokenReservation: number,
  ): AssistantMessageEventStream {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      try {
        const account = await reserve(sessionId, modelId, tokenReservation);
        const upstream = start();
        let terminal: AssistantMessageEvent | undefined;
        for await (const event of upstream) {
          if (event.type === "done" || event.type === "error") terminal = event;
          else stream.push(event);
        }
        const result = await upstream.result();
        // A terminal event settles Pi immediately. Persist usage against the
        // reserved request before releasing the slot or admitting follow-ups.
        await account?.(result.usage);
        if (terminal) stream.push(terminal);
        stream.end(result);
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
        () => {
          if (
            !model.input.includes("image") &&
            context.messages.some(
              (message) =>
                Array.isArray(message.content) &&
                message.content.some((block) => block.type === "image"),
            )
          )
            throw new Error("Image input is not supported");
          return provider.stream(
            model,
            context,
            Object.assign({}, options, { maxRetries: 0, maxTokens: 8192 }),
          );
        },
        options?.sessionId,
        model.id,
        Buffer.byteLength(JSON.stringify(context)) + 8192,
      ),
    streamSimple: (model, context, options) =>
      guarded(
        () => {
          if (
            !model.input.includes("image") &&
            context.messages.some(
              (message) =>
                Array.isArray(message.content) &&
                message.content.some((block) => block.type === "image"),
            )
          )
            throw new Error("Image input is not supported");
          return provider.streamSimple(
            model,
            context,
            Object.assign({}, options, { maxRetries: 0, maxTokens: 8192 }),
          );
        },
        options?.sessionId,
        model.id,
        Buffer.byteLength(JSON.stringify(context)) + 8192,
      ),
  };
}
