import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";
import { createServer } from "../../src/server.js";
import { answer, fixture } from "../support.js";
import { returnToSession } from "./navigation.js";

test("Auto is configured from saved models and remains selected after an answer and reload", async () => {
  const connectionId = randomUUID();
  const calls: string[] = [];
  const f = await fixture([answer("猫は英語で cat です。")], {
    classifyRoute: async (_config, request, rules) => {
      calls.push(request);
      return rules.find((rule) => rule.condition === "短い翻訳・文章の整形")
        ?.id;
    },
  });
  await f.service.saveSettings({
    revision: 0,
    models: [
      {
        id: connectionId,
        name: "OpenAI 接続",
        provider: "openai",
        key: "fixture-api-token",
      },
    ],
    defaultModel: connectionId,
    mcp: [],
    instructions: "",
    limits: { modelRequests: 10, runSeconds: 60, commandSeconds: 10 },
  });
  const probe = await createServer(f.service);
  const origin = await probe.listen({ host: "127.0.0.1", port: 0 });
  await probe.close();
  f.config.server.origins = [origin];
  const server = await createServer(f.service, resolve("dist/web") + "/");
  await server.listen({
    host: "127.0.0.1",
    port: Number(new URL(origin).port),
  });
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    colorScheme: "light",
  });
  const picker = page.getByRole("button", {
    name: "セッションのモデル",
    exact: true,
  });
  const screenshots = process.env.AGENT_AUTO_SCREENSHOTS;
  try {
    await page.goto(origin);
    await page.getByRole("button", { name: "設定", exact: true }).click();
    const panel = page
      .locator("details")
      .filter({ has: page.locator("summary span", { hasText: /^Auto$/ }) });
    await panel.locator("summary").click();
    await panel
      .getByLabel("モデル接続", { exact: true })
      .selectOption(connectionId);
    await panel
      .getByLabel("既定モデル", { exact: true })
      .selectOption("gpt-4.1");
    const add = panel.getByRole("button", { name: "ルールを追加" });
    for (const [index, condition, model] of [
      [1, "短い翻訳・文章の整形", "gpt-4.1-mini"],
      [2, "コードの実装・テストの修正", "gpt-4.1-nano"],
      [3, "削除する条件", "gpt-4.1-mini"],
    ] as const) {
      await add.click();
      const rule = panel.getByRole("group", {
        name: `ルール ${index}`,
        exact: true,
      });
      await rule.getByLabel("使う条件", { exact: true }).fill(condition);
      await rule.getByLabel("使用モデル", { exact: true }).selectOption(model);
    }
    await panel
      .getByRole("button", { name: "ルール 3を削除", exact: true })
      .click();
    await panel
      .getByLabel("Cloudflare アカウント ID", { exact: true })
      .fill("a".repeat(32));
    await panel
      .getByLabel("Workers AI トークン", { exact: true })
      .fill("fixture-classifier-token");
    const saved = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/settings" &&
        response.request().method() === "PUT",
    );
    await page.getByRole("button", { name: "設定を保存", exact: true }).click();
    assert.equal((await saved).status(), 200);
    await panel.getByText("有効", { exact: true }).waitFor();
    assert.deepEqual(
      f.service.management().autoModel?.rules.map((rule) => rule.condition),
      ["短い翻訳・文章の整形", "コードの実装・テストの修正"],
    );
    assert.equal(
      await panel
        .getByLabel("既定モデル", { exact: true })
        .evaluate((element) => getComputedStyle(element).appearance),
      "none",
    );
    if (screenshots)
      await panel.screenshot({
        path: join(screenshots, "auto-rules-settings.png"),
        animations: "disabled",
      });
    await returnToSession(page);
    await picker.filter({ hasNotText: "Auto" }).click();
    await page.getByRole("button", { name: "Auto", exact: true }).click();
    await picker.filter({ hasText: "Auto" }).waitFor();
    const prompt = "猫を英語で何と言う？";
    await page.locator("#message").fill(prompt);
    await page.locator("#send").click();
    await page.getByText("猫は英語で cat です。", { exact: true }).waitFor();
    await page
      .locator(".assistant-message")
      .getByText("gpt-4.1-mini", { exact: true })
      .waitFor();
    assert.deepEqual(calls, [prompt]);
    await page.reload();
    await page.getByRole("button", { name: prompt, exact: true }).click();
    await picker.filter({ hasText: "Auto" }).waitFor();
    await page
      .locator(".assistant-message")
      .getByText("gpt-4.1-mini", { exact: true })
      .waitFor();
    await page.setViewportSize({ width: 375, height: 812 });
    await page.emulateMedia({ colorScheme: "dark" });
    assert.equal(await picker.isVisible(), true);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    if (screenshots)
      await page.screenshot({
        path: join(screenshots, "auto-rules-mobile.png"),
        animations: "disabled",
      });
  } finally {
    await browser.close();
    await server.close();
    await f.service.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
