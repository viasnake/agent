import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { chromium } from "playwright";
import {
  fauxAssistantMessage,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import { createServer } from "../../src/server.js";
import { fixture, call, answer, until } from "../support.js";

test("one directive starts a project; the portfolio shows independent teams and resumes a decision without opening its thread", async () => {
  const f = await fixture();
  const first = await f.service.create(
    randomUUID(),
    "次回リリースの告知を準備",
    undefined,
    undefined,
    true,
  );
  const report = (s: string) =>
    answer(JSON.stringify({ action: "report", summary: s }));
  f.faux.setResponses([
    call("project_team", {
      revision: 1,
      assignments: [
        { role: "編集", task: "告知の初稿を書く" },
        { role: "校閲", task: "公開条件を確認する" },
      ],
    }),
    report("告知本文の初稿をまとめました。"),
    report("告知の対象と公開範囲を確認しました。"),
    call("project_report", {
      revision: 1,
      stage: "working",
      summary: "初稿と校閲が完了しました。公開範囲の決定後に仕上げます。",
    }),
    call("request_user_input", {
      question: "先行案内はどの利用者に届けますか？",
      options: ["既存ユーザーのみ", "全ユーザー"],
    }),
  ]);
  await f.service.send(
    first.id,
    randomUUID(),
    "公開範囲の選択肢も用意してください",
  );
  await until(
    async () => (await f.service.projects())[0]?.status === "decision",
  );
  let release!: () => void,
    started = 0;
  const gate = new Promise<void>((r) => (release = r));
  const role: FauxResponseFactory = async () => {
    started++;
    await gate;
    return fauxAssistantMessage(
      JSON.stringify({
        action: "report",
        summary: "確認結果を責任者に提出しました。",
      }),
    );
  };
  f.faux.setResponses([
    call("project_report", {
      revision: 1,
      stage: "working",
      summary: "原因調査と回帰テストの設計を並行して進めています。",
    }),
    call("project_team", {
      revision: 1,
      assignments: [
        { role: "原因調査", task: "一覧の表示処理を調べる" },
        { role: "テスト設計", task: "再現条件を整理する" },
      ],
    }),
    role,
    role,
    call("project_report", {
      revision: 1,
      stage: "delivered",
      summary: "調査結果と再現手順をまとめました。",
      evidence: "両担当の調査報告を照合",
    }),
    answer('{"verdict":"accept","reason":"記録と一致"}'),
    answer("調査を完了しました。"),
  ]);
  const origin = "http://127.0.0.1:3884";
  f.config.server.origins = [origin];
  const app = await createServer(f.service, resolve("dist/web") + "/");
  await app.listen({ host: "127.0.0.1", port: 3884 });
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage({
      viewport: { width: 1320, height: 900 },
      colorScheme: "light",
    });
    await page.goto(origin);
    await page
      .getByRole("button", { name: "プロジェクト", exact: true })
      .click();
    await page.getByRole("button", { name: "新しい依頼" }).click();
    await page
      .getByRole("heading", { name: "チームに何を依頼しますか？" })
      .waitFor();
    await page
      .locator("#message")
      .fill("保存したパッチが一覧に出ない原因を調べて");
    await page.locator("#send").click();
    await until(async () => started === 2);
    await page
      .getByRole("button", { name: "プロジェクト", exact: true })
      .click();
    await page
      .getByText("原因調査と回帰テストの設計を並行して進めています。", {
        exact: true,
      })
      .first()
      .waitFor();
    await page
      .getByRole("button", { name: "全ユーザー", exact: true })
      .waitFor();
    const dash = page.locator(".project-dashboard");
    for (const width of [1320, 390]) {
      await page.setViewportSize({ width, height: 900 });
      assert.ok(
        await dash.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
      );
    }
    await page.setViewportSize({ width: 1320, height: 900 });
    release();
    await until(async () =>
      (await f.service.projects()).some((p) => p.status === "delivered"),
    );
    f.faux.setResponses([
      call("project_report", {
        revision: 1,
        stage: "delivered",
        summary: "既存ユーザー向けの案内が完成しました。",
        evidence: "初稿と校閲結果に公開範囲を反映",
      }),
      answer('{"verdict":"accept","reason":"記録と一致"}'),
      answer("案内の準備ができました。"),
    ]);
    await page
      .getByRole("button", { name: "既存ユーザーのみ", exact: true })
      .click();
    await until(async () =>
      (await f.service.projects()).every((p) => p.status === "delivered"),
    );
    await page.getByRole("button", { name: /完了報告 2/ }).click();
    await dash
      .getByRole("button", { name: "次回リリースの告知を準備", exact: true })
      .click();
    await page
      .locator("#title")
      .getByText("次回リリースの告知を準備", { exact: true })
      .waitFor();
    await page.getByText("担当と進捗", { exact: false }).last().click();
    await page
      .getByText("告知本文の初稿をまとめました。", { exact: true })
      .last()
      .waitFor();
  } finally {
    release();
    await browser.close();
    await app.close();
    await f.service.close();
  }
});
