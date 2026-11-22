import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { createServer as portProbe } from "node:net";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { chromium, type Browser } from "playwright";
import { createServer } from "../../src/server.js";
import { reviewRepository } from "../git-review-fixture.js";
import { answer, call, fixture, until } from "../support.js";

test("changes tab shows Git patches separately from downloadable files", async (t) => {
  const f = await fixture([
    call("write", { path: "outputs/review.txt", content: "Review notes" }),
    answer("review ready"),
  ]);
  t.after(async () => {
    await f.service.close();
    await rm(f.root, { recursive: true, force: true });
  });
  const a = await f.service.create(randomUUID(), "Git review");
  const b = await f.service.create(randomUUID(), "Empty review");
  await f.service.send(a.id, randomUUID(), "review");
  await until(
    async () => (await f.service.conversation(a.id)).status === "idle",
  );
  const { base } = await reviewRepository(
    join(f.root, "work/conversations", a.id, "repo"),
  );
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
    const page = await browser.newPage({
      viewport: { width: 1280, height: 800 },
    });
    let patchRequests = 0;
    let reviewRequests = 0;
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path.includes("/git/")) reviewRequests++;
      if (path.endsWith("/git/patch")) patchRequests++;
    });
    const selectSession = (id: string) =>
      page.locator(`[data-session-id="${id}"] .conversation-item`).click();
    const files = () =>
      page.getByRole("tab", { name: "ファイル", exact: true }).click();
    const changes = () =>
      page.getByRole("tab", { name: "変更", exact: true }).click();
    const downloads = page.getByRole("region", { name: "添付・生成ファイル" });
    const file = page.getByRole("button", { name: "変更: app.txt" });
    const patch = page.locator(".git-review-patch");
    await page.goto(origin);
    await selectSession(a.id);
    await files();
    await downloads.getByRole("link", { name: /review.txt/ }).waitFor();
    assert.equal(reviewRequests, 0);
    await changes();
    assert.equal(await downloads.isVisible(), false);
    await file.waitFor();
    assert.equal(patchRequests, 0);
    await file.click();
    await patch.waitFor();
    assert.match(
      (await patch.textContent())!,
      /\+working <script>text<\/script>/,
    );
    assert.equal(await patch.locator("script").count(), 0);
    assert.equal(await file.getAttribute("aria-pressed"), "true");
    assert.equal(
      await patch.locator(".git-patch-removed span").first().textContent(),
      "1",
    );
    assert.equal(
      await patch.locator(".git-patch-added span").nth(1).textContent(),
      "1",
    );
    const color = () =>
      patch
        .locator(".git-patch-added")
        .evaluate((line) => getComputedStyle(line).backgroundColor);
    const light = await color();
    assert.notEqual(light, "rgba(0, 0, 0, 0)");
    await page.emulateMedia({ colorScheme: "dark" });
    assert.notEqual(await color(), light);
    const working = page.getByRole("tab", { name: "未コミット", exact: true });
    await working.focus();
    await working.press("ArrowRight");
    const picker = page.getByRole("combobox", { name: "比較の起点" });
    const original = picker
      .locator("option")
      .filter({ hasText: /^original — \d{4}-\d{2}-\d{2}/ });
    await original.waitFor({ state: "attached" });
    assert.equal(await original.getAttribute("value"), base);
    assert.equal(await picker.locator("option").count(), 2);
    await picker.selectOption({ label: (await original.textContent())! });
    await file.click();
    await patch.waitFor();
    assert.deepEqual(
      await patch.locator(".git-patch-line code").allTextContents(),
      ["@@ -1 +1 @@", "-original", "+committed line"],
    );
    assert.equal(patchRequests, 2);
    await page.setViewportSize({ width: 390, height: 844 });
    const back = page.getByRole("button", { name: "変更ファイルに戻る" });
    await back.click();
    await file.waitFor();
    assert.equal(
      await file.evaluate((node) => node === document.activeElement),
      true,
    );
    await file.press("Enter");
    await patch.waitFor();
    assert.equal(
      await back.evaluate((node) => node === document.activeElement),
      true,
    );
    assert.equal(await file.isVisible(), false);
    const sessionTabs = page.getByRole("tablist", { name: "セッションの内容" });
    assert.equal(
      await sessionTabs.evaluate(
        (node) => node.scrollWidth === node.clientWidth,
      ),
      true,
    );
    assert.equal(
      await page
        .locator("#changes-panel")
        .evaluate((node) => node.scrollWidth === node.clientWidth),
      true,
    );
    await page.setViewportSize({ width: 1280, height: 800 });
    await selectSession(b.id);
    await changes();
    await page.getByText("セッション内に Git クローンはありません").waitFor();
    assert.equal(await patch.count(), 0);
  } finally {
    await browser?.close();
    await app.close();
  }
});
