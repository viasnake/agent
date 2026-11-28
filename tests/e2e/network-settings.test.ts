import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import type { DestinationSettings } from "../../src/destinations.js";
import { createServer } from "../../src/server.js";
import { fixture } from "../support.js";

const example = { name: "自宅サーバー", ip: "10.10.20.62", port: 22 };

test("network settings add, edit and delete a TCP destination, and expose stale saves", async () => {
  const f = await fixture([]);
  const web = resolve("dist/web") + "/";
  const port = 3765;
  const origin = `http://127.0.0.1:${port}`;
  f.config.server.origins = [origin];
  const app = await createServer(f.service, web);
  await app.listen({ host: "127.0.0.1", port });
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    const headers = { host: `127.0.0.1:${port}`, origin };
    assert.equal(
      (
        await app.inject({
          method: "PUT",
          url: "/api/settings/network",
          headers,
          payload: {},
        })
      ).statusCode,
      401,
    );
    const session = await app.inject({
      method: "GET",
      url: "/api/session",
      headers,
    });
    const cookies = { agent_session: session.cookies[0]!.value };
    assert.equal(
      (
        await app.inject({
          method: "PUT",
          url: "/api/settings/network",
          headers,
          cookies,
          payload: {},
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: "PUT",
          url: "/api/settings/network",
          headers: { ...headers, "x-csrf-token": session.json().csrf },
          cookies,
          payload: {
            revision: "a".repeat(64),
            entries: [{ ...example, ip: "10.10.20.0/24" }],
          },
        })
      ).statusCode,
      400,
    );

    let state: DestinationSettings = {
      status: "ok",
      entries: [],
      applied: true,
      revision: "a".repeat(64),
    };
    let conflict = false;
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
      colorScheme: "light",
    });
    await page.route("**/api/settings/network", async (route) => {
      if (route.request().method() === "PUT") {
        const update = route.request().postDataJSON();
        assert.equal(update.revision, state.revision);
        if (conflict) {
          await route.fulfill({
            status: 409,
            json: { error: "別の画面で変更されました。再読み込みしてください" },
          });
          return;
        }
        state = {
          ...state,
          entries: update.entries,
          revision:
            state.revision === "a".repeat(64) ? "b".repeat(64) : "a".repeat(64),
        };
      }
      await route.fulfill({ json: state });
    });
    await page.goto(origin + "/?new");
    await page.getByRole("button", { name: "設定", exact: true }).click();
    await page
      .getByRole("button", { name: "ネットワーク", exact: true })
      .click();
    await page.getByText("接続先はまだ登録されていません").waitFor();
    await page.getByRole("button", { name: /接続先を追加/ }).click();
    await page.getByLabel("名前（任意）").fill(example.name);
    await page.getByLabel("IPv4 アドレス").fill(example.ip);
    await page.getByRole("button", { name: "Git", exact: true }).click();
    await page.getByRole("button", { name: "ネットワーク" }).click();
    assert.equal(
      await page.getByLabel("IPv4 アドレス").inputValue(),
      example.ip,
    );
    await page
      .getByRole("form", { name: "接続先を追加" })
      .getByRole("button", { name: "保存", exact: true })
      .click();
    await page.getByText("適用済み（接続は未確認）").waitFor();
    assert.deepEqual(state.entries, [example]);
    await mkdir("test-results", { recursive: true });
    await page.screenshot({
      path: "test-results/network-desktop.png",
      animations: "disabled",
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.getByRole("button", { name: /編集 10\.10\.20\.62:22/ }).click();
    await page.getByLabel("TCP ポート").selectOption("custom");
    await page.getByLabel("ポート番号").fill("8022");
    await page.screenshot({
      path: "test-results/network-mobile.png",
      animations: "disabled",
    });
    conflict = true;
    await page
      .getByRole("form", { name: "接続先を編集" })
      .getByRole("button", { name: "保存", exact: true })
      .click();
    await page
      .getByRole("alert")
      .filter({ hasText: "別の画面で変更されました" })
      .waitFor();
    assert.equal(await page.getByLabel("ポート番号").inputValue(), "8022");
    conflict = false;
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "再読み込み", exact: true }).click();
    await page.getByRole("button", { name: /編集 10\.10\.20\.62:22/ }).click();
    await page.getByLabel("TCP ポート").selectOption("443");
    await page
      .getByRole("form", { name: "接続先を編集" })
      .getByRole("button", { name: "保存", exact: true })
      .click();
    await page.getByText("10.10.20.62 · TCP 443（HTTPS）").waitFor();
    assert.deepEqual(state.entries, [{ ...example, port: 443 }]);
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: /削除 10\.10\.20\.62:443/ }).click();
    await page.getByText("接続先はまだ登録されていません").waitFor();
    assert.deepEqual(state.entries, []);
  } finally {
    await browser.close();
    await app.close();
    await f.service.close();
  }
});
