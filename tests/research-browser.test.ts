import assert from "node:assert/strict";
import test from "node:test";
import { Application } from "../src/application.js";
import {
  ResearchBrowser,
  checkpointText,
} from "../src/tui/research-browser.js";
import { fixture, ScriptedRuntime } from "./helpers.js";

async function browserFixture() {
  const runtime = new ScriptedRuntime(async () => {
    throw new Error("Browsing must not call a provider");
  });
  const f = await fixture(runtime);
  const app = new Application(
    f.config,
    f.p,
    f.store,
    f.root,
    async () => runtime,
  );
  await app.initialize();
  const run = await f.harness.create({
    kind: "research",
    access: "read-only",
    objective: "Offline browser fixture",
    dataClass: "private",
    conversationId: app.session.id,
  });
  app.conversations.link(app.session, run);
  const owned = f.store.claim(run.id);
  const source = await f.store.artifact(
    owned,
    "資料.txt",
    "source",
    "元の資料\n第2行\n",
  );
  f.store.release(owned);
  return {
    ...f,
    app,
    run,
    source,
    runtime,
    async close() {
      await app.close();
      await f.cleanup();
    },
  };
}

test("source browser cancellation preserves evidence and confirmation is bound to policy", async () => {
  const f = await browserFixture();
  let confirm = false;
  let changePolicy = false;
  let confirmation = "";
  let notice = "";
  const browser = new ResearchBrowser(f.app, {
    choose: async () => undefined,
    show: async () => false,
    confirm: async (text) => {
      confirmation = text;
      if (changePolicy)
        f.app.session.context!.excludedSourceUrls = [
          "https://example.com/changed",
        ];
      return confirm;
    },
    notice: (text) => {
      notice = text;
    },
  });
  try {
    await browser.excludeSource(f.source.id);
    assert.match(
      confirmation,
      /原本・過去の発言・引用・要約・送信済みデータは消去されません/,
    );
    assert.ok(!f.app.session.context?.excludedSourceIds?.includes(f.source.id));
    confirm = true;
    changePolicy = true;
    await assert.rejects(browser.excludeSource(f.source.id), {
      code: "SOURCE_BINDING",
    });
    assert.ok(!f.app.session.context?.excludedSourceIds?.includes(f.source.id));
    changePolicy = false;
    await browser.excludeSource(f.source.id);
    assert.ok(f.app.session.context?.excludedSourceIds?.includes(f.source.id));
    assert.match(notice, /消去していません/);
    assert.equal(
      (await f.store.content(f.source)).toString(),
      "元の資料\n第2行\n",
    );
    assert.equal(f.runtime.requests.length, 0);
  } finally {
    await f.close();
  }
});

test("version browser pages through authorized history and displays explicit diff direction", async () => {
  const f = await browserFixture();
  try {
    const owned = f.store.claim(f.run.id);
    const documents = [];
    for (let index = 0; index < 31; index++)
      documents.push(
        await f.store.artifact(owned, "記事.md", "document", `# 版 ${index}\n`),
      );
    f.store.release(owned);
    const answers = [documents.at(-1)!.id, "diff", "older", documents[0]!.id];
    let displayed = "";
    const browser = new ResearchBrowser(f.app, {
      choose: async (_title, choices) => {
        const answer = answers.shift();
        assert.ok(choices.some((choice) => choice.value === answer));
        return answer;
      },
      show: async (text) => {
        displayed = text;
        return false;
      },
      confirm: async () => {
        throw new Error("Diff must not ask to apply");
      },
      notice: () => {},
    });
    await browser.versions("記事.md");
    assert.equal(answers.length, 0);
    assert.ok(displayed.includes(`比較前: ${documents.at(-1)!.id}`));
    assert.ok(displayed.includes(`比較後: ${documents[0]!.id}`));
    assert.match(displayed, /-# 版 30/);
    assert.match(displayed, /\+# 版 0/);
    assert.equal((await f.app.artifactHistory("記事.md")).length, 30);
    assert.equal(f.runtime.requests.length, 0);
  } finally {
    await f.close();
  }
});

test("research browser separates offline model notes from user authority and network operations", async () => {
  const f = await browserFixture();
  try {
    f.app.session.context!.researchCheckpoint = {
      summary: "未検証の仮説",
      searchedScopes: ["保存済み資料だけ"],
      openQuestions: ["更新日が不明"],
      decisions: [{ text: "追加調査が必要", sourceIds: [f.source.id] }],
      author: "model",
      trusted: false,
      updatedAt: 1,
    };
    const before = JSON.stringify(f.app.session.context);
    let displayed = "";
    let action = "checkpoint";
    const browser = new ResearchBrowser(f.app, {
      choose: async () => action,
      show: async (text) => {
        displayed = text;
        return false;
      },
      confirm: async () => false,
      notice: () => {},
    });
    await browser.research();
    assert.match(displayed, /モデル作成の未検証/);
    assert.match(displayed, /未検証の仮説/);
    assert.match(displayed, /再検索・再取得はしません/);
    assert.equal(JSON.stringify(f.app.session.context), before);
    action = "policy";
    await browser.research();
    assert.match(displayed, /未設定（検索は利用できません）/);
    assert.equal(f.runtime.requests.length, 0);
    assert.match(checkpointText(), /ありません/);
  } finally {
    await f.close();
  }
});
