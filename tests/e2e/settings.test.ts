import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { fixture, call, answer, until } from "../support.js";
import { createServer } from "../../src/server.js";
import { mcpToolName } from "../../src/tools.js";
test("Web management saves models, stdio MCP, limits and retains a usable mobile/light/dark conversation", async () => {
  const f = await fixture(),
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
    await page.getByLabel("モデル ID", { exact: true }).fill("gpt-4.1");
    await page
      .getByLabel("API キー", { exact: true })
      .fill("browser-dummy-key");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page
      .getByText("保存しました。次の実行開始時に反映します。")
      .waitFor();
    assert.equal(
      await page.getByLabel("API キー", { exact: true }).inputValue(),
      "",
    );
    await page.getByRole("button", { name: "MCP", exact: true }).click();
    await page.getByRole("button", { name: "MCP を追加", exact: true }).click();
    await page.getByLabel("名前", { exact: true }).fill("Fixture");
    await page.getByLabel("コマンド（絶対パス）").fill(process.execPath);
    await page
      .getByLabel("引数（1行に1つ）")
      .fill(resolve(".test-dist/tests/mcp-server.js"));
    await page
      .getByLabel("環境変数（JSON・全置換）")
      .fill('{"FIXTURE_KEY":"browser-stdio-secret"}');
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page
      .getByText("保存しました。次の実行開始時に反映します。")
      .waitFor();
    await page.getByRole("button", { name: "接続テスト", exact: true }).click();
    await page.getByText("接続済み", { exact: true }).waitFor();
    await page.getByText("公開ツール（1）").click();
    await page.getByText("greet", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Agent 設定", exact: true }).click();
    await page
      .getByLabel("共通指示", { exact: true })
      .fill("Keep replies short.");
    await page.getByLabel("モデル呼び出し上限").fill("5");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page
      .getByText("保存しました。次の実行開始時に反映します。")
      .waitFor();
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
    await page.locator("#message").fill("MCP とファイルを使って");
    await page.locator("#send").click();
    await until(async () => (await f.service.list())[0]?.status === "idle");
    await page.getByText("完了しました", { exact: true }).waitFor();
    await page.reload();
    await page.locator("#app").waitFor();
    assert.equal(f.service.management().instructions, "Keep replies short.");
    assert.equal(f.service.management().pending, false);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await server.close();
    await f.service.close();
  }
});
