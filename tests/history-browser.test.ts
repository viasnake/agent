import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import { Application } from "../src/application.js";
import {
  HistoryBrowser,
  historyDeletionText,
} from "../src/tui/history-browser.js";
import { commands } from "../src/tui/actions.js";
import { fixture, gitWorkspace, ScriptedRuntime } from "./helpers.js";

async function historyFixture() {
  const runtime = new ScriptedRuntime(async () =>
    assert.fail("History maintenance must not infer"),
  );
  const f = await fixture(runtime);
  const workspace = await gitWorkspace(f.root, { "README.md": "fixture" });
  await fs.writeFile(f.p.config, stringify(f.config), { mode: 0o600 });
  const app = new Application(f.config, f.p, f.store, workspace, async () =>
    assert.fail("History maintenance must not create a runtime"),
  );
  await app.initialize();
  const closed = async (name = "保存済み会話") => {
    const session = app.conversations.create(app.session.workspace, {
      dataClass: "private",
      checks: [],
    });
    session.name = name;
    session.draft = "未送信の下書き";
    const run = await f.harness.create({
      kind: "research",
      objective: "offline deletion",
      conversationId: session.id,
      workspace: app.session.workspace,
    });
    const claimed = f.store.claim(run.id);
    f.store.transition(claimed, "succeeded");
    f.store.release(claimed);
    app.conversations.link(session, run);
    app.conversations.message(session, "user", "保存した本文", run.id);
    session.latestRunId = run.id;
    app.conversations.save(session);
    app.conversations.release(session.id);
    return { session, run };
  };
  return {
    ...f,
    app,
    runtime,
    closed,
    close: async () => {
      await app.close();
      await f.cleanup();
    },
  };
}

test("history dialog cancellation preserves selected history; explicit selection deletes without inference", async () => {
  const f = await historyFixture();
  try {
    const { session, run } = await f.closed("```\n# 保存名\u001b[31m");
    const runDirectory = f.store.runDir(run.id);
    for (const name of ["delete", "prune", "cleanup-deletions"])
      assert.ok(commands.some((command) => command.name === name));
    for (const cancelAt of ["picker", "preview", "confirmation"]) {
      const selections = [session.id, "preview"];
      await new HistoryBrowser(f.app, {
        choose: async (_title, choices) => {
          if (cancelAt === "picker") return undefined;
          const selected = selections.shift();
          assert.ok(choices.some((choice) => choice.value === selected));
          assert.ok(
            choices.every((choice) => !choice.label.includes("\u001b")),
          );
          return selected;
        },
        show: async (text) => {
          assert.match(text, /暗号学的消去は保証しません/);
          assert.ok(text.includes(run.id));
          assert.match(text, /下書き・待機入力/);
          return cancelAt !== "preview";
        },
        confirm: async () => false,
        notice: () => assert.fail("Cancellation must not report deletion"),
      }).remove();
      assert.equal(f.store.get(run.id).id, run.id);
      assert.equal(f.app.conversations.get(session.id).draft, "未送信の下書き");
    }
    let notice = "";
    await new HistoryBrowser(f.app, {
      choose: async () =>
        assert.fail("Explicit IDs should not select different units"),
      show: async () => true,
      confirm: async () => true,
      notice: (value) => {
        notice = value;
      },
    }).remove(`session ${session.id}`);
    assert.match(notice, /メタデータを削除/);
    assert.match(notice, /専用ファイルの回収も完了/);
    assert.throws(() => f.store.get(run.id), /Unknown run/i);
    assert.equal(existsSync(runDirectory), false);
    assert.equal(f.app.busy, false);
    assert.equal(f.runtime.requests.length, 0);
  } finally {
    await f.close();
  }
});

