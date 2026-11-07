import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { chromium, type Page } from "playwright";
import { fixture, call, answer, until } from "../support.js";
import { createServer } from "../../src/server.js";
import { mcpToolName } from "../../src/tools.js";
async function assertDropdowns(page: Page) {
  const controls = await page
    .locator(".settings-page select")
    .evaluateAll((nodes) =>
      nodes.map((node) => {
        const css = getComputedStyle(node),
          bounds = node.getBoundingClientRect();
        return {
          label: node.getAttribute("aria-label"),
          appearance: css.appearance,
          width: bounds.width,
          height: bounds.height,
          border: parseFloat(css.borderTopWidth),
          caret: css.backgroundImage,
        };
      }),
    );
  assert.ok(controls.length > 0);
  for (const control of controls) {
    assert.equal(
      control.appearance,
      "none",
      `${control.label} must use the styled control`,
    );
    assert.ok(
      control.width >= 200 && control.height >= 30 && control.border > 0,
      `${control.label} must have usable dimensions and a border`,
    );
    assert.notEqual(
      control.caret,
      "none",
      `${control.label} must show a dropdown caret`,
    );
  }
}
test("Web management saves models, ChatGPT OAuth, stdio MCP and limits with mobile/light/dark conversations", async () => {
  const f = await fixture([], {
      modelOAuth: {
        name: "Fixture OAuth",
        async login(interaction) {
          interaction.notify({
            type: "auth_url",
            url: "https://auth.openai.com/api/accounts/authorize?state=browser-fixture",
          });
          const callback = await interaction.prompt({
            type: "manual_code",
            message: "Callback",
            signal: interaction.signal,
          });
          assert.equal(
            new URL(callback).searchParams.get("state"),
            "browser-fixture",
          );
          return {
            type: "oauth",
            access: "browser-access-secret",
            refresh: "browser-refresh-secret",
            expires: Date.now() + 3600000,
          };
        },
        async refresh() {
          throw new Error("Not expected");
        },
        async toAuth(credential) {
          return { apiKey: credential.access };
        },
      },
    }),
    app = await createServer(f.service, resolve("dist/web") + "/");
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  // Origins are captured when constructing the server, so use the configured Host through routing.
  await app.close();
  f.config.server.origins = [origin];
  const server = await createServer(f.service, resolve("dist/web") + "/");
  await server.listen({ host: "127.0.0.1", port: address.port });
  const browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox"],
    }),
    page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
      colorScheme: "light",
    });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.goto(origin);
    await page.getByRole("button", { name: "設定", exact: true }).click();
    await page
      .getByRole("button", { name: "モデルを追加", exact: true })
      .click();
    await page
      .getByRole("button", { name: "設定するモデル", exact: true })
      .click();
    await page.getByRole("searchbox", { name: "モデルを検索" }).fill("gpt-4.1");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "gpt-4.1", exact: true })
      .click();
    await page
      .getByLabel("API キー", { exact: true })
      .fill("browser-dummy-key");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page.getByText("保存しました。").waitFor();
    assert.equal(
      await page.getByLabel("API キー", { exact: true }).inputValue(),
      "••••••••",
    );
    await page.getByLabel("API キー", { exact: true }).fill("");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page.getByText("API キー未登録", { exact: true }).waitFor();
    assert.equal(f.service.management().models.length, 1);
    assert.equal(f.service.management().models[0]!.hasKey, false);
    assert.equal(
      await page.getByText("既定のモデル", { exact: true }).count(),
      0,
    );
    assert.equal(
      await page
        .getByRole("button", { name: "API キーを削除", exact: true })
        .count(),
      0,
    );
    await page.getByLabel("認証方式", { exact: true }).selectOption("oauth");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page
      .getByRole("button", { name: "Continue with ChatGPT", exact: true })
      .click();
    await page.getByRole("link", { name: "ChatGPT の認証を開く" }).waitFor();
    await page.reload();
    await page.getByRole("button", { name: "設定", exact: true }).click();
    assert.match(
      (await page
        .getByRole("link", { name: "ChatGPT の認証を開く" })
        .getAttribute("href")) ?? "",
      /^https:\/\/auth.openai.com\//,
    );
    await page
      .getByLabel("認証後の URL", { exact: false })
      .fill(
        "http://127.0.0.1:1455/auth/callback?code=browser-code&state=browser-fixture",
      );
    await page.getByRole("button", { name: "認証を完了", exact: true }).click();
    await page.getByText("ChatGPT 認証済み", { exact: true }).waitFor();
    assert.ok(!(await page.content()).includes("browser-access-secret"));
    assert.ok(!(await page.content()).includes("browser-refresh-secret"));
    await mkdir("test-results", { recursive: true });
    await assertDropdowns(page);
    await page.screenshot({
      path: "test-results/model-oauth-light.png",
      animations: "disabled",
    });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await assertDropdowns(page);
    await page.screenshot({
      path: "test-results/model-oauth-mobile-dark.png",
      animations: "disabled",
    });
    await page
      .getByRole("button", { name: "ChatGPT 認証を解除", exact: true })
      .click();
    await page.getByText("ChatGPT 未認証", { exact: true }).waitFor();
    await page.getByLabel("認証方式", { exact: true }).selectOption("api_key");
    await page
      .getByLabel("API キー", { exact: true })
      .fill("browser-replaced-key");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page.getByText("保存しました。").waitFor();
    await page.emulateMedia({ colorScheme: "light" });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page
      .getByRole("button", { name: "モデルを追加", exact: true })
      .click();
    await page
      .getByRole("button", { name: "設定するモデル", exact: true })
      .last()
      .click();
    const search = page.getByRole("searchbox", { name: "モデルを検索" });
    await search.fill("no-matching-model");
    await page.getByText("一致するモデルがありません").waitFor();
    await search.fill("gpt-4.1-mini");
    await page.screenshot({ path: "test-results/model-picker-light.png" });
    await search.press("ArrowDown");
    await page.keyboard.press("Enter");
    await page
      .getByLabel("API キー", { exact: true })
      .last()
      .fill("second-dummy-key");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page.getByText("保存しました。").waitFor();
    await page.getByRole("button", { name: "MCP", exact: true }).click();
    await page.getByRole("button", { name: "MCP を追加", exact: true }).click();
    await page.getByLabel("接続方式", { exact: true }).selectOption("http");
    await assertDropdowns(page);
    assert.equal(
      await page
        .getByText("社内・VPN 接続を許可するホスト", { exact: false })
        .count(),
      0,
    );
    await page.screenshot({
      path: "test-results/mcp-dropdown-light.png",
      animations: "disabled",
    });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.setViewportSize({ width: 390, height: 844 });
    await assertDropdowns(page);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.screenshot({
      path: "test-results/mcp-dropdown-mobile-dark.png",
      animations: "disabled",
    });
    await page.emulateMedia({ colorScheme: "light" });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByLabel("接続方式", { exact: true }).selectOption("stdio");
    await page.getByLabel("名前", { exact: true }).fill("Fixture");
    await page.getByLabel("コマンド").fill(process.execPath);
    await page
      .getByLabel("引数")
      .fill(resolve(".test-dist/tests/mcp-server.js"));
    await page
      .getByRole("button", { name: "環境変数を追加", exact: true })
      .click();
    await page.getByLabel("環境変数名 1", { exact: true }).fill("FIXTURE_KEY");
    await page
      .getByLabel("環境変数の値 1", { exact: true })
      .fill("browser-stdio-secret");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page.getByText("保存しました。").waitFor();
    assert.equal(await page.locator("legend").last().textContent(), "Fixture");
    assert.equal(
      await page.getByLabel("環境変数の値 1", { exact: true }).inputValue(),
      "••••••••",
    );
    await page
      .getByRole("button", { name: "環境変数を追加", exact: true })
      .click();
    await page.getByLabel("環境変数名 2", { exact: true }).fill("EXTRA");
    await page
      .getByLabel("環境変数の値 2", { exact: true })
      .fill("extra-value");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page.getByText("保存しました。", { exact: true }).waitFor();
    assert.equal(
      f.service.settings.snapshot().mcp[0]!.env!.FIXTURE_KEY,
      "browser-stdio-secret",
    );
    await page
      .getByRole("button", { name: "環境変数 2 を削除", exact: true })
      .click();
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page.getByText("保存しました。", { exact: true }).waitFor();
    assert.equal(f.service.settings.snapshot().mcp[0]!.env!.EXTRA, undefined);
    await page.getByRole("button", { name: "テスト", exact: true }).click();
    await page.getByText("接続済み", { exact: true }).waitFor();
    await page.getByText("ツール（1）").click();
    await page.getByText("greet", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Agent 設定", exact: true }).click();
    await page
      .getByLabel("共通指示", { exact: true })
      .fill("Keep replies short.");
    await page.getByLabel("モデル呼び出し上限").fill("5");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page.getByText("保存しました。").waitFor();
    await mkdir("test-results", { recursive: true });
    await page.screenshot({ path: "test-results/settings-light.png" });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.screenshot({ path: "test-results/settings-dark.png" });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.screenshot({ path: "test-results/settings-mobile.png" });
    const mcp = f.service.management().mcp[0]!;
    f.faux.setResponses([
      call(mcpToolName(mcp.id, "greet"), { name: "Browser" }),
      call("write", { path: "outputs/browser.txt", content: "verified" }),
      answer("完了しました"),
    ]);
    await page.getByRole("button", { name: "会話に戻る", exact: true }).click();
    await page
      .getByRole("button", { name: "会話のモデル", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "gpt-4.1", exact: true })
      .click();
    await page.locator("#message").fill("MCP とファイルを使って");
    await page.locator("#send").click();
    await until(async () => (await f.service.list())[0]?.status === "idle");
    await page.getByText("完了しました", { exact: true }).waitFor();
    const picker = page.getByRole("button", {
      name: "会話のモデル",
      exact: true,
    });
    await picker.click();
    await page.screenshot({
      path: "test-results/model-picker-mobile-dark.png",
    });
    await page.keyboard.press("Escape");
    assert.equal(
      await picker.evaluate((el) => el === document.activeElement),
      true,
    );
    await picker.click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "gpt-4.1-mini", exact: true })
      .click();
    await until(
      async () =>
        (await f.service.list())[0]?.modelConfigId ===
        f.service.management().models[1]!.id,
    );
    await page.screenshot({
      path: "test-results/conversation-model-mobile-dark.png",
    });

    await page.reload();
    await page.locator("#app").waitFor();
    await page.getByRole("button", { name: "会話一覧を開く" }).click();
    await page.locator(".conversation-item").first().click();
    await page
      .getByRole("button", { name: "会話のモデル", exact: true })
      .filter({ hasText: "gpt-4.1-mini" })
      .waitFor();
    await page.getByText("完了しました", { exact: true }).waitFor();

    assert.equal(f.service.management().instructions, "Keep replies short.");
    assert.equal(f.service.management().pending, false);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await server.close();
    await f.service.close();
  }
});
