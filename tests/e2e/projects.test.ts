import { mkdir } from "node:fs/promises";
import { fauxProvider } from "@earendil-works/pi-ai";
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
    await page.getByRole("button", { name: "ホーム" }).waitFor();
    await page.getByRole("button", { name: "新しいスレッド" }).click();
    await page.getByRole("heading", { name: "何を依頼しますか？" }).waitFor();
    await page
      .locator("#message")
      .fill("保存したパッチが一覧に出ない原因を調べて");
    await page.locator("#send").click();
    await until(async () => started === 2);
    await page.getByRole("button", { name: "ホーム", exact: true }).click();
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
    await mkdir("test-results", { recursive: true });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({
      path: "test-results/workspace-home.png",
      animations: "disabled",
    });
    const background = dash.getByText(
      "初稿と校閲が完了しました。公開範囲の決定後に仕上げます。",
    );
    assert.equal(await background.isVisible(), false);
    await dash.getByText("背景", { exact: true }).click();
    await background.waitFor();
    await dash.getByText("背景", { exact: true }).click();
    await dash.getByText("本文を読む", { exact: true }).click();
    await dash.getByRole("heading", { name: "お問い合わせの際に" }).waitFor();
    const proof = dash.locator(".delivered-proof");
    assert.equal(await proof.locator("p").isVisible(), false);
    await proof.locator("summary").focus();
    await page.keyboard.press("Enter");
    assert.match(
      await dash.locator(".delivered-proof").innerText(),
      /依頼 · 請求番号と発行日を添えて/,
    );
    await page
      .getByRole("navigation", { name: "ワークスペース" })
      .getByRole("button", { name: "掲示板" })
      .click();
    await page.reload();
    const board = dash.getByRole("table", { name: "スレッド一覧" });
    await board.getByRole("link", { name: "障害後の問い合わせ案内" }).waitFor();
    assert.equal(new URL(page.url()).searchParams.get("view"), "board");
    assert.equal(await board.locator("tbody tr").count(), 3);
    const times = await board
      .locator("time")
      .evaluateAll((elements) =>
        elements.map((el) => el.getAttribute("datetime")),
      );
    assert.deepEqual(times, [...times].sort().reverse());
    const pendingRow = board
      .getByRole("row")
      .filter({ hasText: "次回リリースの告知を準備" });
    const pendingView = await f.service.view(first.id);
    assert.equal(
      await pendingRow.locator(".topic-count").innerText(),
      String(pendingView.timeline!.posts.at(-1)!.id),
    );
    await dash.getByRole("button", { name: /^回答待ち 1$/ }).click();
    assert.equal(await board.locator("tbody tr").count(), 1);
    await dash.getByRole("button", { name: /^すべて 3$/ }).click();
    for (const width of [390, 1320]) {
      await page.setViewportSize({ width, height: 900 });
      assert.ok(
        await dash.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
      );
    }
    await board.getByRole("link", { name: "障害後の問い合わせ案内" }).click();
    const intro = page.getByLabel("スレッドの概要");
    await intro.getByText("本文を読む", { exact: true }).click();
    await intro.getByRole("heading", { name: "お問い合わせの際に" }).waitFor();
    await intro.getByRole("button", { name: "掲示板" }).click();
    await board.waitFor();
    await page.getByRole("button", { name: "更新履歴" }).click();
    await dash.locator(".recent-posts .post-question").waitFor();
    await dash.locator(".recent-posts .post-start").first().waitFor();
    await page.getByRole("button", { name: "ホーム", exact: true }).click();
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
    const modules = page.getByRole("navigation", { name: "ワークスペース" });
    await modules.getByRole("button", { name: "受信箱" }).click();
    await dash
      .locator(".mail-list")
      .getByRole("button", { name: /次回リリースの告知を準備/ })
      .click();
    const reader = dash.getByRole("region", { name: "報告の本文" });
    await reader
      .getByRole("group", { name: "先行案内はどの利用者に届けますか？" })
      .waitFor();
    const threadRead = async () =>
      (await f.service.workspaceOverview()).threads.find(
        (r) => r.id === first.id,
      )!;
    await until(async () => {
      const t = await threadRead();
      return t.readThrough === t.notice?.id;
    });
    assert.equal((await threadRead()).status, "decision");
    await page.screenshot({
      path: "test-results/groupware-inbox.png",
      animations: "disabled",
    });
    await dash.getByRole("button", { name: "自由回答" }).click();
    await dash
      .getByRole("textbox", { name: "質問への回答" })
      .fill("既存ユーザーのうち試用中の方に先行案内してください");
    await dash.getByRole("button", { name: "回答を送信" }).click();
    await until(async () =>
      (await f.service.projects()).every((p) => p.status === "delivered"),
    );
    await page
      .getByRole("navigation", { name: "ワークスペース" })
      .getByRole("button", { name: "掲示板" })
      .click();
    await page.getByRole("button", { name: /完了 3/ }).click();
    await dash
      .getByRole("link", { name: "次回リリースの告知を準備", exact: true })
      .click();
    await page
      .locator("#title")
      .getByText("次回リリースの告知を準備", { exact: true })
      .waitFor();
    const stream = page.getByLabel("スレッドの投稿");
    await stream
      .getByText("既存ユーザー向けの案内が完成しました。", { exact: true })
      .waitFor();
    assert.equal(new URL(page.url()).searchParams.get("thread"), first.id);
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
    await page.getByRole("tab", { name: "実行履歴", exact: true }).click();
    assert.equal(await page.locator("#message").isVisible(), false);
    await page.getByRole("button", { name: "スレッドに戻る" }).click();
    await page.getByText("担当とモデル", { exact: true }).click();
    await page
      .getByText("作業を分担し、報告をまとめて納品します。", { exact: true })
      .waitFor();
    await page
      .locator(".topic-intro .project-team-detail")
      .getByText("告知本文の初稿をまとめました。", { exact: true })
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
    const stream = page.getByLabel("スレッドの投稿");
    const request = page.locator(".topic-request");
    await request.locator("summary").click();
    await request
      .locator("p")
      .filter({ hasText: "請求書が二重に発行される原因を調べ" })
      .waitFor();
    assert.equal(await stream.locator(".post-directive").count(), 0);
    await request.locator("summary").click();
    const start = stream.locator(".start-notice").first();
    await start.locator("summary").click();
    await start.locator("p").waitFor();
    await start.locator("summary").click();
    assert.equal(
      await page
        .getByRole("tab", { name: "スレッド" })
        .getAttribute("aria-selected"),
      "true",
    );
    await stream.evaluate((el) => (el.scrollTop = 0));
    await stream.getByRole("button", { name: "以前の投稿" }).click();
    await stream.locator(".post-directive").waitFor({ state: "attached" });
    const before = await stream.evaluate((el) => el.scrollTop);
    assert.ok(before > 0);
    await page.locator("#message").fill("請求番号の範囲も確認してください");
    release();
    const jump = page.getByRole("button", { name: "最新へ" });
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
    assert.equal(
      await stream.locator(".awaiting-answer .post-details").count(),
      0,
    );
    await page
      .locator("#state")
      .getByText("回答待ち", { exact: true })
      .waitFor();
    for (const width of [390, 1320]) {
      await page.setViewportSize({ width, height: 900 });
      assert.ok(
        await stream.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
      );
    }
    await page.getByRole("tab", { name: "実行履歴", exact: true }).click();
    await page.getByRole("tab", { name: "スレッド" }).click();
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
    await page.locator("#state").getByText("完了", { exact: true }).waitFor();
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

