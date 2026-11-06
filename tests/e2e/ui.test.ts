import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as netServer } from "node:net";
import { resolve } from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { chromium } from "playwright";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createServer } from "../../src/server.js";
import { fixture, codeResponses, untilJob } from "../support.js";

test("A02 A04 A12 S08: real authenticated UI, disconnect/reconnect, safe text and downloadable patch", async () => {
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>((resolveHeld) => {
    release = resolveHeld;
  });
  const ready = new Promise<void>((resolveReady) => {
    entered = resolveReady;
  });
  const { service, config } = await fixture(
    [
      async () => {
        entered();
        await held;
        return fauxAssistantMessage(
          fauxToolCall("validate_command", {
            command: "cd project && python3 -B -m unittest -v",
          }),
          { stopReason: "toolUse" },
        );
      },
      ...codeResponses().slice(1),
    ],
    { codeFixture: true },
  );
  const reservation = netServer();
  await new Promise<void>((resolveListen) =>
    reservation.listen(0, "127.0.0.1", resolveListen),
  );
  const address = reservation.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolveClose) =>
    reservation.close(() => resolveClose()),
  );
  const origin = `http://127.0.0.1:${port}`;
  config.server.origins = [origin];
  const app = await createServer(
    service,
    "synthetic-ui-password-longer-than-32-characters",
    resolve("dist/web"),
  );
  await app.listen({ host: "127.0.0.1", port });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1050 },
    acceptDownloads: true,
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
  });
  const external: string[] = [];
  context.on("request", (request) => {
    if (request.url().startsWith("https://attacker.invalid"))
      external.push(request.url());
  });
  try {
    let page = await context.newPage();
    await page.goto(origin);
    await page
      .getByLabel("認証情報")
      .fill("synthetic-ui-password-longer-than-32-characters");
    await page.getByRole("button", { name: "ログイン", exact: true }).click();
    await page.getByRole("heading", { name: "何を進めましょうか。" }).waitFor();
    await mkdir("test-results", { recursive: true });
    await page.screenshot({
      path: "test-results/ui-request.png",
      fullPage: true,
    });
    await page.getByLabel("依頼名").fill("計算バグを修正");
    await page
      .getByLabel("依頼内容")
      .fill(
        '計算バグを修正してください。<img src="https://attacker.invalid/pixel" onerror="alert(1)">',
      );
    await page.getByLabel("完成の条件").fill("テスト成功\n差分の納品");
    let loseResponse = true;
    await page.route("**/api/jobs", async (route) => {
      if (route.request().method() === "POST" && loseResponse) {
        loseResponse = false;
        const accepted = await route.fetch();
        assert.equal(accepted.status(), 202);
        await route.abort("connectionreset");
      } else await route.continue();
    });
    await page
      .getByRole("button", { name: "仕事を依頼する", exact: true })
      .click();
    await page.locator("#error").waitFor({ state: "visible" });
    await page
      .getByRole("button", { name: "仕事を依頼する", exact: true })
      .click();
    await page.locator("#detail").waitFor({ state: "visible" });
    await ready;
    assert.equal((await service.snapshot()).jobs.length, 1);
    const id = (await service.snapshot()).jobs[0]!.id;
    await page.close();
    release();
    const job = await untilJob(
      service,
      id,
      (job) => job.status === "succeeded" || job.status === "failed",
    );
    assert.equal(job.status, "succeeded", job.detail);
    page = await context.newPage();
    await page.goto(origin);
    await page.locator(".job-link").first().click();
    await page.locator("#job-state").filter({ hasText: "納品済み" }).waitFor();
    const count = await page.locator(".message").count();
    await page.waitForTimeout(800);
    assert.equal(await page.locator(".message").count(), count);
    assert.equal(await page.locator("#original img").count(), 0);
    assert.deepEqual(external, []);
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("link", { name: /changes.patch/ }).click();
    const download = await downloadPromise;
    const path = await download.path();
    assert.ok(path);
    assert.match((await readFile(path)).toString(), /return sum\(values\)/);
    await page.screenshot({
      path: "test-results/ui-delivered.png",
      fullPage: true,
    });
    const anonymous = await browser.newContext();
    const denied = await anonymous.request.get(`${origin}/api/jobs`);
    assert.equal(denied.status(), 401);
    await anonymous.close();
    console.log(
      `Screenshots: ${resolve("test-results/ui-request.png")}, ${resolve("test-results/ui-delivered.png")}`,
    );
  } finally {
    release();
    await browser.close();
    app.server.closeAllConnections();
    await app.close();
    await service.close();
  }
});
