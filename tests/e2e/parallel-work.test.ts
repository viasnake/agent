import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  fauxAssistantMessage,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import { createServer } from "../../src/server.js";
import { workFixture } from "../parallel-work-fixture.js";
import { call, answer, until } from "../support.js";

test("pause and resume both assignments in the live work card, then download the checked bytes", async () => {
  const f = await workFixture();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let started = 0;
  const generate: FauxResponseFactory = async () => {
    started++;
    await gate;
    return fauxAssistantMessage('{"content":"new\\n"}');
  };
  f.faux.setResponses([
    call("parallel_work", f.plan),
    generate,
    generate,
    answer("担当の変更を保存しました"),
  ]);
  const origin = "http://127.0.0.1:3797";
  f.config.server.origins = [origin];
  const app = await createServer(f.service, resolve("dist/web") + "/");
  await app.listen({ host: "127.0.0.1", port: 3797 });
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage({ colorScheme: "dark" });
    await page.goto(origin);
    await page
      .locator(`[data-session-id="${f.id}"] .conversation-item`)
      .click();
    await page.locator("#message").fill("値と文書を並列更新してください");
    await page.locator("#send").click();
    const card = page.getByRole("region", { name: "並列作業" });
    await until(async () => started === 2);
    await card.getByRole("button", { name: "一時停止", exact: true }).click();
    await card.getByText("一時停止待ち", { exact: true }).waitFor();
    release();
    await card.getByRole("button", { name: "再開" }).click();
    const link = card.getByRole("link", { name: "検証済みの差分を保存" });
    await link.waitFor();
    await card.getByText("検証内容", { exact: true }).click();
    assert.match(await card.innerText(), /grep -Fx new README.md/);
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      link.click(),
    ]);
    const path = join(f.root, "delivered.patch");
    await download.saveAs(path);
    assert.match(
      await readFile(path, "utf8"),
      /diff --git a\/app.txt b\/app.txt/,
    );
    assert.equal(started, 2);
    await page.emulateMedia({ colorScheme: "light" });
    await link.waitFor();
  } finally {
    release();
    await browser.close();
    await app.close();
    await f.service.close();
  }
});
