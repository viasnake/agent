import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer as portProbe } from "node:net";
import { chromium } from "playwright";
import { fixture, answer, call, until } from "../support.js";
import { createServer } from "../../src/server.js";
test("real browser conversation: no category, attachments, response-loss retry, reconnect, CSV download and continuation without a new job", async () => {
  const f = await fixture([
    call("bash", {
      command:
        "test -f attachments/*-input.csv && mkdir -p outputs && printf 'name,total\\nAlice,12\\n' > outputs/clean.csv",
    }),
    answer(
      "CSV を保存しました。<script>window.pwned=1</script><img src=https://evil.invalid/track>",
    ),
  ]);
  const password = "synthetic-password-for-ui-123456789012345",
    probe = portProbe();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  f.config.server.origins = [origin];
  const server = await createServer(
    f.service,
    password,
    resolve("dist/web") + "/",
  );
  await server.listen({ host: "127.0.0.1", port });
  const browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox"],
    }),
    context = await browser.newContext({
      acceptDownloads: true,
      viewport: { width: 1440, height: 1000 },
    });
  const page = await context.newPage();
  let external = 0;
  page.on("request", (request) => {
    if (request.url().includes("evil.invalid")) external++;
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
    assert.ok(
      await page
        .locator("#password")
        .evaluate(
          (input) => parseFloat(getComputedStyle(input).paddingLeft) > 0,
        ),
    );
    await page.locator("#password").fill(password);
    await page.getByRole("button", { name: "ログイン", exact: true }).click();
    await page.locator("#app").waitFor({ state: "visible" });
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
    await page.getByRole("button", { name: "送る", exact: true }).click();
    await page.getByRole("link", { name: /clean.csv/ }).waitFor();
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
    await page.reload();
    await page.locator("#app").waitFor({ state: "visible" });
    await page.locator("#conversations button").first().click();
    await page.getByRole("link", { name: /clean.csv/ }).waitFor();
    f.faux.setResponses([
      call("write", {
        path: "outputs/note.md",
        content: "# 続き\n確認しました。",
      }),
      answer("Markdown だけを保存しました。"),
    ]);
    await page.locator("#message").fill("続けて Markdown を作って");
    await page.getByRole("button", { name: "送る", exact: true }).click();
    await page.getByRole("link", { name: /note.md/ }).waitFor();
    assert.equal((await f.service.list()).length, 1);
    assert.equal(external, 0);
    assert.equal(
      await page.evaluate(() => Object.hasOwn(window, "pwned")),
      false,
    );
    await mkdir("test-results", { recursive: true });
    await page.screenshot({
      path: "test-results/conversation.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: "test-results/conversation-mobile.png",
      fullPage: true,
    });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      "Mobile layout must not overflow horizontally",
    );
    assert.ok(await page.locator("#send").isVisible());
    const home = await mkdtemp(join(tmpdir(), "agent-ui-download-"));
    await download.saveAs(join(home, "clean.csv"));
  } finally {
    await context.close();
    await browser.close();
    await server.close();
    await f.service.close();
  }
});
