import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";
import { createServer } from "../../src/server.js";
import { answer, fixture } from "../support.js";

test("model search focuses immediately and recent choices follow the user across sessions", async () => {
  const f = await fixture([], {
    modelCatalog: async () => ["gpt-4.1", "gpt-4.1-mini"],
  });
  const primary = randomUUID();
  const secondary = randomUUID();
  const settings = {
    revision: f.service.management().revision,
    models: [
      {
        id: primary,
        provider: "openai",
        name: "Primary",
        key: "fixture-primary-key",
      },
      {
        id: secondary,
        provider: "openai",
        name: "Secondary",
        key: "fixture-secondary-key",
      },
    ],
    defaultModel: primary,
    mcp: [],
    instructions: "",
    limits: { modelRequests: 5, runSeconds: 60, commandSeconds: 10 },
  };
  await f.service.saveSettings(settings);
  await f.service.create(
    randomUUID(),
    "保存済みセッション",
    primary,
    "gpt-4.1-mini",
  );
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
  const page = await browser.newPage();
  const picker = page.getByRole("button", { name: "セッションのモデル" });
  const search = page.getByRole("searchbox", { name: "モデルを検索" });
  const recent = page.getByRole("group", { name: "最近選択したモデル" });
  async function choose(group: string, name: string) {
    await picker.click();
    const saved = page.waitForResponse(
      (response) => response.request().method() === "PUT",
    );
    await page
      .getByRole("group", { name: group, exact: true })
      .getByRole("button", { name, exact: true })
      .click();
    assert.equal((await saved).status(), 200);
  }
  async function assertRecent(names: string[]) {
    assert.deepEqual(
      (await recent.getByRole("button").allInnerTexts()).map((text) =>
        text.replace(/\s+/g, " ").trim(),
      ),
      names,
    );
  }
  try {
    await page.goto(origin);
    await picker.filter({ hasText: "gpt-4.1" }).click();
    assert.equal(
      await search.evaluate((input) => input === document.activeElement),
      true,
    );
    await page.keyboard.type("Secondary");
    assert.equal(await search.inputValue(), "Secondary");
    await search.clear();
    await page.keyboard.press("Escape");
    assert.equal(
      await picker.evaluate((button) => button === document.activeElement),
      true,
    );

    await choose("Primary", "gpt-4.1-mini");
    await choose("Secondary", "gpt-4.1");
    await choose("Secondary", "gpt-4.1-mini");
    await choose("Primary", "gpt-4.1");
    await picker.click();
    await assertRecent([
      "gpt-4.1 Primary",
      "gpt-4.1-mini Secondary",
      "gpt-4.1 Secondary",
    ]);
    await search.press("ArrowDown");
    assert.equal(
      await recent
        .getByRole("button")
        .first()
        .evaluate((option) => option === document.activeElement),
      true,
    );
    assert.equal(await page.locator(".model-option").count(), 4);
    await page.keyboard.press("Escape");

    await page
      .getByRole("button", { name: "保存済みセッション", exact: true })
      .click();
    await picker.filter({ hasText: "gpt-4.1-mini" }).waitFor();
    await choose("最近選択したモデル", "gpt-4.1-mini Secondary");
    await page.reload();
    await picker.filter({ hasText: "gpt-4.1-mini" }).click();
    await assertRecent([
      "gpt-4.1-mini Secondary",
      "gpt-4.1 Primary",
      "gpt-4.1 Secondary",
    ]);
    assert.equal(
      await recent.getByRole("button").first().getAttribute("aria-pressed"),
      "true",
    );
    await page.keyboard.press("Escape");
    f.faux.setResponses([answer("選択したモデルで完了")]);
    await page.locator("#message").fill("新しいセッションを作成");
    await page.locator("#send").click();
    await page.getByText("選択したモデルで完了", { exact: true }).waitFor();
    const created = (await f.service.list()).find(
      (session) => session.title === "新しいセッションを作成",
    );
    assert.equal(created?.modelConfigId, secondary);
    assert.equal(created?.model, "gpt-4.1-mini");

    await f.service.saveSettings({
      ...settings,
      revision: f.service.management().revision,
      models: settings.models.slice(0, 1),
    });
    await page.reload();
    await picker.filter({ hasText: "gpt-4.1" }).click();
    await assertRecent(["gpt-4.1 Primary"]);
    assert.equal(
      await recent.getByRole("button").first().getAttribute("aria-pressed"),
      "true",
    );
  } finally {
    await browser.close();
    await server.close();
    await f.service.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
