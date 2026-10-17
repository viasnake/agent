import assert from "node:assert/strict";
import test from "node:test";
import { Application } from "../src/application.js";
import { AgentError } from "../src/types.js";
import {
  ModelChangeBrowser,
  modelChangePreviewText,
} from "../src/tui/model-change-browser.js";
import { taskDetails } from "../src/tui/workbench.js";
import { commands } from "../src/tui/actions.js";
import {
  fixture,
  gitWorkspace,
  ScriptedRuntime,
  testConfig,
} from "./helpers.js";

async function waitingFixture() {
  const config = testConfig();
  config.models.alternative = {
    ...config.models.worker!,
    id: "different-worker",
    priority: -1,
  };
  const runtime = new ScriptedRuntime(async () => {
    throw new AgentError("AUTH", "offline fixture waiting");
  });
  const f = await fixture(runtime, config);
  const workspace = await gitWorkspace(f.root, { "README.md": "fixture" });
  const app = new Application(
    config,
    f.p,
    f.store,
    workspace,
    async () => runtime,
  );
  await app.initialize();
  app.session.kind = "chat";
  app.session.strategy = "reviewed";
  await app.submit("この会話について返答してください");
  await app.waitForIdle();
  assert.equal(app.currentRun()?.state, "waiting_input");
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

test("model change browser cancels without mutations at every dialog", async () => {
  const f = await waitingFixture();
  try {
    const before = JSON.stringify(f.app.currentRun());
    const artifacts = f.store.artifacts(f.app.currentRun()!.id);
    for (const cancelledStage of [0, 1, 2, 3]) {
      let stage = 0;
      await new ModelChangeBrowser(f.app, {
        choose: async (_title, items) => {
          const current = stage++;
          if (current === cancelledStage) return undefined;
          const selected = current === 0 ? "work" : "alternative";
          assert.ok(items.some((item) => item.value === selected));
          return selected;
        },
        show: async () => stage++ !== cancelledStage,
        confirm: async () => stage++ !== cancelledStage,
        notice: () =>
          assert.fail("Cancellation must not report a model change"),
      }).change();
      assert.equal(stage, cancelledStage + 1);
      assert.equal(JSON.stringify(f.app.currentRun()), before);
      assert.deepEqual(f.store.artifacts(f.app.currentRun()!.id), artifacts);
    }
    assert.equal(f.runtime.requests.length, 1);
  } finally {
    await f.close();
  }
});

test("model change browser confirms exact choice and stays waiting without changing next-request settings", async () => {
  const f = await waitingFixture();
  try {
    const settings = [
      f.app.session.model,
      f.app.session.reviewer,
      f.app.session.strategy,
    ];
    let shown = "",
      notice = "";
    const choices = ["work", "alternative"];
    await new ModelChangeBrowser(f.app, {
      choose: async (_title, items) => {
        const value = choices.shift();
        assert.ok(items.some((item) => item.value === value));
        return value;
      },
      show: async (text) => {
        shown = text;
        return true;
      },
      confirm: async (text) => {
        assert.match(text, /再開はしません/);
        return true;
      },
      notice: (text) => {
        notice = text;
      },
    }).change();
    assert.match(shown, /モデルは変更せず結果を再取得/);
    assert.match(shown, /必要最少/);
    assert.match(shown, /費用不明/);
    assert.match(shown, /意味的な同等性・品質は未確認/);
    assert.match(notice, /\/resume/);
    const run = f.app.currentRun()!;
    assert.equal(run.state, "waiting_input");
    assert.equal(
      run.tasks.find((task) => task.id === "work")?.model,
      "alternative",
    );
    assert.equal(
      run.tasks.find((task) => task.purpose === "synthesis")?.model,
      "worker",
    );
    assert.deepEqual(
      [f.app.session.model, f.app.session.reviewer, f.app.session.strategy],
      settings,
    );
    assert.equal(f.runtime.requests.length, 1);
    const details = taskDetails(run);
    assert.match(details, /試行報告/);
    assert.match(details, /再実行・検証の記録待ち/);
    assert.ok(details.includes(run.modelChanges![0]!.reportId));
    assert.ok(commands.some(({ name }) => name === "model-change"));
  } finally {
    await f.close();
  }
});

test("model change browser rejects changed policy after preview", async () => {
  const f = await waitingFixture();
  try {
    const before = JSON.stringify(f.app.currentRun());
    await assert.rejects(
      new ModelChangeBrowser(f.app, {
        choose: async () => "alternative",
        show: async () => true,
        confirm: async () => {
          f.app.session.localOnly = true;
          return true;
        },
        notice: () => assert.fail("Stale confirmation must not succeed"),
      }).change("work"),
      { code: "POLICY_CHANGED" },
    );
    assert.equal(JSON.stringify(f.app.currentRun()), before);
    assert.equal(f.runtime.requests.length, 1);
  } finally {
    await f.close();
  }
});

test("model change browser refuses unlisted choices and literalizes model identifiers", async () => {
  const f = await waitingFixture();
  try {
    await assert.rejects(
      new ModelChangeBrowser(f.app, {
        choose: async () => "unlisted-model",
        show: async () => assert.fail("Unlisted candidate"),
        confirm: async () => assert.fail("Unlisted candidate"),
        notice: () => {},
      }).change("work"),
      { code: "NO_MODEL" },
    );
    const preview = f.app.previewTaskModelChange("work", "alternative");
    preview.destination.modelId = "```\n# untrusted model id\n\u001b[31mtext";
    const text = modelChangePreviewText(preview);
    assert.match(text, /````\n実行:/);
    assert.ok(!text.includes("\u001b"));
    assert.match(text, /同等性・品質は未確認/);
    assert.equal(f.runtime.requests.length, 1);
    assert.equal(f.app.currentRun()?.modelChanges?.length ?? 0, 0);
  } finally {
    await f.close();
  }
});
