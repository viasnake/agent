import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer as portProbe } from "node:net";
import { chromium, type Locator } from "playwright";
import { fixture, answer, call, until } from "../support.js";
import { createServer } from "../../src/server.js";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
// Rasterize computed CSS colors to sRGB, including Bootstrap's light-dark/OKLCH
// values and transparent surfaces. Check actual contrast, not token names.
async function assertReadable(locator: Locator, pseudo?: string) {
  const results = await locator.evaluateAll((nodes, pseudo) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    function paint(color: string) {
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
    }
    function luminance() {
      const channels = Array.from(context.getImageData(0, 0, 1, 1).data)
        .slice(0, 3)
        .map((value) => {
          const channel = value / 255;
          return channel <= 0.04045
            ? channel / 12.92
            : ((channel + 0.055) / 1.055) ** 2.4;
        });
      return (
        channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722
      );
    }
    return nodes.map((node) => {
      const ancestors: Element[] = [];
      for (
        let parent: Element | null = node;
        parent;
        parent = parent.parentElement
      ) {
        ancestors.unshift(parent);
      }
      paint("white");
      for (const ancestor of ancestors)
        paint(getComputedStyle(ancestor).backgroundColor);
      const background = luminance();
      paint(getComputedStyle(node, pseudo).color);
      const foreground = luminance();
      return {
        element: node.id || node.className || node.tagName,
        contrast:
          (Math.max(background, foreground) + 0.05) /
          (Math.min(background, foreground) + 0.05),
      };
    });
  }, pseudo);
  assert.ok(results.length > 0, "Contrast check must inspect actual elements");
  for (const result of results) {
    assert.ok(
      result.contrast >= 4.5,
      `${result.element}: contrast ${result.contrast.toFixed(2)} must be at least 4.5:1`,
    );
  }
}

