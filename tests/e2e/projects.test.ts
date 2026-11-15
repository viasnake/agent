import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve, join } from "node:path";
import { mkdir, rm, readFile } from "node:fs/promises";
import { createServer as portProbe } from "node:net";
import { chromium } from "playwright";
import { fixture, answer, until } from "../support.js";
import { repositoryFixture } from "../projects-fixture.js";
import { createServer } from "../../src/server.js";

test("project editor, selection, fetch and preserved drafts work in light/dark and narrow layouts", async () => {
  const r = await repositoryFixture();
  const f = await fixture([answer("プロジェクト準備済み")], {
    root: r.root,
    runner: r.runner,
  });
  const old = await f.service.create(randomUUID(), "従来のセッション");
  const probe = portProbe();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const address = probe.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((done) => probe.close(() => done()));
  const origin = `http://127.0.0.1:${port}`;
  f.config.server.origins = [origin];
  const app = await createServer(f.service, resolve("dist/web") + "/");
  await app.listen({ host: "127.0.0.1", port });
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.goto(origin);
    await page.locator("#message").fill("準備して");
    await page.getByRole("button", { name: "設定", exact: true }).click();
    await page
      .getByRole("button", { name: "プロジェクト", exact: true })
      .click();
    await page.getByLabel("プロジェクト名", { exact: true }).fill("横断作業");
    await page.getByLabel("リポジトリ 1", { exact: true }).fill("example/one");
    await page
      .getByRole("button", { name: "リポジトリを追加", exact: true })
      .click();
    await page.getByLabel("リポジトリ 2", { exact: true }).fill("example/two");
    await page.getByRole("button", { name: "Agent 設定", exact: true }).click();
    await page
      .getByRole("button", { name: "プロジェクト", exact: true })
      .click();
    assert.equal(
      await page.getByLabel("リポジトリ 2", { exact: true }).inputValue(),
      "example/two",
    );
    await page
      .getByRole("button", { name: "プロジェクトを保存", exact: true })
      .click();
    await page
      .getByText("プロジェクトを保存しました", { exact: true })
      .waitFor();
    assert.deepEqual(r.runner.calls, []);
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await page.setViewportSize({
        width: colorScheme === "dark" ? 390 : 1280,
        height: 900,
      });
      await mkdir("test-results", { recursive: true });
      await page.screenshot({
        path: `test-results/projects-${colorScheme}.png`,
      });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
      );
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page
      .getByRole("button", { name: "セッションに戻る", exact: true })
      .click();
    assert.equal(await page.locator("#message").inputValue(), "準備して");
    const project = (await f.service.projects())[0]!;
    await page
      .getByLabel("プロジェクト", { exact: true })
      .selectOption(project.id);
    await page.locator("#message").press("Control+Enter");
    await page.getByText("プロジェクト準備済み", { exact: true }).waitFor();
    const session = (await f.service.list()).find((s) => s.project)!;
    assert.equal(session.project!.repositories.length, 2);
    await page.locator(".project-summary summary").click();
    await page
      .getByText("github.com/example/one", { exact: false })
      .first()
      .waitFor();
    await page.locator("#message").fill("未送信の下書き");
    let release!: () => void;
    r.runner.block = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    await page.getByRole("button", { name: "取得更新", exact: true }).click();
    await until(async () => !!release);
    assert.equal(
      await page
        .getByRole("button", { name: "取得中", exact: true })
        .isDisabled(),
      true,
    );
    await page
      .locator(`[data-session-id="${old.id}"] .conversation-item`)
      .click();
    assert.equal(await page.locator("#message").inputValue(), "");
    r.runner.block = undefined;
    release();
    await until(
      async () => (await f.service.conversation(session.id)).status === "idle",
    );
    await page
      .locator(`[data-session-id="${session.id}"] .conversation-item`)
      .click();
    assert.equal(await page.locator("#message").inputValue(), "未送信の下書き");
    await page.getByRole("button", { name: "設定", exact: true }).click();
    await page
      .getByRole("button", { name: "プロジェクト", exact: true })
      .click();
    await page.getByRole("button", { name: "横断作業", exact: true }).click();
    await page.getByLabel("プロジェクト名", { exact: true }).fill("変更後");
    await page
      .getByRole("button", { name: "リポジトリ 2 を削除", exact: true })
      .click();
    await page
      .getByRole("button", { name: "プロジェクトを保存", exact: true })
      .click();
    await page
      .getByText("プロジェクトを保存しました", { exact: true })
      .waitFor();
    assert.equal(
      (await f.service.conversation(session.id)).project!.name,
      "横断作業",
    );
    assert.equal(
      (await f.service.conversation(session.id)).project!.repositories.length,
      2,
    );
    await page.locator(".projects-content summary").click();
    page.once("dialog", (dialog) => void dialog.accept());
    await page
      .getByRole("button", { name: "プロジェクトを削除", exact: true })
      .click();
    await page
      .getByText("プロジェクトを削除しました", { exact: true })
      .waitFor();
    assert.equal((await f.service.projects()).length, 0);
    assert.equal(
      await readFile(
        join(r.work, "conversations", session.id, "repos/example/one/code.txt"),
        "utf8",
      ),
      "shared needle one\n",
    );
    await page
      .getByRole("button", { name: "セッションに戻る", exact: true })
      .click();
    assert.equal(await page.locator("#message").inputValue(), "未送信の下書き");
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await app.close();
    await f.service.close();
    await rm(r.root, { recursive: true, force: true });
  }
});
