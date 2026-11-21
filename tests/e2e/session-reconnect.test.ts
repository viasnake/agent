import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { fixture } from "../support.js";
import { createServer } from "../../src/server.js";

test("deletion renews a browser session after server restart without losing a draft", async () => {
  const f = await fixture();
  const target = await f.service.create(randomUUID(), "削除するセッション");
  const visible = await f.service.create(randomUUID(), "表示中のセッション");
  const probe = await createServer(f.service);
  const origin = await probe.listen({ host: "127.0.0.1", port: 0 });
  await probe.close();
  f.config.server.origins = [origin];
  let server = await createServer(f.service, resolve("dist/web") + "/");
  const listen = () =>
    server.listen({ host: "127.0.0.1", port: Number(new URL(origin).port) });
  await listen();
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage();
  try {
    await page.goto(origin);
    const subscription = page.waitForResponse(
      (response) =>
        response.url() === `${origin}/api/conversations/${visible.id}/events` &&
        response.ok(),
    );
    await page
      .getByRole("button", { name: "表示中のセッション", exact: true })
      .click();
    await subscription;
    await page.locator("#message").fill("保持する下書き");
    await page
      .getByRole("button", {
        name: "「削除するセッション」の操作",
        exact: true,
      })
      .click();
    await page
      .getByRole("button", { name: "セッションを削除", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "セッションを削除",
      exact: true,
    });
    assert.equal(await dialog.locator("p").count(), 1);
    assert.equal(await dialog.locator("p").innerText(), "削除するセッション");
    const started = performance.now();
    const deadline = setTimeout(
      () => server.server.closeAllConnections(),
      5000,
    );
    try {
      await server.close();
    } finally {
      clearTimeout(deadline);
    }
    assert.ok(
      performance.now() - started < 5000,
      "server shutdown closes the active conversation subscription",
    );
    server = await createServer(f.service, resolve("dist/web") + "/");
    await listen();
    const rejected = page.waitForResponse(
      (r) => r.request().method() === "DELETE" && r.status() === 401,
    );
    await dialog.getByRole("button", { name: "削除", exact: true }).click();
    await rejected;
    await dialog.waitFor({ state: "hidden", timeout: 5000 });
    assert.equal(
      (await f.service.list()).some((s) => s.id === target.id),
      false,
    );
    assert.equal(await page.locator("#message").inputValue(), "保持する下書き");
  } finally {
    await browser.close();
    await server.close();
    await f.service.close();
  }
});