test("real browser conversation: no category, attachments, response-loss retry, reconnect, CSV download and continuation without a new job", async () => {
  const f = await fixture([
    call("bash", {
      command:
        "test -f attachments/*-input.csv && mkdir -p outputs && printf 'name,total\\nAlice,12\\n' > outputs/clean.csv",
    }),
    answer(
      "## CSV の整形\n\n**保存しました。**\n\n| 名前 | 合計 |\n| --- | --- |\n| Alice | 12 |\n\n```sh\ncat outputs/clean.csv\n```\n\n![外部画像](https://evil.invalid/track)\n\n[不正なリンク](javascript:alert(1))\n\n<script>window.pwned=1</script><img src=https://evil.invalid/track>",
    ),
  ]);
  const probe = portProbe();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  f.config.server.origins = [origin];
  const server = await createServer(f.service, resolve("dist/web") + "/");
  await server.listen({ host: "127.0.0.1", port });
  const browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox"],
    }),
    context = await browser.newContext({
      acceptDownloads: true,
      colorScheme: "light",
      reducedMotion: "reduce",
      viewport: { width: 1440, height: 1000 },
    });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let external = 0;
  page.on("request", (request) => {
    if (!request.url().startsWith(origin + "/")) external++;
  });
  try {
    await page.goto(origin);
    const bootstrap = await page.request.get(`${origin}/bootstrap.css`);
    assert.equal(bootstrap.status(), 200);
    assert.ok(
      (await bootstrap.body()).equals(
        await readFile("node_modules/bootstrap/dist/css/bootstrap.min.css"),
      ),
      "Serve the pinned Bootstrap CSS without CDN requests",
    );
    await page.locator("#app").waitFor({ state: "visible" });
    assert.equal(
      await page.locator('input[type="password"], #login, #logout').count(),
      0,
    );
    await mkdir("test-results", { recursive: true });
    assert.equal(await page.locator("select").count(), 0);
    await page.locator("#message").fill("CSV を整形して CSV を返してください");
    await page.locator("#attachments").setInputFiles({
      name: "input.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("name,total\n Alice,12\n"),
    });
    let lost = false;
    await page.route("**/api/conversations/*/messages", async (route) => {
      if (!lost) {
        lost = true;
        await route.fetch();
        await route.abort("failed");
      } else await route.continue();
    });
    await page.getByRole("button", { name: "送る", exact: true }).click();
    await until(async () => lost);
    await page.locator("#send").waitFor({ state: "visible" });
    await page.waitForFunction(
      () => !(document.getElementById("send") as HTMLButtonElement).disabled,
    );
    assert.equal(
      await page.locator("#message").inputValue(),
      "CSV を整形して CSV を返してください",
      "A lost response restores the composer draft",
    );
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await assertReadable(page.locator("#error"));
    }
    await page.getByRole("button", { name: "通知を閉じる" }).click();
    await page.locator("#error").waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "送る", exact: true }).click();
    await page.getByRole("tab", { name: "ファイル", exact: true }).click();
    await page.getByRole("link", { name: /clean.csv/ }).waitFor();
    const uploadedLink = page.getByRole("link", { name: /input.csv.*添付/ });
    await uploadedLink.waitFor();
    const uploadedDownload = page.waitForEvent("download");
    await uploadedLink.click();
    const uploaded = await uploadedDownload;
    assert.equal(uploaded.suggestedFilename(), "input.csv");
    assert.equal(
      await readFile((await uploaded.path())!, "utf8"),
      "name,total\n Alice,12\n",
    );
    const conversations = await f.service.list();
    assert.equal(conversations.length, 1);
    const id = conversations[0]!.id;
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("link", { name: /clean.csv/ }).click();
    const download = await downloadPromise;
    const path = await download.path();
    assert.ok(path);
    assert.equal(
      (await f.service.download(id, "outputs/clean.csv")).toString(),
      "name,total\nAlice,12\n",
    );
    await page.getByRole("tab", { name: "会話", exact: true }).click();
    await page
      .getByRole("heading", { name: "CSV の整形", exact: true })
      .waitFor();
    assert.equal(await page.locator(".markdown table").count(), 1);
    assert.equal(
      await page.locator(".markdown pre code").textContent(),
      "cat outputs/clean.csv\n",
    );
    assert.equal(
      await page.locator('.markdown a[href^="javascript:"]').count(),
      0,
    );
    assert.equal(await page.locator(".markdown img").count(), 0);
    const tool = page.locator(".tool-card").first();
    assert.equal(
      await tool.evaluate((node) => (node as HTMLDetailsElement).open),
      false,
    );
    await tool.locator("summary").click();
    assert.ok(await tool.locator("pre").first().isVisible());
    await tool.locator("summary").click();
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await page.getByRole("tab", { name: "ファイル", exact: true }).click();
      await assertReadable(
        page.locator(
          ".session-tabs .nav-link, .output-file, .output-file small, .output-label",
        ),
      );
      await page.screenshot({
        path: `test-results/session-files-${colorScheme}.png`,
      });
      await page.getByRole("tab", { name: "使用量", exact: true }).click();
      await page.locator("#usage-panel .usage-table tbody tr").waitFor();
      await assertReadable(
        page.locator(
          "#usage-panel dt, #usage-panel dd, #usage-panel th, #usage-panel td, #usage-panel p",
        ),
      );
      await page.screenshot({
        path: `test-results/session-usage-${colorScheme}.png`,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
      );
      assert.equal(
        await page
          .locator("#usage-panel .table-responsive")
          .evaluate((node) => node.scrollWidth > node.clientWidth),
        true,
      );
      await page.screenshot({
        path: `test-results/session-usage-mobile-${colorScheme}.png`,
      });
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.getByRole("tab", { name: "会話", exact: true }).click();
      await assertReadable(
        page.locator(
          ".session-row.selected, #state, #connection, .user-bubble, .markdown, .markdown pre, .markdown th, .markdown td, .tool-card summary, .tool-state, .output-file, .output-file small, .output-label, .composer-shortcut, .workspace button:enabled",
        ),
      );
      await assertReadable(page.locator("#message"), "::placeholder");
      const create = page.getByRole("button", {
        name: "新しいセッション",
        exact: true,
      });
      await assertReadable(create);
      await create.hover();
      await assertReadable(create);
      await page.mouse.down();
      try {
        await assertReadable(create);
      } finally {
        await page.mouse.up();
      }
      // A click creates an empty view; return to the preserved conversation.
      await page.locator("#conversations button").first().click();
      await page.getByRole("tab", { name: "ファイル", exact: true }).click();
      await page.getByRole("link", { name: /clean.csv/ }).waitFor();
      await page.getByRole("tab", { name: "会話", exact: true }).click();
      await page.locator("#message").fill("配色の確認");
      await assertReadable(page.locator("#send"));
      await page.locator("#send").hover();
      await assertReadable(page.locator("#send"));
      await page.locator("#message").fill("");
      assert.equal(await page.locator("#send").isDisabled(), true);
      await page.mouse.move(0, 0);
      await page.screenshot({
        path: `test-results/conversation-${colorScheme}.png`,
      });
    }
    await page.emulateMedia({ colorScheme: "light" });
    await page.reload();
    await page.locator("#app").waitFor({ state: "visible" });
    await page.locator("#conversations button").first().click();
    await page.getByRole("tab", { name: "ファイル", exact: true }).click();
    await page.getByRole("link", { name: /clean.csv/ }).waitFor();
    await page.getByRole("tab", { name: "会話", exact: true }).click();
    f.faux.setResponses([
      call("write", {
        path: "outputs/note.md",
        content: "# 続き\n確認しました。",
      }),
      answer("Markdown だけを保存しました。\n\n[文章を取得](outputs/note.md)"),
    ]);
    await page.locator("#message").fill("続けて Markdown を作って");
    await page.locator("#message").press("Control+Enter");
    await page.getByRole("tab", { name: "ファイル", exact: true }).click();
    await page.getByRole("link", { name: /note.md/ }).waitFor();
    await page.getByRole("tab", { name: "会話", exact: true }).click();
    assert.equal((await f.service.list()).length, 1);
    await page.getByRole("link", { name: "文章を取得", exact: true }).waitFor();
    assert.match(
      (await page
        .getByRole("link", { name: "文章を取得", exact: true })
        .getAttribute("href")) ?? "",
      new RegExp(`/api/conversations/${id}/download`),
    );
    assert.equal(external, 0);
    assert.equal(
      await page.evaluate(() => Object.hasOwn(window, "pwned")),
      false,
    );
    f.faux.setResponses([
      call("bash", { command: "printf started > started; sleep 30" }),
      answer("stale"),
    ]);
    await page.locator("#message").fill("停止と再開を確認して");
    await page.getByRole("button", { name: "送る", exact: true }).click();
    await until(async () =>
      readFile(join(f.root, "work/conversations", id, "started")).then(
        () => true,
        () => false,
      ),
    );
    await page.locator("#state").filter({ hasText: "実行中" }).waitFor();
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await assertReadable(page.locator("#state"));
    }
    await page.locator("#message").fill("追加指示を保持してください");
    await page.getByRole("button", { name: "送る", exact: true }).click();
    await until(async () => (await f.service.view(id)).pendingInputs === 1);
    await page.getByRole("button", { name: "停止", exact: true }).click();
    await page.getByRole("button", { name: "再開", exact: true }).waitFor();
    assert.match(
      JSON.stringify(await f.service.view(id)),
      /追加指示を保持してください/,
    );
    f.faux.setResponses([
      call("bash", { command: "test -f started && printf resumed" }),
      answer("再開しました。"),
    ]);
    await page.getByRole("button", { name: "再開", exact: true }).click();
    await page.getByText("再開しました。", { exact: true }).waitFor();
    assert.equal((await f.service.list()).length, 1);
    await mkdir("test-results", { recursive: true });
    await page.screenshot({
      path: "test-results/conversation.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await assertReadable(page.locator("#state, #message"));
      await page.screenshot({
        path: `test-results/conversation-mobile-${colorScheme}.png`,
        fullPage: true,
      });
    }
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      "Mobile layout must not overflow horizontally",
    );
    assert.ok(await page.locator("#send").isVisible());
    const composer = await page.locator("#message-form").boundingBox();
    assert.ok(
      composer && composer.y + composer.height <= 844,
      "The composer stays inside the mobile viewport",
    );
    await page
      .getByRole("button", { name: "セッション一覧を開く", exact: true })
      .click();
    await page
      .getByRole("navigation", { name: "セッション一覧" })
      .waitFor({ state: "visible" });
    await page.locator("#conversations button").first().click();
    assert.equal(await page.locator("#sidebar").isVisible(), false);
    await page.getByRole("tab", { name: "ファイル", exact: true }).click();
    await context.clearCookies();
    await page.getByRole("button", { name: "更新", exact: true }).click();
    await page.getByRole("button", { name: "再接続", exact: true }).click();
    await page.getByRole("link", { name: /note.md/ }).waitFor();
    assert.equal((await f.service.list()).length, 1);
    assert.equal((await f.service.conversation(id)).status, "idle");
    assert.deepEqual(errors, []);
    const pi = await f.service.piConversation(id);
    for (let index = 0; index < 45; index++) {
      await pi.submit(
        {
          type: "write",
          entry: {
            kind: "test.history",
            model: [
              {
                role: "user",
                content: `保存済みの履歴 ${index}`,
                timestamp: Date.now(),
              },
            ],
          },
        },
        ctx,
      );
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator("#new-conversation").click();
    await page.locator("#conversations button").first().click();
    await page.locator("#earlier").waitFor();
    assert.equal(
      await page.getByText("保存済みの履歴 0", { exact: true }).count(),
      0,
    );
    await page.locator("#earlier").click();
    await page.getByText("保存済みの履歴 0", { exact: true }).waitFor();
    f.faux.setResponses([answer("履歴の読み込み後も続けられます。")]);
    await page.locator("#message").fill("過去の履歴を読んで続けて");
    await page.locator("#send").click();
    await page
      .getByText("履歴の読み込み後も続けられます。", { exact: true })
      .waitFor();
    assert.equal(
      await page.getByText("保存済みの履歴 0", { exact: true }).count(),
      1,
      "Live snapshots preserve loaded history without duplicating it",
    );
    assert.deepEqual(errors, []);
    const home = await mkdtemp(join(tmpdir(), "agent-ui-download-"));
    await download.saveAs(join(home, "clean.csv"));
  } finally {
    await context.close();
    await browser.close();
    await server.close();
    await f.service.close();
  }
});