test("application deletion seals session policy, ownership and exact preview; cancellation prevents mutation", async () => {
  const f = await historyFixture();
  try {
    const { session, run } = await f.closed();
    const request = {
      kind: "selection" as const,
      conversationIds: [session.id],
      runIds: [],
    };
    const preview = f.app.previewHistoryDeletion(request);
    await assert.rejects(f.app.confirmHistoryDeletion({ ...preview }), {
      code: "STALE_VIEW",
    });
    f.app.session.localOnly = true;
    await assert.rejects(f.app.confirmHistoryDeletion(preview), {
      code: "STALE_VIEW",
    });
    f.app.session.localOnly = false;
    const tampered = f.app.previewHistoryDeletion(request);
    tampered.runIds = [];
    await assert.rejects(f.app.confirmHistoryDeletion(tampered), {
      code: "STALE_VIEW",
    });
    const owned = f.app.previewHistoryDeletion(request);
    f.store.db
      .prepare("UPDATE conversations SET owner=? WHERE id=?")
      .run("another-owner", f.app.session.id);
    await assert.rejects(f.app.confirmHistoryDeletion(owned), {
      code: "SESSION_BUSY",
    });
    f.store.db
      .prepare("UPDATE conversations SET owner=? WHERE id=?")
      .run(f.app.conversations.owner, f.app.session.id);
    const late = f.app.previewHistoryDeletion(request);
    const operation = f.app.confirmHistoryDeletion(late);
    f.app.session.localOnly = true;
    await assert.rejects(operation, { code: "STALE_VIEW" });
    f.app.session.localOnly = false;
    const cancelled = f.app.confirmHistoryDeletion(
      f.app.previewHistoryDeletion(request),
    );
    f.app.stop();
    await assert.rejects(cancelled, { name: "AbortError" });
    assert.equal(f.store.get(run.id).id, run.id);
    assert.equal(f.app.busy, false);
    const staleSession = f.app.previewHistoryDeletion(request);
    await f.app.newSession();
    await assert.rejects(f.app.confirmHistoryDeletion(staleSession), {
      code: "STALE_VIEW",
    });
    const final = f.app.previewHistoryDeletion(request);
    await f.app.confirmHistoryDeletion(final);
    await assert.rejects(f.app.confirmHistoryDeletion(final), {
      code: "STALE_VIEW",
    });
    assert.equal(f.runtime.requests.length, 0);
  } finally {
    await f.close();
  }
});

test("retention dialog protects current and other workspaces; held selections cannot confirm", async () => {
  const f = await historyFixture();
  try {
    const { session, run } = await f.closed();
    const payload = f.store.get(run.id);
    payload.updatedAt = 1;
    f.store.db
      .prepare("UPDATE runs SET payload=? WHERE id=?")
      .run(JSON.stringify(payload), run.id);
    const otherPath = join(f.root, "other");
    await fs.mkdir(otherPath);
    const other = f.app.conversations.create(otherPath, {
      dataClass: "private",
      checks: [],
    });
    f.app.conversations.release(other.id);
    f.store.db.prepare("UPDATE conversations SET updated_at=1").run();
    let confirmed = 0;
    const browser = new HistoryBrowser(f.app, {
      choose: async () => undefined,
      show: async (text) => {
        assert.match(text, /現在の会話|使用中/);
        return true;
      },
      confirm: async () => {
        confirmed++;
        return true;
      },
      notice: () => {},
    });
    await browser.remove(f.app.session.id);
    assert.equal(confirmed, 0);
    const held = f.app.previewHistoryDeletion({
      kind: "selection",
      conversationIds: [f.app.session.id, session.id],
      runIds: [],
    });
    held.retained[0]!.name = "```\n# misleading\u001b[31m";
    const text = historyDeletionText(held);
    assert.match(text, /````/);
    assert.ok(!text.includes("\u001b"));
    assert.match(text, /選択全体を削除しません/);
    await new HistoryBrowser(f.app, {
      choose: async () => undefined,
      show: async (text) => {
        assert.match(text, /保持期間の基準/);
        assert.ok(text.includes(run.id));
        return true;
      },
      confirm: async () => true,
      notice: () => {},
    }).prune();
    assert.throws(() => f.app.conversations.get(session.id), /not found/);
    assert.equal(f.app.conversations.get(other.id).id, other.id);
    assert.equal(
      f.app.conversations.get(f.app.session.id).id,
      f.app.session.id,
    );
    assert.equal(f.runtime.requests.length, 0);
  } finally {
    await f.close();
  }
});

