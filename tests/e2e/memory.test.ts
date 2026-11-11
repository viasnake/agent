import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { createServer as portProbe } from "node:net";
import { chromium } from "playwright";
import { fixture, answer, until } from "../support.js";
import { createServer } from "../../src/server.js";

test("memory settings and inline session search preserve conflicts, sources and drafts across screen sizes", async () => {
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
  const panel = page.locator(".memory-content");
  const close = () =>
    page.getByRole("button", { name: "セッションに戻る", exact: true }).click();
  const openMemory = async () => {
    if ((page.viewportSize()?.width ?? 1280) < 768) {
      await page
        .getByRole("button", { name: "セッション一覧を開く", exact: true })
        .click();
    }
    await page.getByRole("button", { name: "設定", exact: true }).click();
    await page.getByRole("button", { name: "記憶", exact: true }).click();
  };
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
        background: getComputedStyle(node.closest(".settings-page")!)
          .backgroundColor,
      }));
      assert.notEqual(styles.color, styles.background);
    }
    await close();
    assert.equal(
      await page.locator("#message").inputValue(),
      "保存される下書き",
    );
    await row(other.id).click();
    await openMemory();
    await panel.getByRole("button", { name: "出典", exact: true }).click();
    await panel.waitFor({ state: "hidden" });
    await page.waitForFunction(
      () => document.getElementById("title")?.textContent === "認証の作業",
    );
    await page.locator(".search-current").waitFor();
    await openMemory();
    await panel
      .getByRole("button", { name: "記憶を編集", exact: true })
      .click();
    await panel.getByLabel("記憶の内容").fill("訂正した記憶");
    const originalNote = (await f.service.memory.list())[0]!;
    await f.service.memory.update(originalNote.id, {
      text: "AI が更新した記憶",
      revision: originalNote.revision,
    });
    await panel.getByRole("button", { name: "保存", exact: true }).click();
    await panel
      .getByRole("alert")
      .getByText(/更新されています/)
      .waitFor();
    assert.equal(
      await panel.getByLabel("記憶の内容").inputValue(),
      "訂正した記憶",
    );
    await panel
      .getByRole("button", { name: "再読み込み", exact: true })
      .click();
    await panel.getByText("AI が更新した記憶", { exact: true }).waitFor();
    assert.equal(
      await panel.getByLabel("記憶の内容").inputValue(),
      "訂正した記憶",
    );
    await panel.getByRole("button", { name: "保存", exact: true }).click();
    await panel.getByText("訂正した記憶", { exact: true }).waitFor();
    await close();
    const search = page.getByRole("searchbox", {
      name: "セッションを検索",
      exact: true,
    });
    const results = page.getByRole("region", {
      name: "会話本文の検索結果",
      exact: true,
    });
    await search.fill("認証");
    await results.locator(".search-result").first().waitFor();
    assert.equal(await page.getByRole("dialog").count(), 0);
    let releaseSearch!: () => void;
    const heldSearch = new Promise<void>((resolve) => {
      releaseSearch = resolve;
    });
    await page.route("**/api/history?**", async (route) => {
      const params = new URL(route.request().url()).searchParams;
      if (params.get("query") !== "遅延") return route.continue();
      if (!params.has("cursor"))
        return route.fulfill({ json: { matches: [], cursor: "held" } });
      await heldSearch;
      await route.fulfill({
        status: 503,
        json: { error: "以前の検索のエラー" },
      });
    });
    await search.fill("遅延");
    const moreRequested = page.waitForRequest(
      (request) => new URL(request.url()).searchParams.get("cursor") === "held",
    );
    await results
      .getByRole("button", { name: "さらに検索", exact: true })
      .click();
    await moreRequested;
    await search.fill("認証");
    await results.locator(".search-result").first().waitFor();
    releaseSearch();
    await page.unrouteAll({ behavior: "wait" });
    assert.equal(await results.getByRole("alert").count(), 0);
    await results.locator(".search-result").first().click();
    await page.locator(".search-current").waitFor();
    assert.equal(await search.inputValue(), "");
    await openMemory();
    await page.setViewportSize({ width: 360, height: 740 });
    assert.equal(
      await panel.evaluate(
        (node) => node.getBoundingClientRect().width <= innerWidth,
      ),
      true,
    );
    assert.equal(
      await panel.evaluate((node) => node.scrollWidth <= node.clientWidth),
      true,
    );
    await page.screenshot({ path: "test-results/memory-mobile.png" });
    await close();
    assert.equal(
      await page.locator("#message").inputValue(),
      "保存される下書き",
    );
    await openMemory();
    await page.setViewportSize({ width: 1280, height: 900 });
    await panel
      .getByRole("button", { name: "記憶を削除", exact: true })
      .click();
    const updatedNote = (await f.service.memory.list())[0]!;
    await f.service.memory.update(updatedNote.id, {
      text: "削除確認中の AI 更新",
      revision: updatedNote.revision,
    });
    await panel
      .getByRole("button", { name: "記憶の削除を確定", exact: true })
      .click();
    await panel
      .getByRole("alert")
      .getByText(/更新されています/)
      .waitFor();
    assert.equal(
      (await f.service.memory.list())[0]!.text,
      "削除確認中の AI 更新",
    );
    await panel
      .getByRole("button", { name: "再読み込み", exact: true })
      .click();
    await panel.getByText("削除確認中の AI 更新", { exact: true }).waitFor();
    await panel
      .getByRole("button", { name: "記憶を削除", exact: true })
      .click();
    await panel
      .getByRole("button", { name: "記憶の削除を確定", exact: true })
      .click();
    await panel.getByText("記憶はありません", { exact: true }).waitFor();
    await close();
    await page.reload();
    await openMemory();
    await panel.getByText("記憶はありません", { exact: true }).waitFor();
    await close();
    await panel.waitFor({ state: "hidden" });
    assert.equal(await page.getByRole("dialog").count(), 0);
    assert.equal(
      await page.getByRole("button", { name: /日次レポート/ }).count(),
      0,
    );
    assert.deepEqual(errors, []);
    assert.equal(f.faux.state.callCount, 1);
  } finally {
    await browser.close();
    await server.close();
    await f.service.close();
  }
});