test("conversation navigation preserves selection, ignores stale loads and contains failures in the thread", async () => {
  const f = await fixture([answer("最初の応答")]);
  const { randomUUID } = await import("node:crypto");
  const creationReceipt = randomUUID();
  const a = await f.service.create(creationReceipt, "会話 A");
  await f.service.create(randomUUID(), "会話 B");
  await f.service.send(a.id, randomUUID(), "最初の入力");
  await until(
    async () => (await f.service.conversation(a.id)).status === "idle",
  );
  const probe = portProbe();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  f.config.server.origins = [origin];
  const server = await createServer(f.service, resolve("dist/web") + "/");
  await server.listen({ host: "127.0.0.1", port });
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({ reducedMotion: "reduce" });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(origin);
    const selectA = page.getByRole("button", { name: "会話 A", exact: true });
    const selectB = page.getByRole("button", { name: "会話 B", exact: true });
    await selectA.click();
    await page.getByText("最初の応答", { exact: true }).waitFor();
    let subscriptions = 0;
    page.on("request", (request) => {
      if (request.url().endsWith("/events")) subscriptions++;
    });
    await page.locator("#message").fill("未送信の入力");
    await page.locator("#attachments").setInputFiles({
      name: "draft.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("draft"),
    });
    const chatTab = page.getByRole("tab", { name: "会話", exact: true });
    const filesTab = page.getByRole("tab", { name: "ファイル", exact: true });
    assert.equal(await filesTab.getAttribute("aria-controls"), "files-panel");
    assert.equal(await chatTab.getAttribute("aria-controls"), "chat-panel");
    await chatTab.focus();
    await chatTab.press("ArrowRight");
    await filesTab.and(page.locator('[aria-selected="true"]')).waitFor();
    assert.equal(await filesTab.getAttribute("aria-selected"), "true");
    await page.getByText("ファイルはありません", { exact: true }).waitFor();
    assert.equal(await page.locator("#message").isVisible(), false);
    await filesTab.press("Home");
    await chatTab.and(page.locator('[aria-selected="true"]')).waitFor();
    assert.equal(await chatTab.getAttribute("aria-selected"), "true");
    assert.equal(await page.locator("#message").inputValue(), "未送信の入力");
    assert.equal(await page.locator(".attachment-chip").count(), 1);
    assert.equal(subscriptions, 0, "Tabs retain the existing SSE subscription");
    await page.getByRole("button", { name: "draft.txt を取り除く" }).click();
    await selectA.click({ clickCount: 3 });
    assert.equal(await page.locator("#message").inputValue(), "未送信の入力");
    assert.equal(await page.locator(".history-loading").count(), 0);
    assert.equal(
      await page.getByText("最初の応答", { exact: true }).count(),
      1,
    );

    f.faux.setResponses([
      call("bash", { command: "sleep 30" }),
      answer("unused"),
    ]);
    await page.locator("#send").click();
    await page.locator("#state").filter({ hasText: "実行中" }).waitFor();
    await page
      .getByRole("button", { name: "「会話 A」の操作", exact: true })
      .click();
    assert.equal(
      await page
        .getByRole("button", { name: "セッションを削除", exact: true })
        .isDisabled(),
      true,
    );
    await page.keyboard.press("Escape");
    await filesTab.click();
    await page.getByRole("button", { name: "停止", exact: true }).waitFor();
    await chatTab.click();
    await selectB.click();
    await page.locator("#title").filter({ hasText: "会話 B" }).waitFor();
    assert.equal(
      await page.getByText("最初の応答", { exact: true }).count(),
      0,
    );
    await selectA.click();
    await page.getByRole("button", { name: "停止", exact: true }).waitFor();
    await selectA.click({ clickCount: 3 });
    await page.getByRole("button", { name: "停止", exact: true }).click();
    await page.locator("#transcript #detail").waitFor();
    assert.equal(await page.locator(".workspace > #detail").count(), 0);
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await assertReadable(page.locator("#detail"));
    }

    // A delayed HTTP load must not overwrite a newer SSE snapshot, even after A-B-A.
    await selectB.click();
    let captured = false;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(`**/api/conversations/${a.id}`, async (route) => {
      const response = await route.fetch();
      captured = true;
      await held;
      await route.fulfill({ response });
    });
    await selectA.click();
    await until(async () => captured);
    await page.getByRole("button", { name: "再開", exact: true }).waitFor();
    f.faux.setResponses([answer("新しい応答")]);
    await f.service.send(a.id, randomUUID(), "新しい入力");
    await page.getByText("新しい応答", { exact: true }).waitFor();
    release();
    await page.unrouteAll({ behavior: "wait" });
    assert.equal(await page.locator("#state").textContent(), "応答終了");
    assert.equal(await page.locator("#detail").count(), 0);

    // Failed initial loading offers an in-thread retry instead of an endless spinner.
    await selectB.click();
    await page.route(`**/api/conversations/${a.id}/events`, (route) =>
      route.abort(),
    );
    await page.route(`**/api/conversations/${a.id}`, (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "unavailable" }),
      }),
    );
    await selectA.click();
    await page
      .getByRole("button", { name: "再読み込み", exact: true })
      .waitFor();
    assert.equal(await page.locator(".history-loading").count(), 0);
    await page.unrouteAll({ behavior: "wait" });
    await page.getByRole("button", { name: "再読み込み", exact: true }).click();
    await page.getByText("新しい応答", { exact: true }).waitFor();
    // A failed file read stays in its tab and can be retried locally.
    await page.route(`**/api/conversations/${a.id}/files`, (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: '{"error":"unavailable"}',
      }),
    );
    await filesTab.click();
    await page.getByRole("button", { name: "更新", exact: true }).click();
    await page
      .getByRole("alert")
      .filter({ hasText: "ファイルを読み込めませんでした" })
      .waitFor();
    await page.unrouteAll({ behavior: "wait" });
    await page.getByRole("button", { name: "更新", exact: true }).click();
    await page.getByText("ファイルはありません", { exact: true }).waitFor();
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await assertReadable(
        page.locator(".session-tabs .nav-link, .files-empty, #refresh-files"),
      );
      await filesTab.hover();
      await assertReadable(filesTab);
    }
    await chatTab.click();
    await page.locator("#message").fill("削除をキャンセルしたら保持");
    await page
      .getByRole("button", { name: "「会話 A」の操作", exact: true })
      .click();
    await page
      .getByRole("button", { name: "セッションを削除", exact: true })
      .click();
    const deletion = page.getByRole("dialog", {
      name: "セッションを削除",
      exact: true,
    });
    await deletion
      .getByRole("button", { name: "キャンセル", exact: true })
      .click();
    assert.equal(
      await page.locator("#message").inputValue(),
      "削除をキャンセルしたら保持",
    );
    assert.equal((await f.service.list()).length, 2);
    // Reproduce the saved create receipt left by a failed first send.
    await page.evaluate(async (id) => {
      const digest = Array.from(
        new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(JSON.stringify({ title: "会話 A" })),
          ),
        ),
      )
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      sessionStorage.setItem(
        "agent-request-create",
        JSON.stringify({ id, digest }),
      );
    }, creationReceipt);
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await page
        .getByRole("button", { name: "「会話 A」の操作", exact: true })
        .click();
      await assertReadable(page.locator(".session-popover button"));
      await page.keyboard.press("Escape");
    }
    // Losing a successful deletion response must allow an explicit, idempotent retry.
    await page.route(`**/api/conversations/${a.id}`, async (route) => {
      if (route.request().method() !== "DELETE") return route.continue();
      await route.fetch();
      await route.abort("failed");
    });
    await page
      .getByRole("button", { name: "「会話 A」の操作", exact: true })
      .click();
    await page
      .getByRole("button", { name: "セッションを削除", exact: true })
      .click();
    await deletion.getByRole("button", { name: "削除", exact: true }).click();
    await deletion.getByRole("alert").waitFor();
    assert.equal((await f.service.list()).length, 1);
    assert.equal(
      await page.locator("#message").inputValue(),
      "削除をキャンセルしたら保持",
    );
    await page.unrouteAll({ behavior: "wait" });
    await deletion.getByRole("button", { name: "削除", exact: true }).click();
    await page
      .locator("#title")
      .filter({ hasText: "新しいセッション" })
      .waitFor();
    await selectA.waitFor({ state: "detached" });
    assert.equal((await f.service.list()).length, 1);
    assert.equal(await page.locator("#message").inputValue(), "");
    assert.equal(
      await page.evaluate(() => document.activeElement?.id),
      "message",
    );
    await page.reload();
    await selectB.waitFor();
    assert.equal(await selectA.count(), 0);
    f.faux.setResponses([answer("新しいセッションで応答")]);
    await page.locator("#message").fill("会話 A");
    await page.locator("#send").click();
    await page.getByText("新しいセッションで応答", { exact: true }).waitFor();
    const sessions = await f.service.list();
    assert.equal(sessions.length, 2);
    assert.ok(sessions.every((session) => session.id !== a.id));
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
    await browser.close();
    await server.close();
    await f.service.close();
  }
});

