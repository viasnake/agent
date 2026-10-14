import { AgentError } from "../types.js";

// OpenAI-compatible SDK parsers may accept a syntactically incomplete JSON tool
// argument. Keep a strict copy of the wire arguments and require a terminal marker.
export class StreamCompletion {
  complete = false;
  private pending = "";
  private decoder = new TextDecoder();
  private arguments = new Map<number, string>();
  private bytes = 0;
  constructor(
    readonly responsesApi: boolean,
    readonly maxBytes: number,
  ) {}
  wrap(response: Response): Response {
    if (!response.ok || !response.body) return response;
    const transform = new TransformStream<Uint8Array, Uint8Array>({
      transform: (chunk, controller) => {
        this.bytes += chunk.length;
        if (this.bytes > this.maxBytes)
          throw new AgentError(
            "RESPONSE_SIZE",
            "Provider response exceeded its byte limit",
          );
        this.pending += this.decoder.decode(chunk, { stream: true });
        const lines = this.pending.split("\n");
        this.pending = lines.pop() ?? "";
        for (const line of lines) this.line(line.replace(/\r$/, ""));
        controller.enqueue(chunk);
      },
      flush: () => {
        this.pending += this.decoder.decode();
        if (this.pending) this.line(this.pending);
      },
    });
    return new Response(response.body.pipeThrough(transform), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
  private line(line: string): void {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (data === "[DONE]") {
      if (!this.responsesApi) this.complete = true;
      return;
    }
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    if (this.responsesApi) {
      if (value.type === "response.completed") this.complete = true;
      if (
        value.type === "response.function_call_arguments.delta" &&
        typeof value.output_index === "number" &&
        typeof value.delta === "string"
      )
        this.arguments.set(
          value.output_index,
          (this.arguments.get(value.output_index) ?? "") + value.delta,
        );
      if (
        value.type === "response.function_call_arguments.done" &&
        typeof value.output_index === "number" &&
        typeof value.arguments === "string"
      )
        this.arguments.set(value.output_index, value.arguments);
      const item = value.item as
        { type?: string; arguments?: string } | undefined;
      if (
        value.type === "response.output_item.done" &&
        item?.type === "function_call" &&
        typeof value.output_index === "number" &&
        typeof item.arguments === "string"
      )
        this.arguments.set(value.output_index, item.arguments);
      return;
    }
    const choices = value.choices as
      | Array<{
          index?: number;
          delta?: {
            tool_calls?: Array<{
              index: number;
              function?: { arguments?: string };
            }>;
          };
        }>
      | undefined;
    for (const choice of choices ?? [])
      if (choice.index === 0)
        for (const call of choice.delta?.tool_calls ?? [])
          if (call.function?.arguments !== undefined)
            this.arguments.set(
              call.index,
              (this.arguments.get(call.index) ?? "") + call.function.arguments,
            );
  }
  verify(): void {
    if (!this.complete)
      throw new AgentError(
        "INCOMPLETE_RESPONSE",
        "Provider stream ended without its terminal completion marker",
      );
    for (const value of this.arguments.values()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        throw new AgentError(
          "INCOMPLETE_RESPONSE",
          "Provider tool arguments are incomplete JSON",
        );
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new AgentError(
          "INCOMPLETE_RESPONSE",
          "Provider tool arguments must be a JSON object",
        );
    }
  }
}
