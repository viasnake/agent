import { appendFile } from "node:fs/promises";

// Loaded explicitly with node --import by the PTY test, never by production code.
globalThis.fetch = async (input, init) => {
  if (String(input) !== "http://127.0.0.1:12345/v1/chat/completions")
    throw new Error("Unexpected fixture destination");
  const body = JSON.parse(String(init?.body)) as {
    messages: { role: string; content: unknown }[];
  };
  const user = body.messages.filter((m) => m.role === "user").at(-1);
  const text = JSON.stringify(user?.content);
  if (process.env.AGENT_TEST_REQUESTS)
    await appendFile(
      process.env.AGENT_TEST_REQUESTS,
      JSON.stringify({ text, messages: body.messages.length }) + "\n",
    );
  if (text.includes("fix-code-")) {
    const turn = text.includes("fix-code-third")
      ? 3
      : text.includes("fix-code-second")
        ? 2
        : 1;
    const completed = body.messages.at(-1)?.role === "tool";
    const delta = completed
      ? {
          role: "assistant",
          content: JSON.stringify({
            outcome: "completed",
            summary: `PTY coding turn ${turn} verified`,
            artifacts: [],
            unresolved: [],
          }),
        }
      : {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: `edit-${turn}`,
              type: "function",
              function: {
                name: "edit_file",
                arguments: JSON.stringify({
                  path: "app.txt",
                  oldText:
                    turn === 1 ? "baseline" : turn === 2 ? "first" : "second",
                  newText:
                    turn === 1 ? "first" : turn === 2 ? "second" : "third",
                }),
              },
            },
          ],
        };
    return new Response(
      `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "worker-fixture", choices: [{ index: 0, delta, finish_reason: completed ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    );
  }
  const long = text.includes("long-output");
  let index = 0;
  const response = new ReadableStream<Uint8Array>({
    async pull(controller) {
      await new Promise((r) => setTimeout(r, long ? 30 : 70));
      if (init?.signal?.aborted) {
        controller.error(new DOMException("Aborted", "AbortError"));
        return;
      }
      if (index < (long ? 2000 : 6)) {
        const content =
          index === 0
            ? "こんにちは PTY 応答 "
            : long
              ? "全角・結合é・長い出力です。".repeat(40)
              : "日本語 ";
        controller.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "worker-fixture", choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] })}\n\n`,
          ),
        );
        index++;
      } else {
        controller.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "worker-fixture", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 } })}\n\ndata: [DONE]\n\n`,
          ),
        );
        controller.close();
      }
    },
  });
  return new Response(response, {
    headers: { "content-type": "text/event-stream" },
  });
};
process.on("SIGUSR2", () => {
  throw new Error("injected PTY failure");
});
