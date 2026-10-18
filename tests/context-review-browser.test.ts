import assert from "node:assert/strict";
import test from "node:test";
import { Application } from "../src/application.js";
import {
  ContextReviewBrowser,
  contextReviewPreviewText,
} from "../src/tui/context-review-browser.js";
import { commands } from "../src/tui/actions.js";
import {
  call,
  completed,
  fixture,
  gitWorkspace,
  ScriptedRuntime,
} from "./helpers.js";

async function waitingFixture() {
  const runtime = new ScriptedRuntime(async (request) => {
    await call(request, "report_context_issue", {
      kind: "contradiction",
      detail: "```\n# 未検証の申告\n\u001b[31m条件を変えない\u001b[0m",
      evidence: "原文の引用：固定条件を維持する。",
    });
    return completed([], "not accepted");
  });
  const f = await fixture(runtime);
  const workspace = await gitWorkspace(f.root, { "README.md": "fixture" });
  const app = new Application(
    f.config,
    f.p,
    f.store,
    workspace,
    async () => runtime,
  );
  await app.initialize();
  app.session.kind = "chat";
  await app.submit("このリポジトリを説明してください。変更しないでください。");
  await app.waitForIdle();
  assert.equal(
    app.currentRun()?.state,
    "waiting_input",
    app.currentRun()?.reason,
  );
  assert.equal(app.currentRun()?.contextIssues?.length, 1);
  assert.equal(runtime.requests.length, 1);
  return {
    ...f,
    app,
    runtime,
    close: async () => {
      await app.close();
      await f.cleanup();
    },
  };
}

test("context review cancels at every dialog without changing the run", async () => {
  const f = await waitingFixture();
  try {
    const before = JSON.stringify(f.app.currentRun());
    for (const cancelledStage of [0, 1, 2, 3]) {
      let stage = 0;
      await new ContextReviewBrowser(f.app, {
        show: async () => stage++ !== cancelledStage,
        prompt: async () =>
          stage++ === cancelledStage ? undefined : "確認しました。",
        confirm: async () => stage++ !== cancelledStage,
        notice: () => assert.fail("Cancellation is not acknowledgement"),
      }).review();
      assert.equal(stage, cancelledStage + 1);
      assert.equal(JSON.stringify(f.app.currentRun()), before);
      assert.equal(f.runtime.requests.length, 1);
    }
  } finally {
    await f.close();
  }
});

test("context review displays literal evidence and acknowledges without starting work", async () => {
  const f = await waitingFixture();
  try {
    f.app.setDraft("保持する下書き");
    f.app.session.queue.push({
      id: "queued",
      text: "待機する入力",
      mode: "next",
    });
    f.app.save();
    const before = f.app.previewContextReview();
    const runBefore = f.app.currentRun()!;
    const previewText = contextReviewPreviewText(before);
    assert.match(previewText, /モデル申告（未検証）/);
    assert.match(previewText, /````\n検知 ID:/);
    assert.match(previewText, /# 未検証の申告/);
    assert.equal(previewText.includes("\u001b"), false);
    assert.match(previewText, /固定条件を維持する/);
    assert.match(previewText, /自動実行しません/);
    assert.ok(commands.some((item) => item.name === "context-review"));
    let shows = 0,
      notice = "";
    const note = "原文と固定条件を読み、次の依頼で条件を補足します。";
    await new ContextReviewBrowser(f.app, {
      show: async (text) => {
        if (shows++ === 0) assert.equal(text, previewText);
        else assert.ok(text.includes(note));
        return true;
      },
      prompt: async (_title, initial) => {
        assert.equal(initial, "");
        return note;
      },
      confirm: async (text) => {
        assert.match(text, /再開・条件変更はしません/);
        return true;
      },
      notice: (text) => {
        notice = text;
      },
    }).review();
    assert.equal(shows, 2);
    const run = f.app.currentRun()!;
    assert.equal(run.state, "waiting_input");
    assert.equal(run.contextIssues?.[0]?.acknowledged?.note, note);
    assert.equal(run.tasks[0]?.contextReviewCount, 1);
    for (const key of [
      "dataClass",
      "localOnly",
      "access",
      "constraints",
      "checks",
      "mustKeep",
      "elapsedMs",
    ] as const)
      assert.deepEqual(run[key], runBefore[key], key);
    assert.deepEqual(f.store.usage(run.id), before.policy.usage);
    assert.equal(f.runtime.requests.length, 1);
    assert.equal(f.app.busy, false);
    assert.equal(f.app.session.queue.length, 1);
    assert.equal(f.app.session.draft, "保持する下書き");
    assert.match(notice, /再開・待機入力の実行・適用はしていません/);
    await new ContextReviewBrowser(f.app, {
      show: async () => assert.fail("No unresolved issue"),
      prompt: async () => assert.fail("No unresolved issue"),
      confirm: async () => assert.fail("No unresolved issue"),
      notice: (text) => assert.match(text, /確認待ち.*ありません/),
    }).review();
  } finally {
    await f.close();
  }
});

test("context review rejects invalid notes and changes made during confirmation", async () => {
  const f = await waitingFixture();
  try {
    const before = JSON.stringify(f.app.currentRun());
    for (const note of [" \n", "あ".repeat(667)]) {
      await assert.rejects(
        new ContextReviewBrowser(f.app, {
          show: async () => true,
          prompt: async () => note,
          confirm: async () =>
            assert.fail("Invalid note cannot reach confirmation"),
          notice: () => assert.fail("Must not acknowledge"),
        }).review(),
        { code: "CONTEXT_REVIEW" },
      );
    }
    await assert.rejects(
      new ContextReviewBrowser(f.app, {
        show: async () => true,
        prompt: async () => "確認しました。",
        confirm: async () => {
          f.app.addPin("確認中に固定メモを変更");
          return true;
        },
        notice: () => assert.fail("Stale confirmation is not acknowledgement"),
      }).review(),
      { code: "CONTEXT_REVIEW_STALE" },
    );
    assert.equal(JSON.stringify(f.app.currentRun()), before);
    assert.equal(f.runtime.requests.length, 1);
  } finally {
    await f.close();
  }
});
