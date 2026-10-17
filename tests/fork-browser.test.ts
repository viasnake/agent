import assert from "node:assert/strict";
import test from "node:test";
import { Application } from "../src/application.js";
import { captureBoundary, persistBoundary } from "../src/branching.js";
import { ForkBrowser } from "../src/tui/fork-browser.js";
import { commands } from "../src/tui/actions.js";
import { fixture, ScriptedRuntime } from "./helpers.js";

async function browserFixture(populate = true) {
  const runtime = new ScriptedRuntime(async () =>
    assert.fail("Browsing must not run inference"),
  );
  const f = await fixture(runtime);
  const app = new Application(f.config, f.p, f.store, f.root, async () =>
    assert.fail("Browsing must not create a runtime"),
  );
  await app.initialize();
  let legacySeq = 0,
    stateSeq = 0;
  if (populate) {
    for (let i = 0; i < 32; i++) {
      const seq = app.conversations.message(app.session, "user", `旧形式 ${i}`);
      legacySeq ||= seq;
    }
    app.session.context!.pins.push({
      id: "past",
      text: "保存された固定条件",
      kind: "pin",
      author: "user",
      trusted: true,
      updatedAt: Date.now(),
    });
    const boundary = await captureBoundary(
      f.p,
      f.config,
      f.store,
      app.session,
      0,
    );
    stateSeq = app.conversations.message(
      app.session,
      "assistant",
      "保存時点\n```\n# これは保存内容",
    );
    persistBoundary(f.store, boundary, stateSeq);
    app.conversations.message(app.session, "user", "後から追加した発言");
    app.session.context!.pins.push({
      id: "future",
      text: "未来の条件",
      kind: "pin",
      author: "user",
      trusted: true,
      updatedAt: Date.now(),
    });
    app.session.draft = "未送信";
    app.session.queue.push({
      id: "future-input",
      text: "未来の依頼",
      mode: "next",
    });
    app.save();
  }
  return {
    ...f,
    app,
    legacySeq,
    stateSeq,
    async close() {
      await app.close();
      await f.cleanup();
    },
  };
}

test("fork browser pages backward and forward, labels legacy limits, and cancels without creating a conversation", async (t) => {
  const f = await browserFixture();
  const before = JSON.stringify(f.app.session);
  const cursors: (number | undefined)[] = [];
  const points = f.app.forkPoints.bind(f.app);
  t.mock.method(f.app, "forkPoints", (cursor?: number) => {
    cursors.push(cursor);
    return points(cursor);
  });
  const choices = ["older", "newer", "older", String(f.legacySeq), "history"];
  let confirmation = false;
  try {
    assert.ok(commands.some((command) => command.name === "fork"));
    await new ForkBrowser(f.app, {
      choose: async (_title, items) => {
        const selected = choices.shift();
        assert.ok(items.some((item) => item.value === selected));
        if (selected === "history")
          assert.deepEqual(
            items.map((item) => item.value),
            ["history"],
          );
        return selected;
      },
      show: async (text, _title, accept) => {
        assert.match(text, /保存状態を利用できない理由/);
        assert.match(text, /会話本文のみ/);
        assert.match(text, /推論・検証・適用は行いません/);
        assert.equal(accept, "確認へ進む");
        return true;
      },
      confirm: async () => {
        confirmation = true;
        return false;
      },
      notice: () => assert.fail("Cancelled fork must not report restoration"),
    }).fork();
    assert.equal(confirmation, true);
    assert.equal(cursors.length, 4);
    assert.equal(cursors[0], undefined);
    assert.equal(cursors[2], undefined);
    assert.equal(cursors[1], cursors[3]);
    assert.equal(JSON.stringify(f.app.session), before);
    assert.equal(f.app.sessions().length, 1);
  } finally {
    await f.close();
  }
});

for (const mode of ["state", "history"] as const) {
  test(`fork browser explicitly confirms ${mode} and opens an idle read-only child`, async () => {
    const f = await browserFixture();
    const parentId = f.app.session.id;
    const choices = [String(f.stateSeq), mode];
    const notices: string[] = [];
    try {
      await new ForkBrowser(f.app, {
        choose: async (_title, items) => {
          const selected = choices.shift();
          assert.ok(items.some((item) => item.value === selected));
          return selected;
        },
        show: async (text) => {
          assert.match(text, /````\n保存時点/);
          assert.match(text, /待機入力・未送信/);
          assert.match(text, /読み取り専用/);
          return true;
        },
        confirm: async (text) => {
          assert.match(text, /新しい会話を作成/);
          return true;
        },
        notice: (text) => notices.push(text),
      }).fork("  新しい分岐  ");
      assert.notEqual(f.app.session.id, parentId);
      assert.equal(f.app.session.name, "新しい分岐");
      assert.equal(f.app.session.access, "read-only");
      assert.equal(f.app.busy, false);
      assert.equal(f.app.session.latestRunId, undefined);
      assert.equal(f.app.session.draft, "");
      assert.deepEqual(f.app.session.queue, []);
      assert.deepEqual(
        f.app.session.context!.pins.map((pin) => pin.id),
        mode === "state" ? ["past"] : [],
      );
      assert.ok(
        !f.app.history().some((message) => message.text.includes("後から")),
      );
      assert.equal(f.app.conversations.get(parentId).draft, "未送信");
      assert.match(notices.at(-1)!, /復元のみ/);
      assert.deepEqual(f.app.conversations.runs(f.app.session.id), []);
    } finally {
      await f.close();
    }
  });
}

test("closing the fork preview cancels before final confirmation", async () => {
  const f = await browserFixture();
  const parentId = f.app.session.id;
  const choices = [String(f.stateSeq), "state"];
  try {
    await new ForkBrowser(f.app, {
      choose: async () => choices.shift(),
      show: async () => false,
      confirm: async () => assert.fail("Preview close must cancel"),
      notice: () => assert.fail("Preview close must not restore"),
    }).fork();
    assert.equal(f.app.session.id, parentId);
    assert.equal(f.app.sessions().length, 1);
  } finally {
    await f.close();
  }
});

for (const change of ["session", "busy", "policy"] as const) {
  test(`fork browser rejects a changed ${change} at confirmation`, async () => {
    const f = await browserFixture();
    const choices = [String(f.stateSeq), "state"];
    try {
      await assert.rejects(
        new ForkBrowser(f.app, {
          choose: async () => choices.shift(),
          show: async () => true,
          confirm: async () => {
            if (change === "session") await f.app.newSession();
            else if (change === "busy") f.app.busy = true;
            else {
              f.app.session.context!.excludedSourceUrls = [
                "https://example.test/excluded",
              ];
              f.app.save();
            }
            return true;
          },
          notice: () => {},
        }).fork(),
        { code: change === "busy" ? "BUSY" : "STALE_VIEW" },
      );
      assert.equal(f.app.sessions().length, change === "session" ? 2 : 1);
    } finally {
      f.app.busy = false;
      await f.close();
    }
  });
}

test("fork browser reports empty history without opening dialogs or starting work", async () => {
  const f = await browserFixture(false);
  let notice = "";
  try {
    await new ForkBrowser(f.app, {
      choose: async () => assert.fail("No points"),
      show: async () => assert.fail("No preview"),
      confirm: async () => assert.fail("No creation"),
      notice: (text) => {
        notice = text;
      },
    }).fork();
    assert.match(notice, /分岐できる発言がありません/);
    assert.equal(f.app.sessions().length, 1);
  } finally {
    await f.close();
  }
});
