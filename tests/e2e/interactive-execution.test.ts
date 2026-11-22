import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { createServer as portProbe } from "node:net";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { chromium, type Browser } from "playwright";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createServer } from "../../src/server.js";
import { answer, call, fixture, until } from "../support.js";

test("the conversation displays live command output and submits a choice without discarding a draft", async (t) => {
  const f = await fixture([
    call("bash_start", {
      command:
        "echo first-log; while [ ! -f attachments/release ]; do sleep .1; done; echo later-log; exec sleep 30",
    }),
    async () => {
      await until(
        async () =>
          (await f.service.view(id)).command?.output.includes("later-log") ===
          true,
      );
      await until(async () => allowQuestion);
      return fauxAssistantMessage(
        fauxToolCall("request_user_input", {
          question: "どちらを使いますか？",
          options: ["現在のブランチ", "指定のブランチ"],
        }),
        { stopReason: "toolUse" },
      );
    },
    answer("選択を受け取りました。"),
  ]);
  let allowQuestion = false;
  t.after(async () => {
    allowQuestion = true;
    await f.service.close();
    await rm(f.root, { recursive: true, force: true });
  });
  const { id } = await f.service.create(randomUUID(), "Interactive tools");
  const probe = portProbe();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const address = probe.address();
  assert.ok(address && typeof address !== "string");
  const { port } = address;
  await new Promise<void>((done) => probe.close(() => done()));
  const origin = `http://127.0.0.1:${port}`;
  f.config.server.origins = [origin];
  const app = await createServer(f.service, resolve("dist/web") + "/");
  await app.listen({ host: "127.0.0.1", port });
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ args: ["--no-sandbox"] });
    const page = await browser.newPage({ colorScheme: "dark" });
    await page.goto(origin);
    const session = page.locator(
      `[data-session-id="${id}"] .conversation-item`,
    );
    await session.click();
    const composer = page.locator("#message");
    await composer.fill("始めてください");
    await page.locator("#send").click();
    await page.getByText("コマンドの途中出力", { exact: true }).click();
    await page
      .locator("details[open] pre")
      .filter({ hasText: /^first-log\s*$/ })
      .waitFor();
    await writeFile(
      join(f.root, "work/conversations", id, "attachments/release"),
      "",
    );
    await page
      .locator("details[open] pre")
      .filter({ hasText: "later-log" })
      .waitFor();
    allowQuestion = true;
    const choose = page.getByRole("button", {
      name: "指定のブランチ",
      exact: true,
    });
    await choose.waitFor();
    assert.equal((await f.service.view(id)).command, undefined);
    assert.equal(
      await page.getByText("コマンドの途中出力", { exact: true }).count(),
      0,
    );
    await composer.fill("まだ送らない下書き");
    await page.reload();
    await session.click();
    await choose.focus();
    await page.keyboard.press("Enter");
    await page.getByText("選択を受け取りました。", { exact: true }).waitFor();
    assert.equal(
      await page.getByText("選択：指定のブランチ", { exact: true }).count(),
      1,
    );
    assert.equal(await composer.inputValue(), "まだ送らない下書き");
    assert.equal(await choose.count(), 0);
  } finally {
    await browser?.close();
    await app.close();
  }
});
