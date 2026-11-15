import { returnToSession } from "./navigation.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { chromium, type Page } from "playwright";
import { fixture, call, answer, until } from "../support.js";
import { createServer } from "../../src/server.js";
import { mcpToolName } from "../../src/tools.js";
async function saveSettings(page: Page) {
  // A previous success toast is not evidence that this save has completed.
  const dismiss = page.getByRole("button", { name: "通知を閉じる" });
  if (await dismiss.isVisible()) await dismiss.click();
  const response = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      new URL(response.url()).pathname === "/api/settings",
  );
  await page.getByRole("button", { name: "設定を保存", exact: true }).click();
  assert.equal((await response).status(), 200);
  await page
    .locator(".notification")
    .filter({ hasText: "保存しました。" })
    .waitFor();
}
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
      modelCatalog: async () => ["gpt-4.1", "gpt-4.1-mini"],
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
    await page.route(
      "**/api/settings",
      (route) =>
        route.fulfill({ status: 503, json: { error: "設定を読み込めません" } }),
      { times: 1 },
    );
    await page.goto(origin + "/?settings=mcp");
    await page.getByRole("button", { name: "設定", exact: true }).click();
    await page.getByRole("button", { name: "再試行", exact: true }).click();
    assert.equal(await page.locator(".brand").count(), 0);
    assert.equal(
      await page
        .getByRole("button", { name: "セッションに戻る", exact: true })
        .count(),
      0,
    );
    assert.equal(
      await page
        .getByRole("navigation", { name: "設定の種類" })
        .getByRole("heading")
        .count(),
      0,
    );
    await mkdir("test-results", { recursive: true });
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        for (const [section, label] of [
          ["models", "モデル"],
          ["mcp", "MCP"],
          ["credentials", "クレデンシャル"],
          ["skills", "Skills"],
          ["agent", "指示・制限"],
          ["memory", "記憶"],
        ] as const) {
          await page.getByRole("button", { name: label, exact: true }).click();
          await page
            .getByRole("heading", { name: label, exact: true })
            .waitFor();
          const toolbar = page.locator(
            section === "agent"
              ? ".settings-fields"
              : ".settings-toolbar:visible",
          );
          await toolbar.waitFor();
          assert.equal(
            await page
              .getByRole("button", { name: "再読み込み", exact: true })
              .count(),
            0,
          );
          const layout = await toolbar.evaluate((node) => {
            const heading = document
              .querySelector(".settings-section-heading")!
              .getBoundingClientRect();
            const box = node.getBoundingClientRect();
            const content = document.querySelector(".settings-content")!;
            return {
              left: box.left - heading.left,
              width: box.width - heading.width,
              overflow: content.scrollWidth - content.clientWidth,
            };
          });
          assert.ok(
            Math.abs(layout.left) < 1 && Math.abs(layout.width) < 1,
            `${label}: toolbar aligns with heading`,
          );
          assert.equal(
            layout.overflow,
            0,
            `${label}: no horizontal overflow at ${width}px`,
          );
          await page.screenshot({
            path: `test-results/settings-${section}-${width}-${colorScheme}.png`,
            animations: "disabled",
          });
        }
      }
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ colorScheme: "light" });
    await page.getByRole("button", { name: "モデル", exact: true }).click();
    await page.getByRole("button", { name: "追加", exact: true }).click();
    for (const width of [1600, 1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const boxes = await page
        .locator(
          ".settings-section-heading, .settings-fields, .settings-footer-content",
        )
        .evaluateAll((nodes) =>
          nodes.map((node) => {
            const { x, width } = node.getBoundingClientRect();
            return { x, width };
          }),
        );
      assert.equal(boxes.length, 3);
      for (const box of boxes.slice(1)) {
        assert.ok(
          Math.abs(box.x - boxes[0]!.x) < 1,
          `Left edges must align at ${width}px`,
        );
        assert.ok(
          Math.abs(box.width - boxes[0]!.width) < 1,
          `Content widths must match at ${width}px`,
        );
      }
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    assert.equal(
      await page.getByRole("button", { name: "設定するモデル" }).count(),
      0,
    );
    await page.getByLabel("接続名").fill("Personal");
    await page
      .getByLabel("API キー", { exact: true })
      .fill("browser-dummy-key");
    await saveSettings(page);
    assert.equal(
      await page.getByLabel("API キー", { exact: true }).inputValue(),
      "browser-dummy-key",
    );
    await page.getByLabel("API キー", { exact: true }).fill("");
    await saveSettings(page);
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
    await page.getByRole("button", { name: "接続を削除", exact: true }).click();
    await page.getByText("接続を削除しました。", { exact: true }).waitFor();
    await page.getByRole("button", { name: "追加", exact: true }).click();
    await page.getByLabel("接続名").fill("Personal");
    await page.getByLabel("認証方式", { exact: true }).selectOption("oauth");
    // Starting authorization saves the edited connection without a separate Save click.
    await page
      .getByRole("button", { name: "Continue with ChatGPT", exact: true })
      .click();
    await page.getByRole("link", { name: "ChatGPT の認証を開く" }).waitFor();
    await page.reload();
    await page.getByRole("button", { name: "設定", exact: true }).click();
    await page.getByRole("button", { name: "モデル", exact: true }).click();
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
    await page.getByText("認証済み", { exact: true }).waitFor();
    assert.equal(await page.locator(".settings-disclosure[open]").count(), 0);
    const disclosure = page.locator(".settings-disclosure > summary").first();
    await disclosure.focus();
    await page.keyboard.press("Enter");
    assert.equal(await page.locator(".settings-disclosure[open]").count(), 1);

    await page
      .locator(".notification")
      .filter({ hasText: "ChatGPT に接続しました。" })
      .waitFor();
    const toast = await page.locator(".notification").boundingBox();
    assert.ok(toast && toast.x > 800 && toast.y > 700);
    await page.getByRole("button", { name: "通知を閉じる" }).click();
    await page.locator(".notification").waitFor({ state: "hidden" });
    assert.ok(
      (await page.getByLabel("モデル OAuth 認証情報").inputValue()).includes(
        "browser-access-secret",
      ),
    );
    assert.ok(
      (await page.getByLabel("モデル OAuth 認証情報").inputValue()).includes(
        "browser-refresh-secret",
      ),
    );
    await mkdir("test-results", { recursive: true });
    await assertDropdowns(page);
    await page.screenshot({
      path: "test-results/model-oauth-light.png",
      animations: "disabled",
    });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => {
      const nav = document.querySelector(".settings-navigation")!;
      const active = nav
        .querySelector('[aria-pressed="true"]')!
        .getBoundingClientRect();
      const bounds = nav.getBoundingClientRect();
      return active.left >= bounds.left && active.right <= bounds.right;
    });
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
    assert.equal(
      await page.getByRole("button", { name: "ChatGPT 認証を解除" }).count(),
      0,
    );
    await page.getByRole("button", { name: "接続を削除", exact: true }).click();
    await page.getByText("接続を削除しました。", { exact: true }).waitFor();
    assert.equal(f.service.management().models.length, 0);
    assert.ok(
      !JSON.stringify(f.service.settings.snapshot()).includes(
        "browser-access-secret",
      ),
    );
    await page.getByRole("button", { name: "追加", exact: true }).click();
    await page.getByLabel("接続名").fill("Personal");
    await page
      .getByLabel("API キー", { exact: true })
      .fill("browser-replaced-key");
    await saveSettings(page);
    assert.equal(f.service.management().models[0]!.model, undefined);
    await page.locator(".settings-disclosure > summary").first().click();
    assert.equal(
      await page.getByLabel("API キー", { exact: true }).isVisible(),
      false,
    );
    await page.emulateMedia({ colorScheme: "light" });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole("button", { name: "MCP", exact: true }).click();
    await page.getByRole("button", { name: "追加", exact: true }).click();
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
    await saveSettings(page);
    assert.match(
      await page.locator(".settings-disclosure > summary").last().innerText(),
      /Fixture/,
    );
    assert.equal(
      await page.getByLabel("環境変数の値 1", { exact: true }).inputValue(),
      "browser-stdio-secret",
    );
    await page
      .getByRole("button", { name: "環境変数を追加", exact: true })
      .click();
    await page.getByLabel("環境変数名 2", { exact: true }).fill("EXTRA");
    await page
      .getByLabel("環境変数の値 2", { exact: true })
      .fill("extra-value");
    await saveSettings(page);
    assert.equal(
      f.service.settings.snapshot().mcp[0]!.env!.FIXTURE_KEY,
      "browser-stdio-secret",
    );
    await page
      .getByRole("button", { name: "環境変数 2 を削除", exact: true })
      .click();
    await saveSettings(page);
    assert.equal(f.service.settings.snapshot().mcp[0]!.env!.EXTRA, undefined);
    await page.getByRole("button", { name: "テスト", exact: true }).click();
    await page.getByText("接続済み", { exact: true }).first().waitFor();
    await page.getByText("ツール（1）").click();
    await page.getByText("greet", { exact: true }).waitFor();
    await page.locator(".settings-disclosure > summary").first().click();
    assert.equal(
      await page.getByLabel("コマンド", { exact: true }).isVisible(),
      false,
    );
    await page.getByRole("button", { name: "指示・制限", exact: true }).click();
    await page
      .getByLabel("共通指示", { exact: true })
      .fill("Keep replies short.");
    await page.getByLabel("モデル呼び出し上限").fill("5");
    await saveSettings(page);
    await page
      .getByLabel("共通指示", { exact: true })
      .fill("Keep replies concise.");
    await page.getByRole("button", { name: "記憶", exact: true }).click();
    const memory = page.getByRole("region", { name: "記憶", exact: true });
    await memory.getByRole("button", { name: "追加" }).click();
    await memory.getByLabel("記憶の内容").fill("Unsubmitted memory draft");
    await saveSettings(page);
    assert.equal(f.service.management().instructions, "Keep replies concise.");
    assert.equal(
      await memory.getByLabel("記憶の内容").inputValue(),
      "Unsubmitted memory draft",
    );
    await page.getByRole("button", { name: "指示・制限", exact: true }).click();
    page.once("dialog", (dialog) => void dialog.dismiss());
    await returnToSession(page);
    await page.getByRole("button", { name: "記憶", exact: true }).click();
    assert.equal(
      await memory.getByLabel("記憶の内容").inputValue(),
      "Unsubmitted memory draft",
    );
    await memory
      .getByRole("button", { name: "キャンセル", exact: true })
      .click();
    await page.getByRole("button", { name: "指示・制限", exact: true }).click();
    await page.getByLabel("共通指示", { exact: true }).fill("Unsaved settings");
    page.once("dialog", (dialog) => void dialog.dismiss());
    await page
      .getByRole("button", { name: "新しいセッション", exact: true })
      .click();
    assert.equal(
      await page.getByLabel("共通指示", { exact: true }).inputValue(),
      "Unsaved settings",
    );
    assert.equal(
      await page
        .getByRole("button", { name: "変更を破棄", exact: true })
        .count(),
      0,
    );
    assert.equal(await page.getByText("変更なし", { exact: true }).count(), 0);
    page.once("dialog", (dialog) => void dialog.accept());
    await returnToSession(page);
    assert.equal(new URL(page.url()).searchParams.has("settings"), false);
    await page.getByRole("button", { name: "設定", exact: true }).click();
    await page.getByRole("button", { name: "指示・制限", exact: true }).click();
    await page.waitForFunction(
      () =>
        (document.querySelector("textarea") as HTMLTextAreaElement)?.value ===
        "Keep replies concise.",
    );
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
    await page
      .getByRole("button", { name: "セッション一覧を開く", exact: true })
      .click();
    await page.locator(".sidebar-close").click();
    assert.equal(
      await page
        .getByRole("heading", { name: "指示・制限", exact: true })
        .isVisible(),
      true,
    );
    const mcp = f.service.management().mcp[0]!;
    f.faux.setResponses([
      call(mcpToolName(mcp.id, "greet"), { name: "Browser" }),
      call("write", { path: "outputs/browser.txt", content: "verified" }),
      answer("完了しました"),
    ]);
    await returnToSession(page);
    await page
      .getByRole("button", { name: "セッションのモデル", exact: true })
      .click();
    const search = page.getByRole("searchbox", { name: "モデルを検索" });
    await page
      .getByRole("button", { name: "gpt-4.1-mini", exact: true })
      .waitFor();
    assert.equal(
      await page.locator(".model-option").count(),
      2,
      "only this connection's published models appear",
    );
    await search.fill("no-matching-model");
    await page.getByText("一致するモデルがありません").waitFor();
    await search.fill("gpt-4.1");
    await page.screenshot({
      path: "test-results/model-picker-mobile-dark.png",
    });
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "gpt-4.1", exact: true })
      .click();
    await page.locator("#message").fill("MCP とファイルを使って");
    await page.locator("#send").click();
    await until(async () => (await f.service.list())[0]?.status === "idle");
    await page.getByText("完了しました", { exact: true }).waitFor();
    const picker = page.getByRole("button", {
      name: "セッションのモデル",
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
      async () => (await f.service.list())[0]?.model === "gpt-4.1-mini",
    );
    assert.equal(
      (await f.service.list())[0]?.modelConfigId,
      f.service.management().models[0]!.id,
    );
    await page.screenshot({
      path: "test-results/conversation-model-mobile-dark.png",
    });

    await page.reload();
    await page.locator("#app").waitFor();
    await page.getByRole("button", { name: "セッション一覧を開く" }).click();
    await page.locator(".conversation-item").first().click();
    await page
      .getByRole("button", { name: "セッションのモデル", exact: true })
      .filter({ hasText: "gpt-4.1-mini" })
      .waitFor();
    await page.getByText("完了しました", { exact: true }).waitFor();

    assert.equal(f.service.management().instructions, "Keep replies concise.");
    assert.equal(f.service.management().pending, false);
    assert.deepEqual(errors, []);
  } catch (error) {
    await mkdir("test-results", { recursive: true });
    await page.screenshot({ path: "test-results/settings-failure.png" });
    console.error("Browser errors:", errors);
    throw error;
  } finally {
    await browser.close();
    await server.close();
    await f.service.close();
  }
});
