import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer as portProbe } from "node:net";
import { resolve } from "node:path";
import { chromium } from "playwright";
import sharp from "sharp";
import { fauxProvider } from "@earendil-works/pi-ai";
import { fixture, answer, until } from "../support.js";
import { createServer } from "../../src/server.js";

test("Web settings save cloud connections and display private image inputs across reload, light/dark and mobile", async (t) => {
  const faux = fauxProvider({
    tokensPerSecond: Infinity,
    models: [
      { id: "faux-1", input: ["text", "image"] },
      { id: "gemini-2.5-flash", input: ["text", "image"] },
    ],
  });
  faux.setResponses([answer("画像を受け取りました。")]);
  const f = await fixture([], { provider: faux.provider });
  t.after(() => f.service.close());
  const probe = portProbe();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const address = probe.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((done) => probe.close(() => done()));
  const origin = `http://127.0.0.1:${address.port}`;
  f.config.server.origins = [origin];
  const server = await createServer(f.service, resolve("dist/web") + "/");
  t.after(() => server.close());
  await server.listen({ host: "127.0.0.1", port: address.port });
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    colorScheme: "light",
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(origin);
    await page.getByRole("button", { name: "設定", exact: true }).click();
    await page.getByRole("button", { name: "接続を追加", exact: true }).click();
    await page
      .getByLabel("プロバイダー", { exact: true })
      .selectOption("google-vertex");
    await page.getByLabel("接続名", { exact: true }).fill("Cloud Vision");
    await page
      .getByLabel("プロジェクト ID", { exact: true })
      .fill("fixture-project");
    await page.getByLabel("ロケーション", { exact: true }).fill("global");
    assert.equal(
      await page.getByLabel("認証方式", { exact: true }).inputValue(),
      "adc",
    );
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await until(async () => f.service.settings.snapshot().models.length === 1);
    await page.getByRole("button", { name: "接続を追加", exact: true }).click();
    await page
      .getByLabel("プロバイダー", { exact: true })
      .last()
      .selectOption("amazon-bedrock");
    await page.getByLabel("接続名", { exact: true }).last().fill("AWS fixture");
    await page.getByLabel("リージョン", { exact: true }).fill("us-west-2");
    await page
      .getByLabel("AWS プロファイル", { exact: true })
      .fill("fixture-profile");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await until(async () => f.service.settings.snapshot().models.length === 2);
    await page
      .getByRole("button", { name: "セッションに戻る", exact: true })
      .click();
    await page
      .getByRole("button", { name: "セッションのモデル", exact: true })
      .click();
    await page
      .getByRole("searchbox", { name: "モデルを検索" })
      .fill("gemini-2.5-flash");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "gemini-2.5-flash", exact: true })
      .click();
    const bytes = await sharp({
      create: { width: 2048, height: 128, channels: 3, background: "red" },
    })
      .png()
      .toBuffer();
    await page.locator('input[type="file"]').setInputFiles({
      name: "fixture.png",
      mimeType: "image/png",
      buffer: bytes,
    });
    await page.waitForFunction(
      () =>
        document.querySelector<HTMLImageElement>(".attachment-preview")
          ?.naturalWidth === 2048,
    );
    await page.locator("#message").fill("この画像を説明してください。");
    await page.locator("#send").click();
    await page.getByText("画像を受け取りました。", { exact: true }).waitFor();
    await page.getByAltText("添付画像", { exact: true }).waitFor();
    await page.waitForFunction(
      () =>
        document.querySelector<HTMLImageElement>(".user-message img")
          ?.naturalWidth === 2048,
    );
    const url = await page
      .getByAltText("添付画像", { exact: true })
      .getAttribute("src");
    assert.ok(url?.startsWith("/api/conversations/"));
    await page.getByRole("button", { name: "画像を拡大", exact: true }).click();
    await page
      .getByRole("dialog", { name: "画像プレビュー", exact: true })
      .waitFor();
    await page.keyboard.press("Escape");
    assert.equal(
      await page
        .getByRole("button", { name: "画像を拡大", exact: true })
        .evaluate((node) => node === document.activeElement),
      true,
    );
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await page.setViewportSize({
        width: colorScheme === "dark" ? 390 : 1280,
        height: 900,
      });
      const image = await page
        .getByAltText("添付画像", { exact: true })
        .boundingBox();
      assert.ok(
        image &&
          image.width > 0 &&
          image.width <= (colorScheme === "dark" ? 390 : 1280),
      );
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.reload();
    await page.locator("#conversations button").first().click();
    await page.getByAltText("添付画像", { exact: true }).waitFor();
    await page.waitForFunction(
      () =>
        document.querySelector<HTMLImageElement>(".user-message img")
          ?.naturalWidth === 2048,
    );
    assert.deepEqual(errors, []);
    assert.equal(
      f.service.settings.snapshot().models[1]!.profile,
      "fixture-profile",
    );
  } finally {
    await browser.close();
  }
});
