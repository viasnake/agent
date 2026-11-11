import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createServer as portProbe } from "node:net";
import { chromium, type Page } from "playwright";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createServer } from "../../src/server.js";
import { fixture } from "../support.js";

async function settle(page: Page) {
  // Include native smooth scrolling and ResizeObserver delivery, not only React commits.
  await page.waitForTimeout(600);
}
async function assertShell(page: Page) {
  const positions = await page.evaluate(() =>
    [
      document.documentElement,
      document.body,
      ...document.querySelectorAll(
        "#root, #app, .workspace, #chat-panel, .chat-thread, #sidebar",
      ),
    ].map((node) => ({
      name: node.id || node.className || node.tagName,
      top: node.scrollTop,
      left: node.scrollLeft,
    })),
  );
  for (const position of positions) {
    assert.equal(
      position.top,
      0,
      `${position.name} must not scroll vertically`,
    );
    assert.equal(
      position.left,
      0,
      `${position.name} must not scroll horizontally`,
    );
  }
  assert.equal(
    await page
      .locator(".conversation-header")
      .evaluate((node) => node.getBoundingClientRect().top),
    0,
  );
}
async function position(page: Page) {
  return page.locator("#transcript").evaluate((viewport) => {
    const bounds = viewport.getBoundingClientRect();
    const messages = [
      ...viewport.querySelectorAll<HTMLElement>("[data-entry-id]"),
    ];
    const message =
      messages.find(
        (node) =>
          node.getBoundingClientRect().top >= bounds.top &&
          node.getBoundingClientRect().top < bounds.bottom,
      ) ??
      messages.find((node) => node.getBoundingClientRect().bottom > bounds.top);
    return {
      id: message?.dataset.entryId,
      offset: (message?.getBoundingClientRect().top ?? 0) - bounds.top,
      scroll: viewport.scrollTop,
      bottom:
        viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
    };
  });
}

