import { returnToSession } from "./navigation.js";
import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { fixture, call, answer, until } from "../support.js";
import { createServer } from "../../src/server.js";

test("browser displays credentials and shares them with every session in light and dark themes", async () => {
  const f = await fixture([
    call("bash", { command: 'test -n "$GH_TOKEN" && echo configured' }),
    answer("完了"),
  ]);
  const probe = await createServer(f.service);
  const origin = await probe.listen({ host: "127.0.0.1", port: 0 });
  await probe.close();
  f.config.server.origins = [origin];
  const app = await createServer(f.service, resolve("dist/web") + "/");
  await app.listen({ host: "127.0.0.1", port: Number(new URL(origin).port) });
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({
    viewport: { width: 1100, height: 850 },
    colorScheme: "light",
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  async function save() {
    const dismiss = page.getByRole("button", { name: "通知を閉じる" });
    if (await dismiss.isVisible()) await dismiss.click();
    const response = page.waitForResponse(
      (r) =>
        r.request().method() === "PUT" &&
        new URL(r.url()).pathname === "/api/settings",
    );
    await page.getByRole("button", { name: "設定を保存", exact: true }).click();
    assert.equal((await response).status(), 200);
    await page
      .locator(".notification")
      .filter({ hasText: "保存しました。" })
      .waitFor();
  }
  try {
    await page.goto(origin + "/?new");
    await page.getByRole("button", { name: "設定", exact: true }).click();
    await page
      .getByRole("button", { name: "クレデンシャル", exact: true })
      .click();
    await page.getByRole("button", { name: "環境変数を登録" }).click();
    await page.getByLabel("名前", { exact: true }).fill("Git CLI");
    await page.getByRole("button", { name: "環境変数を追加" }).click();
    await page.getByLabel("環境変数名 1", { exact: true }).fill("GH_TOKEN");
    await page
      .getByLabel("環境変数の値 1", { exact: true })
      .fill("browser-private-pat");
    await save();
    assert.equal(
      await page.getByLabel("環境変数の値 1", { exact: true }).inputValue(),
      "browser-private-pat",
    );
    assert.equal(
      await page
        .getByLabel("環境変数の値 1", { exact: true })
        .getAttribute("type"),
      "text",
    );
    await page.getByLabel("名前", { exact: true }).fill("Git PAT");
    await save();
    const credential = f.service.settings.snapshot().workCredentials[0]!;
    assert.equal(credential.kind, "env");
    if (credential.kind === "env")
      assert.equal(credential.env.GH_TOKEN, "browser-private-pat");
    await page.getByRole("button", { name: "モデル", exact: true }).click();
    await page
      .getByRole("button", { name: "クレデンシャル", exact: true })
      .click();
    assert.equal(
      await page.getByLabel("環境変数の値 1", { exact: true }).isVisible(),
      true,
    );
    assert.equal(
      await page.getByLabel("環境変数の値 1", { exact: true }).inputValue(),
      "browser-private-pat",
    );
    const keyPath = join(f.root, "browser-key");
    execFileSync("/usr/bin/ssh-keygen", [
      "-q",
      "-t",
      "ed25519",
      "-N",
      "",
      "-f",
      keyPath,
    ]);
    await page
      .getByRole("button", { name: "SSH 鍵を登録", exact: true })
      .click();
    const sshCard = page
      .locator("details")
      .filter({ has: page.getByLabel("鍵ファイル", { exact: true }) });
    await sshCard.getByLabel("名前", { exact: true }).fill("Git SSH");
    await sshCard
      .getByLabel("鍵ファイル", { exact: true })
      .setInputFiles(keyPath);
    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll("textarea")).some((e) =>
        e.value.includes("BEGIN OPENSSH PRIVATE KEY"),
      ),
    );
    await save();
    assert.match(
      await sshCard
        .getByLabel("秘密鍵（パスフレーズなし）", { exact: true })
        .inputValue(),
      /BEGIN OPENSSH PRIVATE KEY/,
    );
    assert.match(
      await sshCard.getByLabel("公開鍵", { exact: true }).inputValue(),
      /^ssh-ed25519 /,
    );
    await page
      .getByRole("button", { name: "SSH 鍵を登録", exact: true })
      .click();
    const generatedCard = page.locator("details").filter({
      has: page.getByRole("checkbox", {
        name: "新しい鍵を生成",
        exact: true,
      }),
    });
    await generatedCard
      .getByLabel("名前", { exact: true })
      .fill("Generated SSH");
    await page
      .getByRole("checkbox", { name: "新しい鍵を生成", exact: true })
      .check();
    await save();
    const generated = f.service
      .management()
      .workCredentials.find((c) => c.name === "Generated SSH");
    assert.equal(generated?.kind, "ssh");
    if (generated?.kind === "ssh")
      assert.match(generated.publicKey, /^ssh-ed25519 /);
    await mkdir("test-results", { recursive: true });
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await page.screenshot({
        path: `test-results/credentials-${colorScheme}.png`,
      });
    }
    await returnToSession(page);
    assert.equal(
      await page
        .getByRole("button", { name: "スレッドのクレデンシャル" })
        .count(),
      0,
    );
    await page
      .getByRole("textbox", { name: "メッセージ", exact: true })
      .fill("確認してください");
    await page.getByRole("button", { name: "送る", exact: true }).click();
    await page
      .locator(".assistant-message[data-entry-id] .markdown")
      .getByText("完了", { exact: true })
      .waitFor();
    await until(
      async () =>
        (await f.service.list()).length === 1 &&
        (await f.service.list())[0]!.status === "idle",
    );
    assert.ok(!("credentialIds" in (await f.service.list())[0]!));
    assert.match(
      JSON.stringify(await f.service.view((await f.service.list())[0]!.id)),
      /configured/,
    );
    await page.reload();
    // Select the saved session after a full browser reload.
    await page
      .getByRole("button", { name: /確認してください/ })
      .first()
      .click();
    assert.equal(
      await page
        .getByRole("button", { name: "スレッドのクレデンシャル" })
        .count(),
      0,
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: "test-results/credentials-mobile.png" });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await app.close();
    await f.service.close();
  }
});
