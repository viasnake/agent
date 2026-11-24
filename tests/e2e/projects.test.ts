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
  const complete = await f.service.create(
    randomUUID(),
    "障害後の問い合わせ案内",
    undefined,
    undefined,
    true,
  );
  f.faux.setResponses([
    call("project_report", {
      revision: 1,
      stage: "delivered",
      summary: "問い合わせ窓口と必要な情報を一枚にまとめました。",
      deliverable:
        "### お問い合わせの際に\n請求番号と発行日を添えて、サポート窓口までお知らせください。",
      evidence: "案内に必要な二項目を依頼文と照合",
    }),
    answer(
      '{"verdict":"accept","reason":"請求番号と発行日の記載を確認","quotes":["請求番号と発行日を添えて"]}',
    ),
    answer("納品しました"),
  ]);
  await f.service.send(
    complete.id,
    randomUUID(),
    "請求番号と発行日を添えて問い合わせるよう案内文を書いて",
  );
  await until(async () =>
    (await f.service.projects()).some(
      (p) => p.id === complete.id && p.status === "delivered",
    ),
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
      nextStep: "一覧が更新されるタイミングを再現テストで確かめます。",
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
    await page.getByRole("button", { name: "仕事のホーム" }).waitFor();
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
    await dash
      .getByText("一覧が更新されるタイミングを再現テストで確かめます。", {
        exact: false,
      })
      .first()
      .waitFor();
    await dash.getByText("納品本文を読む", { exact: true }).click();
    await dash.getByRole("heading", { name: "お問い合わせの際に" }).waitFor();
    assert.match(
      await dash.locator(".delivered-proof").innerText(),
      /依頼 · 請求番号と発行日を添えて/,
    );
    await dash.getByRole("button", { name: "報告フィード" }).click();
    await dash.locator(".recent-posts .post-question").waitFor();
    await dash.locator(".recent-posts .post-start").first().waitFor();
    await dash
      .getByRole("button", { name: "仕事のホーム", exact: true })
      .click();
    for (const width of [1320, 390]) {
      await page.setViewportSize({ width, height: 900 });
      assert.ok(
        await dash.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
      );
    }
    await page.setViewportSize({ width: 1320, height: 900 });
    release();
    await until(
      async () =>
        (await f.service.projects()).filter((p) => p.status === "delivered")
          .length === 2,
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
    await dash.getByRole("button", { name: "自分の言葉で回答" }).click();
    await dash
      .getByRole("textbox", { name: "判断依頼への回答" })
      .fill("既存ユーザーのうち試用中の方に先行案内してください");
    await dash.getByRole("button", { name: "回答して再開" }).click();
    await until(async () =>
      (await f.service.projects()).every((p) => p.status === "delivered"),
    );
    await dash.getByRole("button", { name: "案件一覧" }).click();
    await page.getByRole("button", { name: /完了報告 3/ }).click();
    await dash
      .getByRole("button", { name: "次回リリースの告知を準備", exact: true })
      .click();
    await page
      .locator("#title")
      .getByText("次回リリースの告知を準備", { exact: true })
      .waitFor();
    const stream = page.getByLabel("案件のタイムライン");
    await stream
      .getByText("既存ユーザー向けの案内が完成しました。", { exact: true })
      .waitFor();
    assert.equal(new URL(page.url()).searchParams.get("project"), first.id);
    await page.reload();
    await stream
      .getByText("回答：既存ユーザーのうち試用中の方に先行案内してください", {
        exact: true,
      })
      .waitFor();
    assert.equal((await f.service.view(first.id)).project?.revision, 1);
    assert.equal(
      await stream.locator(".post-question .post-choices button").count(),
      0,
    );
    await page.getByRole("tab", { name: "会話", exact: true }).click();
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

test("project timeline retains the reader's place, accepts a decision inline and replays the same posts", async () => {
  const f = await fixture();
  const { id } = await f.service.create(
    randomUUID(),
    "請求書の二重発行を調査",
    undefined,
    undefined,
    true,
  );
  let release!: () => void,
    started = 0;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const specialist: FauxResponseFactory = async (c) => {
    const { role, history } = JSON.parse(String(c.messages.at(-1)!.content));
    started++;
    await gate;
    if (role === "実装担当" && !history.length)
      return fauxAssistantMessage(
        JSON.stringify({
          action: "progress",
          summary: "再送時に同じ請求番号が二度保存される条件を特定しました。",
        }),
      );
    return fauxAssistantMessage(
      JSON.stringify({
        action: "report",
        summary:
          role === "実装担当"
            ? "請求番号を使い、再送しても一件だけ保存する修正案をまとめました。"
            : "連続送信と再試行を再現手順にまとめました。",
      }),
    );
  };
  f.faux.setResponses([
    ...Array.from({ length: 26 }, (_, i) =>
      call("project_report", {
        revision: 1,
        stage: "working",
        summary: `調査対象の帳票を照合しました（${i + 1} 件）。`,
      }),
    ),
    call("project_team", {
      revision: 1,
      assignments: [
        { role: "実装担当", task: "再送時の保存処理を調査します。" },
        { role: "検証担当", task: "二重発行の再現手順を確認します。" },
      ],
    }),
    specialist,
    specialist,
    specialist,
    call("project_report", {
      revision: 1,
      stage: "working",
      summary:
        "修正案と再現手順が揃いました。既存データの扱いだけ決定が必要です。",
    }),
    call("request_user_input", {
      question: "既に発行した重複分はどう扱いますか？",
      options: ["確認用に一覧を作る", "新規分のみ対応する"],
    }),
  ]);
  const origin = "http://127.0.0.1:3886";
  f.config.server.origins = [origin];
  const app = await createServer(f.service, resolve("dist/web") + "/");
  await app.listen({ host: "127.0.0.1", port: 3886 });
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    await f.service.send(
      id,
      randomUUID(),
      "請求書が二重に発行される原因を調べ、修正案と再現手順を報告してください。",
    );
    await until(async () => started === 2);
    const page = await browser.newPage({
      viewport: { width: 1320, height: 900 },
      colorScheme: "light",
    });
    await page.goto(origin);
    await page.locator(`[data-session-id="${id}"] .conversation-item`).click();
    const stream = page.getByLabel("案件のタイムライン");
    await stream.locator(".post-start").first().waitFor();
    assert.equal(
      await page
        .getByRole("tab", { name: "タイムライン" })
        .getAttribute("aria-selected"),
      "true",
    );
    await stream.evaluate((el) => (el.scrollTop = 0));
    await stream.getByRole("button", { name: "以前の投稿を読む" }).click();
    await stream.locator(".post-directive").waitFor({ state: "attached" });
    const before = await stream.evaluate((el) => el.scrollTop);
    assert.ok(before > 0);
    await page.locator("#message").fill("請求番号の範囲も確認してください");
    release();
    const jump = page.getByRole("button", { name: "新しい報告へ" });
    await jump.waitFor();
    await until(
      async () => (await f.service.projects())[0]?.status === "decision",
    );
    assert.ok(
      Math.abs((await stream.evaluate((el) => el.scrollTop)) - before) < 5,
    );
    await jump.click();
    const decide = stream.getByRole("button", {
      name: "確認用に一覧を作る",
      exact: true,
    });
    await decide.waitFor();
    await page
      .locator("#state")
      .getByText("判断待ち", { exact: true })
      .waitFor();
    for (const width of [390, 1320]) {
      await page.setViewportSize({ width, height: 900 });
      assert.ok(
        await stream.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
      );
    }
    await page.getByRole("tab", { name: "会話", exact: true }).click();
    await page.getByRole("tab", { name: "タイムライン" }).click();
    assert.equal(
      await page.locator("#message").inputValue(),
      "請求番号の範囲も確認してください",
    );
    f.faux.setResponses([
      call("project_report", {
        revision: 1,
        stage: "delivered",
        summary: "確認対象の一覧と、再送時の修正案をまとめました。",
        evidence: "依頼、担当の報告、公開範囲の回答を照合",
      }),
      answer('{"verdict":"accept","reason":"元の依頼と修正方針が一致"}'),
      answer("報告を提出しました"),
    ]);
    await decide.click();
    await stream.locator(".post-delivery").waitFor();
    assert.equal(await stream.locator(".post-decision").count(), 1);
    await page.reload();
    await page.locator(`[data-session-id="${id}"] .conversation-item`).click();
    await stream.locator(".post-delivery").waitFor();
    await page
      .locator("#state")
      .getByText("完了報告", { exact: true })
      .waitFor();
    assert.equal(await stream.locator(".post-decision").count(), 1);
    assert.equal(
      await stream
        .getByRole("button", { name: "確認用に一覧を作る", exact: true })
        .count(),
      0,
    );
  } finally {
    release();
    await browser.close();
    await app.close();
    await f.service.close();
  }
});
