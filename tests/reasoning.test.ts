import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
  fauxProvider,
} from "@earendil-works/pi-ai";
import { fixture, until } from "./support.js";

test("reasoning projections are bounded and omit redacted blocks and provider signatures", async () => {
  const f = await fixture([
    fauxAssistantMessage([
      {
        ...fauxThinking("not-for-display"),
        redacted: true,
        thinkingSignature: "opaque-private-signature",
      },
      {
        ...fauxThinking(
          `${"x".repeat(17000)}\nAuthorization: private-token\n公開された思考テキスト`,
        ),
        thinkingSignature: "another-private-signature",
      },
      fauxText("表示する回答"),
    ]),
  ]);
  try {
    const session = await f.service.create(randomUUID(), "思考表示");
    await f.service.send(session.id, randomUUID(), "確認");
    await until(
      async () => (await f.service.conversation(session.id)).status === "idle",
    );
    const view = await f.service.view(session.id);
    const message = view.transcript
      .flatMap((entry) => entry.messages)
      .find((message) => message.role === "assistant")!;
    assert.equal(message.content, "表示する回答");
    assert.ok(message.reasoning.length <= 16000);
    assert.match(message.reasoning, /Authorization: \[REDACTED\]/);
    assert.match(message.reasoning, /公開された思考テキスト$/);
    assert.doesNotMatch(
      JSON.stringify(view),
      /not-for-display|private-token|private-signature/,
    );
  } finally {
    await f.service.close();
  }
});

test("live reasoning reaches the view while generation is still running", async () => {
  const faux = fauxProvider({
    tokensPerSecond: 40,
    models: [{ id: "faux-1", reasoning: true }],
  });
  faux.setResponses([
    fauxAssistantMessage([
      {
        ...fauxThinking("確認できた情報を整理します。".repeat(16)),
        thinkingSignature: "private-live-signature",
      },
      fauxText("確認しました。"),
    ]),
  ]);
  const f = await fixture([], { provider: faux.provider });
  try {
    const session = await f.service.create(randomUUID(), "ストリーミング");
    await f.service.send(session.id, randomUUID(), "確認");
    await until(async () => {
      const view = await f.service.view(session.id);
      if (!view.progress.reasoning) return false;
      assert.equal(view.progress.generating, true);
      assert.equal(view.conversation.status, "running");
      assert.doesNotMatch(JSON.stringify(view), /private-live-signature/);
      return true;
    });
    await until(
      async () => (await f.service.conversation(session.id)).status === "idle",
    );
  } finally {
    await f.service.close();
  }
});
