import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { answer, call, fixture, until } from "./support.js";

const question = {
  question: "比較するブランチは？",
  options: ["master", "release"],
};
const messages = (
  view: Awaited<
    ReturnType<Awaited<ReturnType<typeof fixture>>["service"]["view"]>
  >,
) => view.transcript.flatMap((entry) => entry.messages);

test("a choice ends the response and is validated, deduplicated, and recorded as user input", async (t) => {
  const f = await fixture([call("request_user_input", question)]);
  t.after(async () => {
    await f.service.close();
    await rm(f.root, { recursive: true, force: true });
  });
  const { id } = await f.service.create(randomUUID(), "choose");
  await f.service.send(id, randomUUID(), "compare");
  await until(async () => !!(await f.service.view(id)).question);
  const pending = (await f.service.view(id)).question!;
  assert.deepEqual(pending.options, question.options);
  assert.equal(f.faux.state.callCount, 1);
  const { id: other } = await f.service.create(randomUUID(), "other");
  const choose = (id: string, requestId: string, option: number) =>
    f.service.send(id, requestId, "", false, [], {
      choice: { entryId: pending.entryId, option },
    });
  await assert.rejects(choose(other, randomUUID(), 0), { statusCode: 409 });
  await assert.rejects(choose(id, randomUUID(), 4), { statusCode: 409 });
  f.faux.setResponses([answer("verified choice")]);
  const key = randomUUID();
  assert.deepEqual(await choose(id, key, 1), { id });
  assert.deepEqual(await choose(id, key, 1), { id });
  await assert.rejects(choose(id, key, 0), { statusCode: 409 });
  await until(async () => (await f.service.conversation(id)).status === "idle");
  await assert.rejects(choose(id, randomUUID(), 0), { statusCode: 409 });
  const view = await f.service.view(id);
  assert.equal(view.question, undefined);
  assert.equal(
    messages(view).filter(
      (message) =>
        message.role === "user" && message.content.startsWith("選択：release"),
    ).length,
    1,
  );
});

test("a question in a mixed round cannot run a sibling file mutation", async (t) => {
  const f = await fixture([
    fauxAssistantMessage(
      [
        fauxToolCall("write", {
          path: "outputs/unwanted",
          content: "must not write",
        }),
        fauxToolCall("request_user_input", question),
      ],
      { stopReason: "toolUse" },
    ),
    call("request_user_input", question),
  ]);
  t.after(async () => {
    await f.service.close();
    await rm(f.root, { recursive: true, force: true });
  });
  const { id } = await f.service.create(randomUUID(), "isolated question");
  await f.service.send(id, randomUUID(), "choose first");
  await until(async () => !!(await f.service.view(id)).question);
  assert.match(
    messages(await f.service.view(id)).find(
      (message) => message.toolName === "write",
    )!.content,
    /on its own/,
  );
  assert.equal((await f.service.files(id)).files?.length, 0);
});
