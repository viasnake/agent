import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { settingsInput } from "../src/settings.js";
import { fixture, until } from "./support.js";

const query = "Current public release information";
const source = "https://example.com/release";

function response(...output: Record<string, unknown>[]) {
  const events = output.flatMap((item, output_index) => [
    { type: "response.output_item.added", output_index, item },
    { type: "response.output_item.done", output_index, item },
  ]);
  return new Response(
    [
      ...events,
      {
        type: "response.completed",
        response: {
          id: "resp_fixture",
          status: "completed",
          output,
          usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 },
        },
      },
    ]
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function message(text: string, annotations: Record<string, unknown>[] = []) {
  return {
    id: "msg_fixture",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations }],
  };
}

test("web search uses the admitted OpenAI connection and returns provider citations", async (t) => {
  for (const auth of ["api_key", "oauth"] as const) {
    await t.test(auth, async (t) => {
      const { service, root } = await fixture([], { noModel: true });
      t.after(async () => {
        await service.close();
        await rm(root, { recursive: true, force: true });
      });
      const connection = randomUUID();
      const key =
        auth === "api_key" ? "sk-fixture-search" : "fixture-oauth-search";
      const { schemaVersion: _, ...settings } = service.settings.public();
      await service.saveSettings(
        settingsInput.parse({
          ...settings,
          models: [
            {
              id: connection,
              provider: "openai",
              auth,
              ...(auth === "api_key" ? { key } : {}),
            },
          ],
        }),
      );
      if (auth === "oauth") {
        const { authVersion } = service.settings.snapshot().models[0]!;
        await service.settings.setModelOAuth(connection, authVersion, {
          type: "oauth",
          access: key,
          refresh: "fixture-refresh",
          expires: Date.now() + 3600000,
          clientId: "oaiapp_fixture",
          scopes: ["chatgpt.tokens.use.direct"],
        });
      }
      const requests: { request: Request; body: Record<string, unknown> }[] =
        [];
      t.mock.method(
        globalThis,
        "fetch",
        async (input: string | URL | Request, init?: RequestInit) => {
          const request = new Request(input, init);
          const body = (await request.json()) as Record<string, unknown>;
          requests.push({ request, body });
          if (requests.length === 1)
            return response({
              id: "fc_search",
              type: "function_call",
              call_id: "call_search",
              status: "completed",
              name: "web_search",
              arguments: JSON.stringify({ query }),
            });
          if (requests.length === 2)
            return response(
              { id: "ws_search", type: "web_search_call", status: "completed" },
              message(`Release summary ${key}`, [
                { type: "url_citation", url: source, title: "Release notes" },
                {
                  type: "url_citation",
                  url: "javascript:alert(1)",
                  title: "Invalid",
                },
              ]),
            );
          return response(message(`See the [release notes](${source}).`));
        },
      );
      const model = "gpt-6.1-sol";
      const { id } = await service.create(
        randomUUID(),
        "Search",
        connection,
        model,
      );
      await service.send(id, randomUUID(), "Private conversation context");
      await until(
        async () => (await service.conversation(id)).status !== "running",
      );
      const conversation = await service.conversation(id);
      assert.equal(conversation.status, "idle");
      assert.equal(conversation.requests, 3);
      assert.equal(requests.length, 3);
      assert.match(JSON.stringify(requests[0]!.body), /"name":"web_search"/);
      const search = requests[1]!;
      assert.equal(search.request.url, "https://api.openai.com/v1/responses");
      assert.equal(search.request.redirect, "error");
      assert.equal(
        search.request.headers.get("authorization"),
        `Bearer ${key}`,
      );
      assert.equal(search.body.model, model);
      assert.equal(search.body.store, false);
      assert.deepEqual(search.body.tools, [{ type: "web_search" }]);
      assert.equal(search.body.tool_choice, "required");
      if (auth === "oauth")
        assert.equal(search.body.max_output_tokens, undefined);
      assert.match(JSON.stringify(search.body.input), new RegExp(query));
      assert.doesNotMatch(
        JSON.stringify(search.body.input),
        /Private conversation context/,
      );
      const transcript = JSON.stringify(requests[2]!.body.input);
      assert.match(transcript, /Release summary \[REDACTED\]/);
      assert.match(transcript, /https:\/\/example\.com\/release/);
      assert.doesNotMatch(
        transcript,
        /javascript:|fixture-search|fixture-oauth-search/,
      );
      const view = await service.view(id);
      assert.match(JSON.stringify(view.transcript), /release notes/);
      assert.equal(
        view.usage.tools.find(({ name }) => name === "web_search")?.totalTokens,
        10,
      );
      const recorded = await service.usageStatistics({ id }, ctx);
      assert.equal(recorded.tools[0]?.name, "web_search");
      assert.equal(recorded.tools[0]?.calls, 1);
      assert.equal(recorded.tools[0]?.totalTokens, 10);
    });
  }
});