test("sidebar scrolling stays within the session list at short desktop and mobile heights", async () => {
  const f = await fixture();
  for (let index = 0; index < 32; index++)
    await f.service.create(crypto.randomUUID(), `スクロール確認 ${index}`);
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
  const page = await browser.newPage({ reducedMotion: "reduce" });
  try {
    await page.goto(origin);
    await page.locator(".conversation-item").first().waitFor();
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 400 });
      if (width < 768)
        await page
          .getByRole("button", { name: "セッション一覧を開く", exact: true })
          .click();
      const fixed = page.locator(
        ".sidebar-header, .session-list-controls, .sidebar-footer",
      );
      const bounds = () =>
        fixed.evaluateAll((nodes) =>
          nodes.map((node) => {
            const { x, y, width, height } = node.getBoundingClientRect();
            return { x, y, width, height };
          }),
        );
      const before = await bounds();
      assert.equal(
        await page.evaluate(() => document.documentElement.clientWidth),
        width,
        "Only scrollable panels reserve scrollbar space",
      );
      const list = page.locator("#conversations");
      assert.equal(
        await list.evaluate((node) => node.scrollHeight > node.clientHeight),
        true,
      );
      await list.hover();
      await page.mouse.wheel(0, 5000);
      await page.waitForFunction(
        () => document.getElementById("conversations")!.scrollTop > 0,
      );
      await page.mouse.wheel(0, 5000);
      assert.deepEqual(await bounds(), before);
      assert.equal(await page.evaluate(() => scrollY), 0);
      assert.equal(
        await list.evaluate((node) => node.scrollWidth <= node.clientWidth),
        true,
      );
      await page.locator(".sidebar-header").hover();
      await page.mouse.wheel(0, 5000);
      assert.deepEqual(await bounds(), before);
      assert.equal(
        await page.locator("#sidebar").evaluate((node) => node.scrollTop),
        0,
      );
      await page.screenshot({
        path: `test-results/sidebar-scroll-${width}.png`,
      });
    }
  } finally {
    await browser.close();
    await server.close();
    await f.service.close();
  }
});
