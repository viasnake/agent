import assert from "node:assert/strict";
import { existsSync, rmSync, symlinkSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { stringify } from "yaml";
import { Conversations } from "../src/conversations.js";
import {
  confirmHistoryDeletion,
  pendingDeletions,
  previewHistoryDeletion,
  retryDeletionCleanup,
} from "../src/history-deletion.js";
import { completed, fixture, ScriptedRuntime } from "./helpers.js";

async function terminalRun(
  f: Awaited<ReturnType<typeof fixture>>,
  conversationId?: string,
) {
  const run = await f.harness.create({
    kind: "research",
    objective: "deletion fixture",
    conversationId,
  });
  const claimed = f.store.claim(run.id);
  f.store.transition(claimed, "succeeded");
  f.store.release(claimed);
  return f.store.get(run.id);
}

async function configFile(f: Awaited<ReturnType<typeof fixture>>) {
  await writeFile(f.p.config, stringify(f.config), { mode: 0o600 });
}

test("deletes a closed conversation and all of its terminal runs", async () => {
  const f = await fixture(new ScriptedRuntime(async () => completed()));
  try {
    await configFile(f);
    const workspace = join(f.root, "workspace");
    await mkdir(workspace);
    const conversations = new Conversations(f.store);
    const session = conversations.create(workspace, {
      dataClass: "private",
      checks: [],
    });
    const run = await terminalRun(f, session.id);
    conversations.link(session, run);
    conversations.message(session, "user", "保存された本文", run.id);
    conversations.release(session.id);

    const preview = previewHistoryDeletion(f.store, f.config, {
      kind: "selection",
      conversationIds: [session.id],
      runIds: [],
    });
    const runDirectory = f.store.runDir(run.id);
    assert.deepEqual(preview.retained, []);
    assert.equal(preview.counts.messages, 1);
    const result = await confirmHistoryDeletion(f.store, f.config, preview);
    assert.deepEqual(result.removedConversations, [session.id]);
    assert.deepEqual(result.removedRuns, [run.id]);
    assert.deepEqual(result.pendingCleanup, []);
    assert.throws(() => f.store.get(run.id), /unknown run/i);
    assert.equal(
      f.store.db
        .prepare("SELECT 1 FROM conversations WHERE id=?")
        .get(session.id),
      undefined,
    );
    assert.equal(existsSync(runDirectory), false);
  } finally {
    await f.cleanup();
  }
});

test("selection is retained by literal references and unresolved activity", async () => {
  const f = await fixture(new ScriptedRuntime(async () => completed()));
  try {
    await configFile(f);
    const workspace = join(f.root, "workspace");
    await mkdir(workspace);
    const conversations = new Conversations(f.store);
    const target = conversations.create(workspace, {
      dataClass: "private",
      checks: [],
    });
    const targetRun = await terminalRun(f, target.id);
    conversations.link(target, targetRun);
    conversations.release(target.id);
    const referrer = conversations.create(workspace, {
      dataClass: "private",
      checks: [],
    });
    conversations.message(referrer, "user", `参照 ${targetRun.id}`);
    conversations.release(referrer.id);

    const preview = previewHistoryDeletion(f.store, f.config, {
      kind: "selection",
      conversationIds: [target.id],
      runIds: [],
    });
    assert.equal(preview.retained[0]?.id, target.id);
    assert.match(preview.retained[0]?.reason ?? "", /参照/);
    await assert.rejects(
      confirmHistoryDeletion(f.store, f.config, preview),
      /references|retained/i,
    );
  } finally {
    await f.cleanup();
  }
});

test("selected deletion is all-or-none and protects active sessions", async () => {
  const f = await fixture(new ScriptedRuntime(async () => completed()));
  try {
    await configFile(f);
    const good = await terminalRun(f);
    const unresolved = await terminalRun(f);
    f.store.db
      .prepare("INSERT INTO operations VALUES (?,?,?,?,?,?,?,?)")
      .run(
        "11111111-1111-4111-8111-111111111111",
        unresolved.id,
        unresolved.generation,
        "worker",
        "write_file",
        "fixture-hash",
        "unknown",
        null,
      );
    const preview = previewHistoryDeletion(f.store, f.config, {
      kind: "selection",
      conversationIds: [],
      runIds: [good.id, unresolved.id],
    });
    assert.deepEqual(preview.runIds, [good.id]);
    assert.match(preview.retained[0]?.reason ?? "", /operation/);
    await assert.rejects(
      confirmHistoryDeletion(f.store, f.config, preview),
      /retained|references/i,
    );
    assert.equal(f.store.get(good.id).id, good.id);
    assert.equal(f.store.get(unresolved.id).id, unresolved.id);

    const conversations = new Conversations(f.store);
    const session = conversations.create(f.root, {
      dataClass: "private",
      checks: [],
    });
    conversations.release(session.id);
    const ownedPreview = previewHistoryDeletion(
      f.store,
      f.config,
      {
        kind: "selection",
        conversationIds: [session.id],
        runIds: [],
      },
      { currentSessionId: session.id },
    );
    assert.match(ownedPreview.retained[0]?.reason ?? "", /現在の会話/);
  } finally {
    await f.cleanup();
  }
});

test("retention propagates external references to a fixed point", async () => {
  const f = await fixture(new ScriptedRuntime(async () => completed()));
  try {
    await configFile(f);
    const conversations = new Conversations(f.store);
    const create = (message: string) => {
      const session = conversations.create(f.root, {
        dataClass: "private",
        checks: [],
      });
      conversations.message(session, "user", message);
      conversations.release(session.id);
      return session;
    };
    const last = create("last");
    const middle = create(`to ${last.id}`);
    const first = create(`to ${middle.id}`);
    const recent = create(`to ${first.id}`);
    for (const [session, updatedAt] of [
      [first, 1],
      [middle, 2],
      [last, 3],
    ] as const)
      f.store.db
        .prepare("UPDATE conversations SET updated_at=? WHERE id=?")
        .run(updatedAt, session.id);

    const preview = previewHistoryDeletion(f.store, f.config, {
      kind: "retention",
      cutoff: 100,
    });
    assert.deepEqual(preview.conversationIds, []);
    assert.deepEqual(
      preview.retained.map((entry) => entry.id).sort(),
      [first.id, last.id, middle.id].sort(),
    );
    assert.equal(recent.id === first.id, false);
  } finally {
    await f.cleanup();
  }
});

test("retention is bounded and stale previews cannot be confirmed", async () => {
  const f = await fixture(new ScriptedRuntime(async () => completed()));
  try {
    await configFile(f);
    const old = await terminalRun(f);
    const recent = await terminalRun(f);
    const oldPayload = f.store.get(old.id);
    oldPayload.updatedAt = 1;
    f.store.db
      .prepare("UPDATE runs SET payload=? WHERE id=?")
      .run(JSON.stringify(oldPayload), old.id);
    const preview = previewHistoryDeletion(f.store, f.config, {
      kind: "retention",
      cutoff: 100,
    });
    assert.deepEqual(preview.runIds, [old.id]);
    const changed = {
      ...f.config,
      retentionDays: Math.min(3650, f.config.retentionDays + 1),
    };
    await writeFile(f.p.config, stringify(changed), { mode: 0o600 });
    await assert.rejects(
      confirmHistoryDeletion(f.store, f.config, preview),
      /changed|stale/i,
    );
    assert.equal(f.store.get(recent.id).id, recent.id);
  } finally {
    await f.cleanup();
  }
});

test("a database deletion failure rolls back metadata and queues no cleanup", async () => {
  const f = await fixture(new ScriptedRuntime(async () => completed()));
  try {
    await configFile(f);
    const run = await terminalRun(f);
    const runDirectory = f.store.runDir(run.id);
    const preview = previewHistoryDeletion(f.store, f.config, {
      kind: "selection",
      conversationIds: [],
      runIds: [run.id],
    });
    f.store.db.exec(`
      CREATE TRIGGER reject_history_delete
      BEFORE DELETE ON runs
      BEGIN SELECT RAISE(ABORT, 'forced deletion failure'); END;
    `);
    await assert.rejects(
      confirmHistoryDeletion(f.store, f.config, preview),
      /forced deletion failure/,
    );
    assert.equal(f.store.get(run.id).id, run.id);
    assert.equal(existsSync(runDirectory), true);
    assert.deepEqual(pendingDeletions(f.store), []);
  } finally {
    await f.cleanup();
  }
});

test("identity changes leave a durable cleanup job for explicit retry", async () => {
  const f = await fixture(new ScriptedRuntime(async () => completed()));
  try {
    await configFile(f);
    const run = await terminalRun(f);
    const preview = previewHistoryDeletion(f.store, f.config, {
      kind: "selection",
      conversationIds: [],
      runIds: [run.id],
    });
    const replacement = join(f.root, "replacement");
    const runDirectory = f.store.runDir(run.id);
    await mkdir(replacement);
    const result = await confirmHistoryDeletion(f.store, f.config, preview, {
      beforeCommit: () => {
        rmSync(runDirectory, { recursive: true, force: true });
        symlinkSync(replacement, runDirectory);
      },
    });
    assert.equal(result.removedRuns[0], run.id);
    assert.equal(result.pendingCleanup.length, 1);
    assert.equal(pendingDeletions(f.store).length, 1);
    const jobId = result.pendingCleanup[0]?.id;
    assert.ok(jobId);
    await rm(runDirectory, { recursive: true, force: true });
    assert.deepEqual(await retryDeletionCleanup(f.store, [jobId]), []);
  } finally {
    await f.cleanup();
  }
});
