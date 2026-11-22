import { returnToSession } from "./navigation.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { createServer as portProbe } from "node:net";
import { chromium } from "playwright";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createServer } from "../../src/server.js";
import { fixture, answer, call, until } from "../support.js";

test("session actions, drafts, history search and explicit edit/regenerate/fork work through the real browser", async () => {
  const f = await fixture([
    answer(
      "保存済みの応答\n\n```javascript\nconst greeting = '<script>unsafe()</script>';\n```\n",
    ),
  ]);
  const a = await f.service.create(randomUUID(), "セッション A");
  const b = await f.service.create(randomUUID(), "セッション B");
  await f.service.send(a.id, randomUUID(), "最初の検索ワード");
  await until(
    async () => (await f.service.conversation(a.id)).status === "idle",
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
  const context = await browser.newContext({
    reducedMotion: "reduce",
    timezoneId: "Asia/Tokyo",
    permissions: ["clipboard-read", "clipboard-write"],
    viewport: { width: 1360, height: 960 },
  });
  const page = await context.newPage();
  const errors: string[] = [];
  let subscriptions = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/events")) subscriptions++;
  });
  page.on("pageerror", (error) => errors.push(error.message));
  const row = (id: string) => page.locator(`[data-session-id="${id}"]`);
  const more = (id: string) => row(id).locator(".session-more").click();
  try {
    await page.goto(origin);
    await row(a.id).locator(".conversation-item").click();
    await page.getByText("保存済みの応答", { exact: true }).waitFor();
    assert.equal(
      await page.locator(".conversation-header .session-menu").count(),
      0,
    );
    assert.equal(
      await page.locator(".message-actions button").first().textContent(),
      "",
    );
    const previousActions = page
      .locator(".user-message .message-actions")
      .first();
    await previousActions
      .getByRole("button", { name: "メッセージをコピー", exact: true })
      .focus();
    assert.equal(
      await previousActions.evaluate((node) => getComputedStyle(node).opacity),
      "1",
    );
    assert.ok(await page.locator(".markdown .hljs-keyword").count());
    assert.equal(
      await page.evaluate(() => Object.hasOwn(window, "unsafe")),
      false,
    );
    await page
      .getByRole("button", { name: "コードをコピー", exact: true })
      .click();
    assert.equal(
      await page.evaluate(() => navigator.clipboard.readText()),
      "const greeting = '<script>unsafe()</script>';\n",
    );
    const copy = page
      .locator(".assistant-message")
      .getByRole("button", { name: "メッセージをコピー", exact: true });
    await copy.click();
    await page.waitForFunction(
      () => !!document.querySelector('.assistant-message [data-copied="true"]'),
    );
    assert.match(
      await page.evaluate(() => navigator.clipboard.readText()),
      /保存済みの応答/,
    );
    await page
      .locator(".assistant-message")
      .getByRole("button", { name: "引用して返信", exact: true })
      .click();
    assert.match(
      await page.locator("#message").inputValue(),
      /^> 保存済みの応答/,
    );
    await page.locator("#message").fill("引用前の下書き");
    await page
      .locator(".markdown p")
      .first()
      .evaluate((node) => {
        const range = document.createRange();
        range.selectNodeContents(node);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
      });
    const selection = page.getByRole("toolbar", {
      name: "選択したテキストの操作",
    });
    await selection
      .getByRole("button", { name: "引用して返信", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        (document.querySelector("#message") as HTMLTextAreaElement).value ===
        "引用前の下書き\n\n> 保存済みの応答\n\n",
    );
    assert.equal(
      await page
        .locator("#message")
        .evaluate((node) => node === document.activeElement),
      true,
    );
    await selection.waitFor({ state: "hidden" });
    // Controls and selections spanning multiple messages are not quotable.
    await page.locator(".code-header").evaluate((node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
    });
    await page.evaluate(() => new Promise(requestAnimationFrame));
    assert.equal(await selection.count(), 0);
    await page.evaluate(() => {
      const range = document.createRange();
      range.setStart(document.querySelector(".user-text")!.firstChild!, 0);
      range.setEndAfter(document.querySelector(".markdown p")!);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
    });
    await page.evaluate(() => new Promise(requestAnimationFrame));
    assert.equal(await selection.count(), 0);
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await more(a.id);
    const saved = page.waitForEvent("download");
    await page.getByRole("link", { name: "会話を保存", exact: true }).click();
    assert.match((await saved).suggestedFilename(), /\.md$/);

    await page.locator("#message").fill("A の下書き");
    await page.locator("#attachments").setInputFiles({
      name: "draft.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("draft"),
    });
    const subscribed = subscriptions;
    const composer = await page.locator("#message").elementHandle();
    await page.getByRole("tab", { name: "使用量", exact: true }).click();
    const beforeUsage = (await f.service.view(a.id)).usage;
    assert.equal(
      await page.locator(".usage-summary dd").last().textContent(),
      "N/A",
    );
    assert.equal(
      await page
        .locator(".usage-table tbody tr")
        .first()
        .locator("td")
        .last()
        .textContent(),
      "N/A",
    );
    assert.equal(
      await page.locator(".usage-table tfoot td").last().textContent(),
      "N/A",
    );
    assert.equal(
      await page.locator(".usage-summary dd").first().textContent(),
      beforeUsage.total.totalTokens.toLocaleString("ja-JP"),
    );
    f.faux.setResponses([
      call("bash", { command: "printf stats" }),
      call("read", { path: "missing-statistics-file.txt" }),
      answer("使用量の更新"),
    ]);
    await f.service.send(a.id, randomUUID(), "続き");
    await until(
      async () => (await f.service.conversation(a.id)).status === "idle",
    );
    const afterUsage = (await f.service.view(a.id)).usage;
    assert.ok(afterUsage.total.totalTokens > beforeUsage.total.totalTokens);
    await page.waitForFunction(
      (value) =>
        document.querySelector(".usage-summary dd")?.textContent === value,
      afterUsage.total.totalTokens.toLocaleString("ja-JP"),
    );
    const bash = page.getByRole("row", { name: /ツール: bash/ });
    const read = page.getByRole("row", { name: /ツール: read/ });
    await bash.waitFor();
    assert.deepEqual(
      (await bash.getByRole("cell").allTextContents()).slice(0, 2),
      ["1", "0"],
    );
    assert.deepEqual(
      (await read.getByRole("cell").allTextContents()).slice(0, 2),
      ["1", "1"],
    );

    const statistics = page.getByRole("button", { name: "全セッションの統計" });
    const usageRequest = page.waitForRequest(
      (request) => new URL(request.url()).pathname === "/api/statistics/usage",
    );
    await statistics.click();
    assert.equal(
      new URL((await usageRequest).url()).searchParams.get("timezone"),
      "Asia/Tokyo",
    );
    const dialog = page.getByRole("dialog", { name: "全セッションの統計" });
    const daily = dialog.getByRole("table", { name: "日別の使用量" });
    const today = await dialog.getByLabel("終了日").inputValue();
    const day = daily.getByRole("row", { name: new RegExp(today) });
    await day.waitFor();
    assert.deepEqual(await daily.getByRole("columnheader").allTextContents(), [
      "日付",
      "合計トークン",
    ]);
    assert.equal(
      await day.getByRole("cell").textContent(),
      await dialog.locator(".usage-summary dd").first().textContent(),
    );
    assert.deepEqual(
      await dialog.locator(".usage-summary dt").allTextContents(),
      ["合計トークン", "参考費用（USD）"],
    );
    assert.equal(
      await dialog.getByText("Asia/Tokyo", { exact: true }).count(),
      0,
    );
    const startDate = dialog.getByLabel("開始日");
    const endDate = dialog.getByLabel("終了日");
    const aggregate = dialog.getByRole("button", { name: "集計", exact: true });
    const breakdown = dialog.getByRole("table", {
      name: "回数・トークン・費用の内訳",
    });
    const details = dialog.locator("summary").filter({ hasText: "詳しい内訳" });
    assert.equal(await breakdown.isVisible(), false);
    assert.equal(
      await dialog.getByText(/費用不明|保存されたモデル応答/).count(),
      0,
    );
    await mkdir("test-results", { recursive: true });
    for (const [width, height, colorScheme, screenshot] of [
      [1360, 960, "dark", "usage-statistics-desktop"],
      [375, 812, "light", "usage-statistics-mobile"],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme });
      const startBox = (await startDate.boundingBox())!;
      const endBox = (await endDate.boundingBox())!;
      const buttonBox = (await aggregate.boundingBox())!;
      assert.ok(startBox.x + startBox.width <= endBox.x);
      assert.ok(endBox.x + endBox.width <= buttonBox.x);
      assert.ok(Math.abs(startBox.y - endBox.y) < 1);
      assert.ok(
        Math.abs(endBox.y + endBox.height - buttonBox.y - buttonBox.height) < 1,
      );
      assert.ok(startBox.height <= 34 && buttonBox.height <= 34);
      assert.equal(
        await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth),
        true,
      );
      assert.equal(
        await daily.evaluate(
          (node) => node.scrollWidth <= node.parentElement!.clientWidth,
        ),
        true,
      );
      await dialog.screenshot({ path: `test-results/${screenshot}.png` });
    }
    await details.focus();
    await page.keyboard.press("Enter");
    await breakdown
      .getByRole("rowheader", { name: "合計", exact: true })
      .waitFor();
    const dailyCalls = dialog.getByRole("table", {
      name: "日別の呼び出し件数",
    });
    assert.deepEqual(
      await dailyCalls
        .getByRole("row", { name: new RegExp(today) })
        .getByRole("cell")
        .allTextContents(),
      ["4", "2", "1"],
    );
    await dialog.screenshot({
      path: "test-results/usage-statistics-details.png",
    });
    const scroller = dialog.locator("[aria-label='使用量の内訳']");
    await scroller.focus();
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(
      () =>
        (document.querySelector(".usage-dialog [aria-label='使用量の内訳']")
          ?.scrollLeft ?? 0) > 0,
    );
    await details.focus();
    await page.keyboard.press("Enter");
    await breakdown.waitFor({ state: "hidden" });
    await page.setViewportSize({ width: 1360, height: 960 });
    await page.emulateMedia({ colorScheme: null });
    await startDate.fill("2020-01-01");
    await endDate.fill("2020-01-01");
    await aggregate.click();
    await dialog.getByText("この期間の使用記録はありません").waitFor();
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    assert.equal(
      await statistics.evaluate((node) => node === document.activeElement),
      true,
    );

    await page.getByRole("tab", { name: "会話", exact: true }).click();
    assert.equal(await composer!.evaluate((node) => node.isConnected), true);
    assert.equal(await page.locator("#message").inputValue(), "A の下書き");
    assert.equal(await page.locator(".attachment-chip").count(), 1);
    assert.equal(subscriptions, subscribed);
    await row(b.id).locator(".conversation-item").click();
    await page.getByRole("tab", { name: "使用量", exact: true }).click();
    assert.equal(
      await page.locator(".usage-summary dd").first().textContent(),
      "0",
    );
    assert.equal(
      await page.locator(".usage-summary dd").last().textContent(),
      "$0.000000",
    );
    await page.getByRole("tab", { name: "会話", exact: true }).click();
    await page.locator("#message").fill("B の下書き");
    await row(a.id).locator(".conversation-item").click();
    assert.equal(await page.locator("#message").inputValue(), "A の下書き");
    assert.equal(await page.locator(".attachment-chip").count(), 1);
    await page.reload();
    await row(a.id).locator(".conversation-item").click();
    await page.getByText("保存済みの応答", { exact: true }).waitFor();
    assert.equal(await page.locator("#message").inputValue(), "A の下書き");
    const sidebarFooter = page.locator(".sidebar-footer");
    const collapse = sidebarFooter.getByRole("button", {
      name: "セッション一覧を閉じる",
      exact: true,
    });
    const settingsButton = sidebarFooter.getByRole("button", {
      name: "設定",
      exact: true,
    });
    const settingsBox = (await settingsButton.boundingBox())!;
    const collapseBox = (await collapse.boundingBox())!;
    assert.ok(collapseBox.x > settingsBox.x);
    assert.ok(Math.abs(collapseBox.y - settingsBox.y) < 1);
    await collapse.focus();
    await page.keyboard.press("Enter");
    const rail = (await page.locator("#sidebar").boundingBox())!;
    assert.equal(rail.width, 64);
    assert.equal(await page.locator("#conversations").isVisible(), false);
    assert.equal(await page.locator("#new-conversation").isVisible(), true);
    assert.equal(await settingsButton.isVisible(), true);
    assert.equal(
      await page
        .locator(".sidebar-toggle")
        .evaluate((node) => node === document.activeElement),
      true,
    );
    await mkdir("test-results", { recursive: true });
    await page.screenshot({ path: "test-results/sidebar-rail.png" });
    await settingsButton.click();
    await page.getByRole("heading", { name: "設定", exact: true }).waitFor();
    await page
      .getByRole("button", { name: "セッション一覧を開く", exact: true })
      .click();
    assert.equal((await page.locator("#sidebar").boundingBox())!.width, 272);
    await returnToSession(page);
    assert.equal(await page.locator("#message").inputValue(), "A の下書き");

    const filter = page.getByRole("searchbox", { name: "セッションを検索" });
    await filter.fill("セッション B");
    assert.equal(await row(a.id).count(), 0);
    assert.equal(await page.locator("#message").inputValue(), "A の下書き");
    await more(b.id);
    await page.getByRole("button", { name: "名前を変更", exact: true }).click();
    const rename = page.getByRole("dialog", {
      name: "名前を変更",
      exact: true,
    });
    await rename.getByLabel("セッション名").fill("作業メモ");
    await rename.getByRole("button", { name: "保存", exact: true }).click();
    await rename.waitFor({ state: "hidden" });
    await filter.fill("");
    await row(b.id)
      .getByRole("button", { name: "作業メモ", exact: true })
      .waitFor();
    assert.equal(await page.locator("#title").textContent(), "セッション A");
    await more(b.id);
    await page.getByRole("button", { name: "ピン留め", exact: true }).click();
    await page
      .getByRole("heading", { name: "ピン留め", exact: true })
      .waitFor();
    await more(b.id);
    await page.getByRole("button", { name: "アーカイブ", exact: true }).click();
    await row(b.id).waitFor({ state: "detached" });
    await page
      .getByRole("button", { name: "アーカイブを表示", exact: true })
      .click();
    await more(b.id);
    await page
      .getByRole("button", { name: "アーカイブから戻す", exact: true })
      .click();
    await page
      .getByRole("button", { name: "通常のセッションを表示", exact: true })
      .click();
    await more(b.id);
    await page
      .getByRole("button", { name: "セッションを削除", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "セッションを削除", exact: true })
      .getByRole("button", { name: "削除", exact: true })
      .click();
    await row(b.id).waitFor({ state: "detached" });
    assert.equal(await page.locator("#message").inputValue(), "A の下書き");
    assert.equal(await page.locator("#title").textContent(), "セッション A");

    const pi = await f.service.piConversation(a.id);
    for (let index = 0; index < 45; index++)
      await pi.submit(
        {
          type: "write",
          entry: {
            kind: "test.history",
            model: [
              {
                role: "user",
                content: `検索のページ ${index}`,
                timestamp: Date.now(),
              },
            ],
          },
        },
        ctx,
      );
    await page.reload();
    await row(a.id).locator(".conversation-item").click();
    await page.locator(".message").first().waitFor();
    assert.equal(
      await page.getByText("最初の検索ワード", { exact: true }).count(),
      0,
    );
    await page.keyboard.press("Control+Shift+f");
    const search = page.getByRole("region", {
      name: "会話内を検索",
      exact: true,
    });
    await search.getByRole("searchbox").fill("最初の検索ワード");
    await search.locator(".search-result").click();
    await page
      .locator(".user-message")
      .getByText("最初の検索ワード", { exact: true })
      .waitFor();
    assert.equal(
      await page.getByRole("dialog", { name: "会話内を検索" }).count(),
      0,
    );
    await search.getByRole("searchbox").press("Escape");
    await search.waitFor({ state: "hidden" });
    assert.equal(await page.locator(".search-current").count(), 1);
    assert.equal(await page.locator("#message").inputValue(), "A の下書き");
    const original = page
      .locator(".user-message")
      .filter({ hasText: "最初の検索ワード" });
    const editButton = original.getByRole("button", {
      name: "メッセージを編集",
      exact: true,
    });
    const edit = page.locator(".user-message").getByRole("form", {
      name: "メッセージの編集",
    });
    const input = edit.getByRole("textbox");
    const sendEdit = edit.getByRole("button", { name: "送信", exact: true });
    await editButton.click();
    assert.equal(await input.inputValue(), "最初の検索ワード");
    assert.equal(
      await input.evaluate((node) => node === document.activeElement),
      true,
    );
    assert.equal(await page.getByRole("dialog").count(), 0);
    await input.fill(" ");
    assert.equal(await sendEdit.isDisabled(), true);
    await input.press("Escape");
    await edit.waitFor({ state: "hidden" });
    assert.equal(
      await editButton.evaluate((node) => node === document.activeElement),
      true,
    );
    assert.equal(
      (await f.service.list()).some((session) => session.parentId === a.id),
      false,
    );
    assert.equal(await page.locator("#message").inputValue(), "A の下書き");

    f.faux.setResponses([answer("編集後の応答")]);
    let editResponseLost = false;
    await page.route("**/api/conversations/*/messages", async (route) => {
      if (!editResponseLost) {
        editResponseLost = true;
        await route.fetch();
        await route.abort("failed");
      } else await route.continue();
    });
    await editButton.click();
    await input.fill("変更した入力");
    await sendEdit.click();
    await edit.getByRole("alert").waitFor();
    assert.equal(await input.inputValue(), "変更した入力");
    await input.press("Control+Enter");
    await page.getByText("編集後の応答", { exact: true }).waitFor();
    await page.unroute("**/api/conversations/*/messages");
    const editBranches = (await f.service.list()).filter(
      (session) => session.parentId === a.id,
    );
    assert.equal(editBranches.length, 1);
    assert.equal(editBranches[0]!.requests, 1);
    const edited = (await f.service.list()).find(
      (session) => session.parentId === a.id,
    )!;
    assert.ok(edited);
    assert.equal(
      (await f.service.search(a.id, "最初の検索ワード")).matches.length,
      1,
    );
    assert.doesNotMatch(
      JSON.stringify(await f.service.view(edited.id)),
      /最初の検索ワード/,
    );

    // Branch navigation preserves drafts and attachments and never starts work.
    await page.locator("#message").fill("分岐側の下書き");
    const requestCounts = (await f.service.list()).map((session) => [
      session.id,
      session.requests,
    ]);
    await page.getByRole("button", { name: "前の分岐", exact: true }).click();
    await page.waitForFunction(
      () =>
        (document.querySelector("#message") as HTMLTextAreaElement).value ===
        "A の下書き",
    );
    await page.keyboard.press("Control+Shift+f");
    await search.getByRole("searchbox").fill("最初の検索ワード");
    await search.locator(".search-result").click();
    await search.getByRole("searchbox").press("Escape");
    const nextBranch = page.getByRole("button", {
      name: "次の分岐",
      exact: true,
    });
    await nextBranch.click();
    await page.getByText("編集後の応答", { exact: true }).waitFor();
    assert.equal(await page.locator("#message").inputValue(), "分岐側の下書き");
    assert.deepEqual(
      (await f.service.list()).map((session) => [session.id, session.requests]),
      requestCounts,
    );
    assert.equal(
      await page
        .getByRole("button", { name: "次の分岐", exact: true })
        .isDisabled(),
      true,
    );

    f.faux.setResponses([answer("再生成した応答")]);
    let lost = false;
    await page.route("**/api/conversations/*/continue", async (route) => {
      if (!lost) {
        lost = true;
        await route.fetch();
        await route.abort("failed");
      } else await route.continue();
    });
    await page
      .getByRole("button", { name: "回答を再生成", exact: true })
      .click();
    const regenerate = page.getByRole("dialog", {
      name: "回答を再生成",
      exact: true,
    });
    await regenerate.getByRole("checkbox").check();
    await regenerate
      .getByRole("button", { name: "回答を再生成", exact: true })
      .click();
    await regenerate.getByRole("alert").waitFor();
    await until(async () =>
      (await f.service.list()).some(
        (session) =>
          session.parentId === edited.id && session.status === "idle",
      ),
    );
    await regenerate
      .getByRole("button", { name: "回答を再生成", exact: true })
      .click();
    await page.getByText("再生成した応答", { exact: true }).waitFor();
    const regenerated = (await f.service.list()).filter(
      (session) => session.parentId === edited.id,
    );
    assert.equal(regenerated.length, 1);
    assert.equal(regenerated[0]!.requests, 1);
    await page.getByRole("button", { name: "前の分岐", exact: true }).click();
    await page.getByText("編集後の応答", { exact: true }).waitFor();
    await page
      .locator(".assistant-message")
      .getByRole("button", { name: "次の分岐", exact: true })
      .click();
    await page.getByText("再生成した応答", { exact: true }).waitFor();
    await page.unrouteAll({ behavior: "wait" });
    await page
      .locator(".assistant-message")
      .getByRole("button", { name: "ここから分岐", exact: true })
      .click();
    const branch = page.getByRole("dialog", {
      name: "ここから分岐",
      exact: true,
    });
    await branch
      .getByRole("button", { name: "ここから分岐", exact: true })
      .click();
    await branch.waitFor({ state: "hidden" });
    const fork = (await f.service.list()).find(
      (session) => session.parentId === regenerated[0]!.id,
    )!;
    assert.equal(fork.requests, 0);
    assert.equal(fork.workspaceCreated, false);
    await page.getByRole("button", { name: "前の分岐", exact: true }).click();
    await page.waitForFunction(
      (id) =>
        document
          .querySelector(".session-row.selected")
          ?.getAttribute("data-session-id") === id,
      regenerated[0]!.id,
    );
    assert.equal(
      (await f.service.conversation(fork.id)).workspaceCreated,
      false,
    );
    // Returning to a new-session draft retains its files; an accepted send clears
    // that draft so the next new session cannot inherit old attachments.
    await page.locator("#new-conversation").click();
    await page.locator("#message").fill("新規セッションの添付");
    await page.locator("#attachments").setInputFiles({
      name: "new.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("new draft"),
    });
    await row(a.id).locator(".conversation-item").click();
    await page.locator("#new-conversation").click();
    assert.equal(
      await page.locator("#message").inputValue(),
      "新規セッションの添付",
    );
    assert.equal(await page.locator(".attachment-chip").count(), 1);
    f.faux.setResponses([answer("新規の添付を受信")]);
    await page.locator("#send").click();
    await page.getByText("新規の添付を受信", { exact: true }).waitFor();
    await page.locator("#new-conversation").click();
    assert.equal(await page.locator(".attachment-chip").count(), 0);
    assert.equal(await page.locator("#message").inputValue(), "");
    async function assertSidebarAlignment() {
      const positions = await page
        .locator(
          ".sidebar-header .new-conversation, .conversation-item, .sidebar-statistics, .sidebar-terminal, .sidebar-settings",
        )
        .evaluateAll((rows) =>
          rows.map((row) => ({
            icon: row.querySelector("svg")!.getBoundingClientRect().left,
            label: row.querySelector("span")!.getBoundingClientRect().left,
          })),
        );
      assert.ok(positions.length > 4);
      assert.ok(
        positions.every(
          ({ icon, label }) =>
            Math.abs(icon - positions[0]!.icon) < 1 &&
            Math.abs(label - positions[0]!.label) < 1,
        ),
        JSON.stringify(positions),
      );
    }
    await assertSidebarAlignment();
    await page.locator(".sidebar-toggle").click();
    assert.equal(
      await page.locator(".sidebar-statistics .sidebar-label-text").isVisible(),
      false,
    );
    const centered = await page
      .locator(".sidebar-statistics")
      .evaluate((row) => {
        const bounds = row.getBoundingClientRect();
        const icon = row.querySelector("svg")!.getBoundingClientRect();
        return (
          Math.abs(
            bounds.left + bounds.width / 2 - icon.left - icon.width / 2,
          ) < 1
        );
      });
    assert.ok(centered);
    await page.locator(".sidebar-toggle").click();
    await mkdir("test-results", { recursive: true });
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await page.screenshot({
        path: `test-results/refined-ui-${colorScheme}.png`,
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await page
        .getByRole("button", { name: "セッション一覧を開く", exact: true })
        .click();
      await more(a.id);
      await assertSidebarAlignment();
      const menuItems = await page
        .locator(".session-popover > :is(button, a)")
        .evaluateAll((rows) =>
          rows.map((row) => {
            const text = [...row.childNodes].find(
              (node) =>
                node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
            )!;
            const range = document.createRange();
            range.selectNodeContents(text);
            return {
              icon: row.querySelector("svg")!.getBoundingClientRect().left,
              label: range.getBoundingClientRect().left,
            };
          }),
        );
      assert.equal(menuItems.length, 5);
      assert.ok(
        menuItems.every(
          ({ icon, label }) =>
            icon === menuItems[0]!.icon && label === menuItems[0]!.label,
        ),
        JSON.stringify(menuItems),
      );
      const menu = await page.locator(".session-popover").boundingBox();
      assert.ok(
        menu &&
          menu.x >= 0 &&
          menu.y >= 0 &&
          menu.x + menu.width <= 390 &&
          menu.y + menu.height <= 844,
      );
      await page.screenshot({
        path: `test-results/refined-sidebar-mobile-${colorScheme}.png`,
        fullPage: true,
      });
      await page.keyboard.press("Escape");
      await statistics.click();
      await dialog.getByRole("table", { name: "日別の使用量" }).waitFor();
      const bounds = await dialog.boundingBox();
      assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390);
      await dialog.getByRole("button", { name: "統計を閉じる" }).click();
      await page.locator(".sidebar-close").click();
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      await page.setViewportSize({ width: 1360, height: 960 });
    }
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
    await browser.close();
    await server.close();
    await f.service.close();
  }
});
