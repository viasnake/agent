import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { chromium } from "playwright";
import { fixture } from "../support.js";
import { createServer } from "../../src/server.js";

test("Copilot device UI, reauthentication, disconnect and model picker in light and dark", async () => {
  let approve!: () => void;
  const f = await fixture([], {
    modelCatalog: async () => ["gpt-4.1"],
    modelOAuth: {
      name: "Fixture Copilot",
      async login(interaction) {
        assert.equal(
          await interaction.prompt({
            type: "text",
            message: "Enterprise domain",
          }),
          "",
        );
        interaction.notify({
          type: "device_code",
          userCode: "ABCD-EFGH",
          verificationUri: "https://github.com/login/device",
          expiresInSeconds: 600,
        });
        await new Promise<void>((resolve, reject) => {
          approve = resolve;
          interaction.signal.addEventListener(
            "abort",
            () => reject(new Error("cancelled")),
            { once: true },
          );
        });
        return {
          type: "oauth",
          access: "browser-copilot-access-secret",
          refresh: "browser-copilot-refresh-secret",
          expires: Date.now() + 3600000,
          availableModelIds: ["gpt-4.1"],
        };
      },
      async refresh() {
        throw new Error("Not expected");
      },
      async toAuth(credential) {
        return { apiKey: credential.access };
      },
    },
  });
  const initial = await createServer(f.service, resolve("dist/web") + "/");
  await initial.listen({ host: "127.0.0.1", port: 0 });
  const address = initial.server.address();
  assert.ok(address && typeof address !== "string");
  await initial.close();
  const origin = `http://127.0.0.1:${address.port}`;
  f.config.server.origins = [origin];
  const server = await createServer(f.service, resolve("dist/web") + "/");
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
      .selectOption("github-copilot");
    assert.equal(
      await page.getByLabel("認証方式", { exact: true }).inputValue(),
      "oauth",
    );
    assert.equal(await page.getByLabel("API キー", { exact: true }).count(), 0);
    await page
      .getByRole("button", { name: "Continue with GitHub", exact: true })
      .click();
    const code = page.getByLabel("認証コード", { exact: true });
    await code.waitFor();
    assert.equal(await code.textContent(), "ABCD-EFGH");
    assert.equal(
      await page
        .getByRole("link", { name: "GitHub の認証を開く" })
        .getAttribute("href"),
      "https://github.com/login/device",
    );
    assert.equal(
      await page.getByLabel("認証後の URL", { exact: false }).count(),
      0,
    );
    await mkdir("test-results", { recursive: true });
    await page.screenshot({
      path: "test-results/copilot-device-light.png",
      animations: "disabled",
    });
    await page.reload();
    await page.getByRole("button", { name: "設定", exact: true }).click();
    await code.waitFor();
    await page.emulateMedia({ colorScheme: "dark" });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.screenshot({
      path: "test-results/copilot-device-dark.png",
      animations: "disabled",
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    approve();
    await page.getByText("GitHub Copilot 認証済み", { exact: true }).waitFor();
    await page
      .locator(".notification")
      .filter({ hasText: "GitHub Copilot に接続しました。" })
      .waitFor();
    assert.ok(!(await page.content()).includes("browser-copilot"));
    await page
      .getByRole("button", { name: "セッションに戻る", exact: true })
      .click();
    await page
      .getByRole("button", { name: "セッションのモデル", exact: true })
      .click();
    const group = page.getByRole("group", {
      name: "GitHub Copilot",
      exact: true,
    });
    await group.waitFor();
    assert.equal(await group.locator(".model-option").count(), 1);
    await group.getByRole("button", { name: "gpt-4.1", exact: true }).click();
    await page.getByRole("button", { name: "設定", exact: true }).click();
    await page.locator(".settings-disclosure > summary").first().click();
    await page
      .getByRole("button", { name: "Continue with GitHub", exact: true })
      .click();
    await code.waitFor();
    await page.getByRole("button", { name: "認証を中止", exact: true }).click();
    await code.waitFor({ state: "hidden" });
    assert.equal(f.service.management().models[0]!.authorized, true);
    // Cancellation of reauthentication preserves the prior working credential.
    await page.getByRole("button", { name: "認証を解除", exact: true }).click();
    await page.getByText("GitHub Copilot 未認証", { exact: true }).waitFor();
    assert.equal(f.service.management().models[0]!.authorized, false);
    await page
      .getByRole("button", { name: "セッションに戻る", exact: true })
      .click();
    await page
      .getByRole("button", { name: "セッションのモデル", exact: true })
      .click();
    await page
      .getByText("選択できるモデルがありません", { exact: true })
      .waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await server.close();
    await f.service.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
