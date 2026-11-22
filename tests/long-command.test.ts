import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { redactCommandPreview } from "../src/long-command.js";
import { answer, call, fixture, until } from "./support.js";

const messages = (
  view: Awaited<
    ReturnType<Awaited<ReturnType<typeof fixture>>["service"]["view"]>
  >,
) => view.transcript.flatMap((entry) => entry.messages);

function commandId(text: string) {
  const id = /Command ID: ([0-9a-f-]{36})/.exec(text)?.[1];
  assert.ok(id);
  return id;
}

test("running command shows fresh output, returns its actual exit code, and cannot be checked after the response", async (t) => {
  const f = await fixture([], { commandSeconds: 1 });
  t.after(async () => {
    await f.service.close();
    await rm(f.root, { recursive: true, force: true });
  });
  const { id } = await f.service.create(randomUUID(), "command");
  let handle = "";
  f.faux.setResponses([
    call("bash_start", {
      command: `echo initial; yes noise | head -c 100000; echo; echo latest-marker; while [ ! -f attachments/release ]; do sleep .1; done; echo finished; exit 7`,
      timeout: 12,
    }),
    (context) => {
      const result = context.messages.findLast(
        (message) => message.role === "toolResult",
      );
      const text = JSON.stringify(result?.content);
      assert.match(text, /State: running/);
      handle = commandId(text);
      return fauxAssistantMessage(
        fauxToolCall("bash_status", { commandId: handle, waitSeconds: 10 }),
        { stopReason: "toolUse" },
      );
    },
    answer("Command checked."),
  ]);
  await f.service.send(id, randomUUID(), "run it");
  await until(async () => {
    const preview = (await f.service.view(id)).command;
    return (
      preview?.state === "running" && preview.output.includes("latest-marker")
    );
  });
  assert.ok((await f.service.view(id)).command!.output.length < 9000);
  await until(async () => !!handle);
  await writeFile(
    join(f.root, "work/conversations", id, "attachments/release"),
    "",
  );
  await until(async () => (await f.service.conversation(id)).status === "idle");
  const view = await f.service.view(id);
  assert.equal(view.command, undefined);
  const status = messages(view).find(
    (message) => message.toolName === "bash_status",
  );
  assert.ok(status?.isError);
  assert.match(status.content, /State: exited\nExit code: 7/);
  assert.match(status.content, /finished/);
  f.faux.setResponses([
    call("bash_status", { commandId: handle, waitSeconds: 0 }),
    answer("No stale command."),
  ]);
  await f.service.send(id, randomUUID(), "check the old ID again");
  await until(async () => (await f.service.conversation(id)).status === "idle");
  assert.match(
    messages(await f.service.view(id)).find(
      (message) => message.toolName === "bash_status",
    )!.content,
    /見つかりません/,
  );
});

test("explicit stop, response completion, and user stop all end a running command", async (t) => {
  const f = await fixture();
  t.after(async () => {
    await f.service.close();
    await rm(f.root, { recursive: true, force: true });
  });
  for (const ending of ["tool", "answer", "user"] as const) {
    const { id } = await f.service.create(randomUUID(), ending);
    const start = call("bash_start", {
      command: "echo started; sleep 3; touch outputs/not-stopped",
    });
    f.faux.setResponses([
      start,
      ending === "tool"
        ? (context) =>
            fauxAssistantMessage(
              fauxToolCall("bash_stop", {
                commandId: commandId(
                  JSON.stringify(
                    context.messages.findLast(
                      (message) => message.role === "toolResult",
                    )?.content,
                  ),
                ),
              }),
              { stopReason: "toolUse" },
            )
        : ending === "user"
          ? async (_context, options) => {
              await new Promise<void>((resolve) => {
                if (options?.signal?.aborted) resolve();
                else
                  options?.signal?.addEventListener("abort", () => resolve(), {
                    once: true,
                  });
              });
              return fauxAssistantMessage("stopped");
            }
          : answer("end response"),
      ...(ending === "tool" ? [answer("command stopped")] : []),
    ]);
    await f.service.send(id, randomUUID(), "start and stop");
    if (ending === "user") {
      await until(
        async () =>
          (await f.service.view(id)).command?.output.includes("started") ===
          true,
      );
      await f.service.stop(id);
    }
    await until(
      async () =>
        (await f.service.conversation(id)).status ===
        (ending === "user" ? "interrupted" : "idle"),
    );
    if (ending === "tool")
      assert.match(
        messages(await f.service.view(id)).find(
          (m) => m.toolName === "bash_stop",
        )!.content,
        /State: stopped/,
      );
    assert.equal((await f.service.view(id)).command, undefined);
    await assert.rejects(
      access(join(f.root, "work/conversations", id, "outputs/not-stopped")),
      { code: "ENOENT" },
    );
  }
});

test("live preview protects split, overlapping, and clipped configured secrets", () => {
  const preview = (text: string, truncated = false) =>
    redactCommandPreview({ text, truncated }, [
      "token-value",
      "value-more",
      "unprinted",
    ]);
  assert.equal(preview("hello token-val"), "hello ");
  assert.equal(preview("hello token-value-more !"), "hello [REDACTED] !");
  assert.equal(preview("oken-value\nsafe message", true), "safe message");
  assert.equal(preview("value after missing header", true), "");
  assert.doesNotMatch(
    preview("authorization: Bearer other\nsafe"),
    /Bearer other/,
  );
});