test("cleanup dialog binds durable intent and retries only the explicitly confirmed job", async (t) => {
  const f = await historyFixture();
  try {
    const first = await f.closed(),
      second = await f.closed();
    const firstRunDirectory = f.store.runDir(first.run.id);
    const secondRunDirectory = f.store.runDir(second.run.id);
    const originalRm = fs.rm.bind(fs);
    let failRemoval = true;
    t.mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
      if (failRemoval) throw new Error("fixture removal failure");
      return Reflect.apply(originalRm, fs, args);
    });
    const remove = async (id: string) =>
      f.app.confirmHistoryDeletion(
        f.app.previewHistoryDeletion({
          kind: "selection",
          conversationIds: [id],
          runIds: [],
        }),
      );
    const result = await remove(first.session.id);
    await remove(second.session.id);
    failRemoval = false;
    const jobId = result.pendingCleanup[0]!.id;
    const preview = f.app.previewHistoryCleanup([jobId]);
    const row = f.store.db
      .prepare("SELECT payload FROM deletion_queue WHERE id=?")
      .get(jobId) as { payload: string };
    const changed = JSON.parse(row.payload);
    changed.root.ino = String(BigInt(changed.root.ino) + 1n);
    f.store.db
      .prepare("UPDATE deletion_queue SET payload=? WHERE id=?")
      .run(JSON.stringify(changed), jobId);
    await assert.rejects(f.app.confirmHistoryCleanup(preview), {
      code: "STALE_VIEW",
    });
    assert.equal(existsSync(firstRunDirectory), true);
    f.store.db
      .prepare("UPDATE deletion_queue SET payload=? WHERE id=?")
      .run(row.payload, jobId);
    for (const cancelAt of ["picker", "preview", "confirmation"]) {
      await new HistoryBrowser(f.app, {
        choose: async () => (cancelAt === "picker" ? undefined : jobId),
        show: async () => cancelAt !== "preview",
        confirm: async () => false,
        notice: () => assert.fail("Cancellation must not report cleanup"),
      }).cleanup();
      assert.equal(f.app.pendingHistoryDeletions().length, 2);
    }
    let notice = "";
    await new HistoryBrowser(f.app, {
      choose: async () => jobId,
      show: async (text) => {
        assert.match(text, /全作業ディレクトリ/);
        assert.ok(text.includes(first.run.id));
        assert.ok(!text.includes(second.run.id));
        return true;
      },
      confirm: async () => true,
      notice: (value) => {
        notice = value;
      },
    }).cleanup();
    assert.match(notice, /回収が完了/);
    assert.equal(f.app.pendingHistoryDeletions().length, 1);
    assert.equal(existsSync(firstRunDirectory), false);
    assert.equal(existsSync(secondRunDirectory), true);
    assert.equal(f.runtime.requests.length, 0);
  } finally {
    t.mock.restoreAll();
    await f.close();
  }
});

test("closing waits for in-flight physical cleanup and never starts queued inference", async (t) => {
  const f = await historyFixture();
  let closed = false;
  let release = () => {};
  try {
    const { session, run } = await f.closed();
    const runDirectory = f.store.runDir(run.id);
    let startCleanup!: () => void;
    let finishCleanup!: () => void;
    const started = new Promise<void>((resolve) => {
      startCleanup = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    release = finishCleanup;
    const originalRm = fs.rm.bind(fs);
    t.mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
      startCleanup();
      await gate;
      return Reflect.apply(originalRm, fs, args);
    });
    const operation = f.app.confirmHistoryDeletion(
      f.app.previewHistoryDeletion({
        kind: "selection",
        conversationIds: [session.id],
        runIds: [],
      }),
    );
    await started;
    const closing = f.app.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    assert.equal(closed, false);
    release();
    await operation;
    await closing;
    assert.equal(closed, true);
    assert.equal(existsSync(runDirectory), false);
    assert.equal(f.runtime.requests.length, 0);
  } finally {
    release();
    t.mock.restoreAll();
    if (!closed) await f.app.close();
    await f.cleanup();
  }
});