test("search, tabs, resizing and history loading retain the reading position without moving the shell", async () => {
  const f = await fixture();
  const session = await f.service.create(randomUUID(), "表示位置の確認");
  const pi = await f.service.piConversation(session.id);
  for (let index = 0; index < 80; index++) {
    await pi.submit(
      {
        type: "write",
        entry: {
          kind: "test.history",
          model: [
            {
              role: "user",
              content: `位置確認 ${String(index).padStart(3, "0")}\n${"折り返しを含む長い会話の表示位置を確認します。".repeat(12)}`,
              timestamp: Date.now(),
            },
          ],
        },
      },
      ctx,
    );
  }
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
  try {
    for (const width of [1000, 390]) {
      const page = await browser.newPage({
        viewport: { width, height: 900 },
        reducedMotion: width === 390 ? "reduce" : "no-preference",
        colorScheme: width === 390 ? "light" : "dark",
      });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(origin);
      if (width < 768)
        await page
          .getByRole("button", { name: "セッション一覧を開く", exact: true })
          .click();
      await page
        .getByRole("button", { name: "表示位置の確認", exact: true })
        .click();
      await page.locator(".message").first().waitFor();
      await settle(page);
      assert.ok(
        (await position(page)).bottom < 2,
        "Initial history opens at the bottom",
      );
      await page.locator("#message").fill("未送信の下書き");
      await page
        .getByRole("button", { name: "会話内を検索", exact: true })
        .click();
      const search = page.getByRole("region", {
        name: "会話内を検索",
        exact: true,
      });
      await search.getByRole("searchbox").fill("位置確認 065");
      await search.locator(".search-result").click();
      await settle(page);
      await assertShell(page);
      const selected = page.locator(".search-current");
      assert.equal(await selected.count(), 1);
      const before = await selected.evaluate(
        (node) => node.getBoundingClientRect().top,
      );
      await search
        .getByRole("button", { name: "検索を閉じる", exact: true })
        .click();
      await settle(page);
      await assertShell(page);
      assert.ok(
        Math.abs(
          (await selected.evaluate(
            (node) => node.getBoundingClientRect().top,
          )) - before,
        ) < 2,
        "Closing search retains the result at its screen position",
      );
      assert.equal(
        await page.locator("#message").inputValue(),
        "未送信の下書き",
      );
      assert.equal(
        await page.evaluate(() => document.activeElement?.id),
        "message",
      );
      const reading = await position(page);
      await page.getByRole("tab", { name: "ファイル", exact: true }).click();
      await settle(page);
      await page.getByRole("tab", { name: "会話", exact: true }).click();
      await settle(page);
      await assertShell(page);
      assert.equal(
        (await position(page)).id,
        reading.id,
        "Tabs retain the reading position",
      );
      assert.ok(Math.abs((await position(page)).offset - reading.offset) < 2);
      const toggle =
        width < 768 ? "セッション一覧を開く" : "セッション一覧を閉じる";
      await page.getByRole("button", { name: toggle, exact: true }).click();
      await settle(page);
      if (width < 768) await page.locator("#sidebar .sidebar-close").click();
      else
        await page
          .getByRole("button", { name: "セッション一覧を開く", exact: true })
          .click();
      await settle(page);
      await assertShell(page);
      assert.equal(
        (await position(page)).id,
        reading.id,
        "Sidebar round trip retains the reading position",
      );
      assert.ok(Math.abs((await position(page)).offset - reading.offset) < 2);
      await page.setViewportSize({ width, height: 680 });
      await settle(page);
      await page.setViewportSize({ width, height: 900 });
      await settle(page);
      assert.equal(
        (await position(page)).id,
        reading.id,
        "Window resizing retains the reading position",
      );
      await page.locator("#message").fill("複数行の下書き\n".repeat(6));
      await settle(page);
      await page.locator("#message").fill("未送信の下書き");
      await settle(page);
      assert.equal(
        (await position(page)).id,
        reading.id,
        "Composer resizing retains the reading position",
      );
      if (width < 768)
        await page
          .getByRole("button", { name: "セッション一覧を開く", exact: true })
          .click();
      await page.getByRole("button", { name: "設定", exact: true }).click();
      await page.getByRole("button", { name: "記憶", exact: true }).click();
      await page
        .getByRole("button", { name: "セッションに戻る", exact: true })
        .click();
      await settle(page);
      await assertShell(page);
      assert.equal(
        (await position(page)).id,
        reading.id,
        "Settings retain the reading position",
      );
      assert.ok(Math.abs((await position(page)).offset - reading.offset) < 2);
      assert.equal(
        await page.locator("#message").inputValue(),
        "未送信の下書き",
      );
      await page
        .getByRole("button", { name: "最新のメッセージへ", exact: true })
        .click();
      await settle(page);
      assert.ok(
        (await position(page)).bottom < 2,
        "Explicit latest-message navigation still works",
      );
      await page
        .getByRole("button", { name: "会話内を検索", exact: true })
        .click();
      await search.getByRole("searchbox").press("Escape");
      await settle(page);
      assert.ok(
        (await position(page)).bottom < 2,
        "Search at the latest message stays at the bottom",
      );
      await page
        .getByRole("button", { name: "会話内を検索", exact: true })
        .click();
      await search.getByRole("searchbox").fill("位置確認 005");
      await settle(page);
      for (
        let attempt = 0;
        attempt < 3 && !(await search.locator(".search-result").count());
        attempt++
      ) {
        await search
          .getByRole("button", { name: "さらに検索", exact: true })
          .click();
        await settle(page);
      }
      await search.locator(".search-result").click();
      await settle(page);
      await assertShell(page);
      assert.match((await selected.textContent()) ?? "", /位置確認 005/);
      await search.getByRole("searchbox").press("Escape");
      await settle(page);
      await assertShell(page);
      assert.equal(await search.count(), 0);
      await page.reload();
      if (width < 768)
        await page
          .getByRole("button", { name: "セッション一覧を開く", exact: true })
          .click();
      await page
        .getByRole("button", { name: "表示位置の確認", exact: true })
        .click();
      await page.locator("#earlier").scrollIntoViewIfNeeded();
      await settle(page);
      const oldest = page.locator(".message").first();
      const oldestId = await oldest.getAttribute("data-entry-id");
      const oldestTop = await oldest.evaluate(
        (node) => node.getBoundingClientRect().top,
      );
      const count = await page.locator(".message").count();
      await page.locator("#earlier").click();
      await page.waitForFunction(
        (count) => document.querySelectorAll(".message").length > count,
        count,
      );
      await settle(page);
      const retained = page.locator(`[data-entry-id="${oldestId}"]`);
      assert.ok(
        Math.abs(
          (await retained.evaluate(
            (node) => node.getBoundingClientRect().top,
          )) - oldestTop,
        ) < 2,
        `Prepending history retains the existing message position: ${JSON.stringify({ width, oldestTop, newTop: await retained.evaluate((node) => node.getBoundingClientRect().top), position: await position(page) })}`,
      );
      await assertShell(page);
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally {
    await browser.close();
    await server.close();
    await f.service.close();
  }
});