test("saved model assignments route a project and stay visible on the board and in its posts", async () => {
  const lead = "gpt-4.1",
    worker = "gemini-2.5-flash",
    reviewer = "gpt-4.1-mini";
  const engine = fauxProvider({
    tokensPerSecond: Infinity,
    models: [lead, worker, reviewer].map((id) => ({ id })),
  });
  const f = await fixture([], {
    provider: engine.provider,
    modelCatalog: async () => [lead, reviewer],
  });
  const openai = randomUUID(),
    google = randomUUID();
  const origin = "http://127.0.0.1:3887";
  f.config.server.origins = [origin];
  const app = await createServer(f.service, resolve("dist/web") + "/");
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    await f.service.saveSettings({
      revision: 0,
      models: [
        {
          id: openai,
          provider: "openai",
          name: "OpenAI",
          key: "fixture-openai",
          model: lead,
        },
        {
          id: google,
          provider: "google",
          name: "Google",
          key: "fixture-google",
          model: worker,
        },
      ],
      defaultModel: openai,
      mcp: [],
      instructions: "",
      limits: { modelRequests: 20, runSeconds: 60, commandSeconds: 10 },
    });
    await app.listen({ host: "127.0.0.1", port: 3887 });
    const page = await browser.newPage({
      viewport: { width: 1320, height: 900 },
      colorScheme: "light",
    });
    page.setDefaultTimeout(10000);
    await page.goto(origin);
    await page.getByRole("button", { name: "設定", exact: true }).click();
    await page.getByText("モデルの分担", { exact: true }).click();
    const settings = page
      .locator("details")
      .filter({ has: page.getByText("モデルの分担", { exact: true }) });
    await settings
      .getByRole("combobox", { name: "作業", exact: true })
      .selectOption({ label: "Google · " + worker });
    await settings.getByLabel("用途（任意）").fill("原因調査と再現テスト");
    await settings
      .getByRole("combobox", { name: "レビュー", exact: true })
      .selectOption({ label: "OpenAI · " + reviewer });
    await page.getByRole("button", { name: "設定を保存", exact: true }).click();
    await until(
      async () =>
        f.service.management().projectModels?.reviewer?.model === reviewer,
    );
    await mkdir("test-results", { recursive: true });
    await settings.scrollIntoViewIfNeeded();
    await settings.screenshot({
      path: "test-results/project-model-settings.png",
    });
    const { id } = await f.service.create(
      randomUUID(),
      "請求書の再送時に重複する原因を調査",
      openai,
      lead,
    );
    engine.setResponses([
      answer("はい、同じスレッドで調査結果を共有できます。"),
    ]);
    await f.service.send(id, randomUUID(), "ここで調査結果を受け取れますか？");
    await until(async () =>
      (await f.service.projects()).some(
        (p) => p.id === id && p.status === "answered",
      ),
    );
    assert.equal((await f.service.view(id)).project?.hasTeamPosts, false);
    engine.setResponses([
      call("project_team", {
        revision: 2,
        assignments: [{ role: "原因調査", task: "再送時の保存処理を確認する" }],
      }),
      (_c, _o, _s, m) => {
        assert.equal(m.id, worker);
        return fauxAssistantMessage(
          '{"action":"report","summary":"同じ請求番号を再送すると、2件目のレコードが作られます。"}',
        );
      },
      call("project_report", {
        revision: 2,
        stage: "delivered",
        summary: "同じ請求番号の再送は既存の1件を返すようにします。",
        deliverable: "請求番号をキーに既存の請求書を返し、二重登録を防ぎます。",
        evidence: "依頼に記載された再現条件と対策を照合。",
      }),
      (_c, _o, _s, m) => {
        assert.equal(m.id, reviewer);
        return fauxAssistantMessage(
          '{"verdict":"accept","reason":"再送時に1件に保つ対策を確認。","quotes":["同じ請求番号の再送で2件登録"]}',
        );
      },
      answer("調査結果を報告しました。"),
    ]);
    await f.service.send(
      id,
      randomUUID(),
      "同じ請求番号の再送で2件登録されます。原因と対策を報告してください。",
    );
    await until(
      async () => (await f.service.projects())[0]?.status === "delivered",
    );
    await page.goto(origin + "/?project=" + id);
    const stream = page.getByLabel("スレッドの投稿");
    await stream
      .locator(".post-report")
      .getByText(worker, { exact: true })
      .waitFor();

    await stream
      .locator(".post-review")
      .getByText(reviewer, { exact: true })
      .waitFor();
    await stream
      .locator(".post-delivery")
      .getByText(lead, { exact: true })
      .waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({
      path: "test-results/project-model-thread.png",
      animations: "disabled",
    });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(
      await stream.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    );
    await page.screenshot({
      path: "test-results/project-model-mobile.png",
      animations: "disabled",
    });
    await page.setViewportSize({ width: 1320, height: 900 });
    const pending = await f.service.create(
      randomUUID(),
      "先行リリースの案内を準備",
      openai,
      lead,
    );
    engine.setResponses([
      call("request_user_input", {
        question: "先行案内の対象は既存ユーザーだけですか？",
        options: ["既存ユーザーのみ", "新規ユーザーも含める"],
      }),
    ]);
    await f.service.send(
      pending.id,
      randomUUID(),
      "先行リリースの案内を準備してください。",
    );
    await until(async () =>
      (await f.service.projects()).some((p) => p.status === "decision"),
    );
    const quick = await f.service.create(
      randomUUID(),
      "月次レポートの提出先",
      openai,
      lead,
    );
    engine.setResponses([answer("提出先は共有フォルダです。")]);
    await f.service.send(quick.id, randomUUID(), "月次レポートの提出先は？");
    await until(async () =>
      (await f.service.projects()).some(
        (p) => p.id === quick.id && p.status === "answered",
      ),
    );
    await page.goto(origin);
    await page.getByRole("heading", { name: "ホーム", exact: true }).waitFor();
    await page.getByRole("heading", { name: "最近のスレッド" }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: "test-results/workspace-mobile.png",
      animations: "disabled",
    });
    await page
      .getByRole("navigation", { name: "ワークスペース" })
      .getByRole("button", { name: "掲示板" })
      .click();
    await page.getByRole("table", { name: "スレッド一覧" }).waitFor();
    await page.setViewportSize({ width: 1320, height: 900 });
    const modules = page.getByRole("navigation", { name: "ワークスペース" });
    await modules.getByRole("button", { name: "成果物", exact: true }).click();
    await page.getByRole("searchbox", { name: "成果物を検索" }).fill("請求書");
    await page.locator(".file-subject").first().click();
    const preview = page.locator(".file-preview");
    await preview
      .getByText("請求番号をキーに既存の請求書を返し、二重登録を防ぎます。", {
        exact: true,
      })
      .waitFor();
    await preview.getByText("検証記録", { exact: true }).click();
    await preview.locator(".delivered-proof p").waitFor();
    await page.screenshot({
      path: "test-results/groupware-documents.png",
      animations: "disabled",
    });
    await page
      .getByRole("searchbox", { name: "成果物を検索" })
      .fill("一致しない文字列");
    await page.getByText("一致する成果物はありません").waitFor();
    await page.goto(origin + "/?projects=board");
    const board = page.getByRole("table", { name: "スレッド一覧" });
    await board.getByText("先行案内の対象は既存ユーザーだけですか？").waitFor();
    await board
      .getByText("同じ請求番号の再送は既存の1件を返すようにします。")
      .waitFor();
    const boardSearch = page.getByRole("searchbox", { name: "掲示板を検索" });
    await boardSearch.fill("月次");
    assert.equal(await board.locator("tbody tr").count(), 1);
    await boardSearch.clear();
    await page.screenshot({
      path: "test-results/project-model-board.png",
      animations: "disabled",
    });
    await board.getByRole("link", { name: "月次レポートの提出先" }).click();
    await page
      .getByLabel("スレッドの履歴")
      .getByText("提出先は共有フォルダです。")
      .waitFor();
    await page.goBack();
    await board.waitFor();
    await page.goForward();
    await page
      .getByLabel("スレッドの履歴")
      .getByText("提出先は共有フォルダです。")
      .waitFor();
    await until(async () => {
      const row = (await f.service.workspaceOverview()).threads.find(
        (t) => t.id === quick.id,
      )!;
      return row.readThrough === row.notice?.id;
    });
  } finally {
    await browser.close();
    await app.close();
    await f.service.close();
  }
});
