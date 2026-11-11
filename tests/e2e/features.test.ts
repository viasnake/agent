import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { createServer as portProbe } from "node:net";
import { chromium } from "playwright";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createServer } from "../../src/server.js";
import { fixture, answer, until } from "../support.js";

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
    permissions: ["clipboard-read", "clipboard-write"],
    viewport: { width: 1360, height: 960 },
  });
  const page = await context.newPage();
  const errors: string[] = [];
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
    await row(b.id).locator(".conversation-item").click();
    await page.locator("#message").fill("B の下書き");
    await row(a.id).locator(".conversation-item").click();
    assert.equal(await page.locator("#message").inputValue(), "A の下書き");
    assert.equal(await page.locator(".attachment-chip").count(), 1);
    await page.reload();
    await row(a.id).locator(".conversation-item").click();
    await page.getByText("保存済みの応答", { exact: true }).waitFor();
    assert.equal(await page.locator("#message").inputValue(), "A の下書き");
    await page
      .getByRole("button", { name: "セッション一覧を閉じる", exact: true })
      .click();
    assert.equal(await page.locator("#sidebar").isVisible(), false);
    await page
      .getByRole("button", { name: "セッション一覧を開く", exact: true })
      .click();

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
    await page.locator("#earlier").waitFor();
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
    f.faux.setResponses([answer("編集後の応答")]);
    await page
      .locator(".user-message")
      .filter({ hasText: "最初の検索ワード" })
      .getByRole("button", { name: "メッセージを編集", exact: true })
      .click();
    const edit = page.getByRole("dialog", {
      name: "編集して送信",
      exact: true,
    });
    await edit.getByRole("textbox").fill("変更した入力");
    assert.equal(
      await edit
        .getByRole("button", { name: "編集して送信", exact: true })
        .isDisabled(),
      true,
    );
    await edit.getByRole("checkbox").check();
    await edit
      .getByRole("button", { name: "編集して送信", exact: true })
      .click();
    await page.getByText("編集後の応答", { exact: true }).waitFor();
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
