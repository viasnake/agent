import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { createServer as portProbe } from "node:net";
import { chromium } from "playwright";
import { fixture, answer, until } from "../support.js";
import { createServer } from "../../src/server.js";

test("memory, cross-session source navigation and daily records work in light, dark and mobile layouts", async () => {
  const f = await fixture([answer("認証の設定を確認しました")]);
  const source = await f.service.create(randomUUID(), "認証の作業");
  const other = await f.service.create(randomUUID(), "別のセッション");
  await f.service.send(source.id, randomUUID(), "認証を確認して");
  await until(
    async () => (await f.service.conversation(source.id)).status === "idle",
  );
  const probe = portProbe();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const address = probe.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((done) => probe.close(() => done()));
  const origin = `http://127.0.0.1:${port}`;
  f.config.server.origins = [origin];
  const server = await createServer(f.service, resolve("dist/web") + "/");
  await server.listen({ host: "127.0.0.1", port });
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    timezoneId: "Asia/Tokyo",
    reducedMotion: "reduce",
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const row = (id: string) =>
    page.locator(`[data-session-id="${id}"] .conversation-item`);
  const panel = page.locator(".memory-dialog");
  const close = () =>
    page
      .getByRole("button", { name: "記憶パネルを閉じる", exact: true })
      .click();
  try {
    await page.goto(origin);
    await row(source.id).click();
    await page.getByText("認証の設定を確認しました", { exact: true }).waitFor();
    await page.locator("#message").fill("保存される下書き");
    await page
      .locator(".assistant-message")
      .getByRole("button", { name: "メッセージを記憶", exact: true })
      .click();
    await panel.getByLabel("記憶の内容").fill("認証の変更時は接続を確認する");
    await panel.getByRole("button", { name: "保存", exact: true }).click();
    await panel
      .getByText("認証の変更時は接続を確認する", { exact: true })
      .waitFor();
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await mkdir("test-results", { recursive: true });
      await page.screenshot({ path: `test-results/memory-${colorScheme}.png` });
      const styles = await panel.locator(".memory-note").evaluate((node) => ({
        color: getComputedStyle(node).color,
        background: getComputedStyle(node.closest("dialog")!).backgroundColor,
      }));
      assert.notEqual(styles.color, styles.background);
    }
    await close();
    assert.equal(
      await page.locator("#message").inputValue(),
      "保存される下書き",
    );
    await row(other.id).click();
    await page.getByRole("button", { name: "記憶を開く", exact: true }).click();
    await panel.getByRole("button", { name: "出典", exact: true }).click();
    await panel.waitFor({ state: "hidden" });
    await page.waitForFunction(
      () => document.getElementById("title")?.textContent === "認証の作業",
    );
    await page.locator(".search-current").waitFor();
    await page.getByRole("button", { name: "記憶を開く", exact: true }).click();
    await panel
      .getByRole("button", { name: "記憶を編集", exact: true })
      .click();
    await panel.getByLabel("記憶の内容").fill("訂正した記憶");
    await panel.getByRole("button", { name: "保存", exact: true }).click();
    await panel.getByText("訂正した記憶", { exact: true }).waitFor();
    await panel.getByRole("button", { name: "検索", exact: true }).click();
    await panel.getByRole("searchbox").fill("認証");
    await panel.locator(".memory-result").first().waitFor();
    await panel.getByRole("button", { name: "日報", exact: true }).click();
    await panel.locator(".memory-result").first().waitFor();
    assert.match((await panel.textContent()) ?? "", /Asia\/Tokyo/);
    assert.match((await panel.textContent()) ?? "", /認証/);
    await page.setViewportSize({ width: 360, height: 740 });
    assert.equal(
      await panel.evaluate(
        (node) => node.getBoundingClientRect().width <= innerWidth,
      ),
      true,
    );
    await page.screenshot({ path: "test-results/memory-mobile.png" });
    await page.setViewportSize({ width: 1280, height: 900 });
    await panel.getByRole("button", { name: "記憶", exact: true }).click();
    await panel
      .getByRole("button", { name: "記憶を削除", exact: true })
      .click();
    await panel
      .getByRole("button", { name: "記憶の削除を確定", exact: true })
      .click();
    await panel.getByText("記憶はありません", { exact: true }).waitFor();
    await close();
    await page.reload();
    await page.getByRole("button", { name: "記憶を開く", exact: true }).click();
    await panel.getByText("記憶はありません", { exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await panel.waitFor({ state: "hidden" });
    assert.deepEqual(errors, []);
    assert.equal(f.faux.state.callCount, 1);
  } finally {
    await browser.close();
    await server.close();
    await f.service.close();
  }
});
