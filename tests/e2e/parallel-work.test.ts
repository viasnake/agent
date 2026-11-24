import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  fauxAssistantMessage,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import { createServer } from "../../src/server.js";
import { workFixture } from "../parallel-work-fixture.js";
import { call, answer, until } from "../support.js";

test("pause, resume, review a failed diff, repair one file and export the checked bytes from the work card", async () => {
  const f = await workFixture();
  // A long diagnostic should scroll inside the log, not widen the chat.
  f.plan.check = `if ! (${f.plan.check}); then echo '${"diagnostic".repeat(30)}'; exit 1; fi`;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let started = 0;
  const generate: FauxResponseFactory = async (context) => {
    const { assignment } = JSON.parse(String(context.messages.at(-1)!.content));
    started++;
    await gate;
    return fauxAssistantMessage(
      JSON.stringify({
        content: assignment.path === "app.txt" ? "wrong\n" : "new\n",
      }),
    );
  };
  f.faux.setResponses([
    call("parallel_work", f.plan),
    generate,
    generate,
    answer("担当の変更を保存しました"),
  ]);
  const origin = "http://127.0.0.1:3797";
  f.config.server.origins = [origin];
  const app = await createServer(f.service, resolve("dist/web") + "/");
  await app.listen({ host: "127.0.0.1", port: 3797 });
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage({ colorScheme: "dark" });
    await page.goto(origin);
    await page
      .locator(`[data-session-id="${f.id}"] .conversation-item`)
      .click();
    await page.locator("#message").fill("値と文書を並列更新してください");
    await page.locator("#send").click();
    const card = page.getByRole("region", { name: "並列作業" });
    await until(async () => started === 2);
    await card.getByRole("button", { name: "一時停止", exact: true }).click();
    await card.getByText("一時停止待ち", { exact: true }).waitFor();
    release();
    await card.getByRole("button", { name: "再開" }).click();
    await card.getByRole("button", { name: "同じ差分を再検証" }).waitFor();
    await card.getByText("検証内容", { exact: true }).click();
    const transcript = page.locator("#transcript");
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      assert.ok(
        await transcript.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
        "Check output overflowed the conversation at " + width,
      );
      const title = await card.locator("strong").boundingBox();
      assert.ok(
        title && title.width > 200,
        "Work title was squeezed by check output",
      );
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await card.getByText("検証内容", { exact: true }).click();
    await card.getByText("差分を確認", { exact: true }).click();
    await card.getByText("+wrong", { exact: true }).waitFor();
    await card.getByText("担当に修正を依頼", { exact: true }).click();
    await card.getByLabel("修正対象").selectOption("app.txt");
    await card.getByLabel("修正指示").fill("Use new for the value");
    f.faux.setResponses([answer('{"content":"new\\n"}')]);
    await card.getByRole("button", { name: "この担当を再実行" }).click();
    const link = card.getByRole("link", { name: "検証済みの差分を保存" });
    await link.waitFor();
    await card.getByText("差分を確認", { exact: true }).click();
    const diff = card
      .locator("details")
      .filter({ has: page.getByText("差分を確認", { exact: true }) });
    await diff
      .getByText("diff --git a/app.txt b/app.txt", { exact: true })
      .waitFor();
    await diff
      .getByText("diff --git a/README.md b/README.md", { exact: true })
      .waitFor();
    assert.equal(await diff.getByText("+new", { exact: true }).count(), 2);
    assert.match(await card.innerText(), /以前の差分（.*失敗/);
    await card.getByRole("button", { name: "作業フォルダに保存" }).click();
    const exported = await card.locator('code[role="status"]').textContent();
    assert.ok(exported?.startsWith("outputs/parallel-"));
    await card.getByText("検証内容", { exact: true }).click();
    assert.match(await card.innerText(), /grep -Fx new README.md/);
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      link.click(),
    ]);
    const path = join(f.root, "delivered.patch");
    await download.saveAs(path);
    assert.match(
      await readFile(path, "utf8"),
      /diff --git a\/app.txt b\/app.txt/,
    );
    assert.deepEqual(
      await readFile(join(f.repo, "..", exported!)),
      await readFile(path),
    );
    assert.equal(started, 2);
    await page.emulateMedia({ colorScheme: "light" });
    await link.waitFor();
    await page.getByRole("tab", { name: "ファイル", exact: true }).click();
    await page.getByRole("link", { name: /changes\.patch/ }).waitFor();
  } finally {
    release();
    await browser.close();
    await app.close();
    await f.service.close();
  }
});
