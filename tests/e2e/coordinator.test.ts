import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { fixture, answer } from "../support.js";
import { createServer } from "../../src/server.js";

test("default assistant, persistent composer, scoped work controls and Markdown knowledge in light and dark", async () => {
  const f = await fixture([answer("メモを受け取りました")]);
  const probe = await createServer(f.service);
  const origin = await probe.listen({ host: "127.0.0.1", port: 0 });
  await probe.close();
  f.config.server.origins = [origin];
  const server = await createServer(f.service, resolve("dist/web") + "/");
  await server.listen({
    host: "127.0.0.1",
    port: Number(new URL(origin).port),
  });
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(origin);
    await page
      .getByRole("heading", { name: "アシスタント", exact: true })
      .waitFor();
    await page.locator("#message").fill("メモだけです");
    await page.locator("#send").click();
    await page.getByText("メモを受け取りました", { exact: true }).waitFor();
    assert.equal((await f.service.list()).length, 1);
    assert.equal(
      await page
        .getByRole("button", { name: "回答を再生成", exact: true })
        .isEnabled(),
      false,
    );
    await page.locator("#message").fill("未送信の下書き");
    const work = page.getByLabel("任せている作業", { exact: true });
    await work.locator("summary").click();
    await work.getByRole("button", { name: "すべて停止", exact: true }).click();
    await work
      .getByRole("button", { name: "自動継続を許可", exact: true })
      .waitFor();
    assert.equal(await page.locator("#message").inputValue(), "未送信の下書き");
    await page.getByRole("button", { name: "設定", exact: true }).click();
    await page.getByRole("button", { name: "記憶", exact: true }).click();
    const knowledge = page.getByRole("region", { name: "アシスタントの記憶" });
    await knowledge.getByRole("button", { name: "記憶を追加" }).click();
    await knowledge.getByLabel("題名", { exact: true }).fill("確認した条件");
    await knowledge
      .getByLabel("Markdown", { exact: true })
      .fill("## 決定\n- 原文を保存する");
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
      const surface = await knowledge
        .getByLabel("Markdown", { exact: true })
        .evaluate((node) => {
          const style = getComputedStyle(node);
          return { color: style.color, background: style.backgroundColor };
        });
      assert.notEqual(surface.color, surface.background);
      assert.equal(
        await knowledge.getByLabel("Markdown", { exact: true }).isVisible(),
        true,
      );
    }
    await knowledge
      .getByRole("button", { name: "記憶を保存", exact: true })
      .click();
    await page.getByText("記憶を保存しました", { exact: true }).waitFor();
    assert.equal(
      (await f.service.coordinator.knowledge.list("原文")).notes.length,
      1,
    );
    await page
      .getByRole("button", { name: "アシスタントを開く", exact: true })
      .click();
    assert.equal(await page.locator("#message").inputValue(), "未送信の下書き");
    await page.reload();
    await page
      .getByRole("heading", { name: "アシスタント", exact: true })
      .waitFor();
    assert.equal((await f.service.list()).length, 1);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await server.close();
    await f.service.close();
  }
});
