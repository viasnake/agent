import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync, symlinkSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import lockfile from "proper-lockfile";
import { stringify } from "yaml";
import { Conversations } from "../src/conversations.js";
import {
  confirmHistoryDeletion,
  pendingDeletions,
  previewHistoryDeletion,
  retryDeletionCleanup,
} from "../src/history-deletion.js";
import { Store } from "../src/storage.js";
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
    await assert.rejects(f.store.remove(unresolved.id), /retained|reference/i);
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

test("retention seeds unresolved sources and overflow referrers before propagation", async () => {
  const f = await fixture(new ScriptedRuntime(async () => completed()));
  try {
    await configFile(f);
    const source = await f.harness.create({
      kind: "research",
      objective: "unresolved source",
    });
    const middle = await terminalRun(f);
    const target = await terminalRun(f);
    const sourcePayload = {
      ...f.store.get(source.id),
      updatedAt: 1,
      parentRunId: middle.id,
      context: { originalRunIds: [middle.id] },
      text: `literal ${middle.id}`,
    };
    const middlePayload = {
      ...f.store.get(middle.id),
      updatedAt: 1,
      parentRunId: target.id,
      context: { originalRunIds: [target.id] },
    };
    const targetPayload = { ...f.store.get(target.id), updatedAt: 1 };
    f.store.db
      .prepare("UPDATE runs SET payload=? WHERE id=?")
      .run(JSON.stringify(sourcePayload), source.id);
    f.store.db
      .prepare("UPDATE runs SET payload=? WHERE id=?")
      .run(JSON.stringify(middlePayload), middle.id);
    f.store.db
      .prepare("UPDATE runs SET payload=? WHERE id=?")
      .run(JSON.stringify(targetPayload), target.id);
    f.store.db
      .prepare("INSERT INTO operations VALUES (?,?,?,?,?,?,?,?)")
      .run(
        randomUUID(),
        source.id,
        source.generation,
        "worker",
        "write_file",
        "hash",
        "unknown",
        null,
      );
    const chainPreview = previewHistoryDeletion(f.store, f.config, {
      kind: "retention",
      cutoff: 100,
    });
    assert.deepEqual(chainPreview.runIds, []);
    assert.deepEqual(
      chainPreview.retained.map((entry) => entry.id).sort(),
      [source.id, middle.id, target.id].sort(),
    );

    const template = f.store.get(target.id);
    const inserted: string[] = [];
    for (let index = 1; index <= 501; index++) {
      const runId = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
      inserted.push(runId);
      const payload = {
        ...template,
        id: runId,
        objective: `old ${index}`,
        updatedAt: 1,
        ...(index === 501
          ? {
              context: {
                originalRunIds: ["00000000-0000-4000-8000-000000000001"],
              },
            }
          : {}),
      };
      f.store.db
        .prepare(
          "INSERT INTO runs(id,state,payload,generation,heartbeat,cancel_requested) VALUES (?,?,?,?,?,?)",
        )
        .run(runId, "succeeded", JSON.stringify(payload), 0, null, 0);
    }
    const overflowPreview = previewHistoryDeletion(f.store, f.config, {
      kind: "retention",
      cutoff: 100,
    });
    assert.ok(overflowPreview.moreCandidates >= 2);
    assert.ok(
      overflowPreview.retained.some(
        (entry) => entry.id === inserted[0] && /参照/.test(entry.reason),
      ),
    );
    assert.ok(!overflowPreview.runIds.includes(inserted[0]!));
  } finally {
    await f.cleanup();
  }
});

test("live state is checked only for selected units and heartbeat churn stays outside the binding", async () => {
  const f = await fixture(new ScriptedRuntime(async () => completed()));
  try {
    await configFile(f);
    const closed = await terminalRun(f);
    const liveRun = await terminalRun(f);
    f.store.db
      .prepare("UPDATE runs SET heartbeat=? WHERE id=?")
      .run(Date.now(), liveRun.id);
    const conversations = new Conversations(f.store);
    const liveSession = conversations.create(f.root, {
      dataClass: "private",
      checks: [],
    });
    const preview = previewHistoryDeletion(
      f.store,
      f.config,
      {
        kind: "selection",
        conversationIds: [],
        runIds: [closed.id],
      },
      { currentSessionId: liveSession.id },
    );
    assert.deepEqual(preview.runIds, [closed.id]);
    f.store.db
      .prepare("UPDATE runs SET heartbeat=? WHERE id=?")
      .run(Date.now(), liveRun.id);
    const result = await confirmHistoryDeletion(f.store, f.config, preview, {
      currentSessionId: liveSession.id,
    });
    assert.deepEqual(result.removedRuns, [closed.id]);

    const livePreview = previewHistoryDeletion(f.store, f.config, {
      kind: "selection",
      conversationIds: [],
      runIds: [liveRun.id],
    });
    assert.match(livePreview.retained[0]?.reason ?? "", /live|lease/i);
    await assert.rejects(
      confirmHistoryDeletion(f.store, f.config, livePreview),
      /retained|references/i,
    );
    const currentPreview = previewHistoryDeletion(
      f.store,
      f.config,
      {
        kind: "selection",
        conversationIds: [liveSession.id],
        runIds: [],
      },
      { currentSessionId: liveSession.id },
    );
    assert.match(currentPreview.retained[0]?.reason ?? "", /現在の会話/);
  } finally {
    await f.cleanup();
  }
});

test("ancestor aliases are accepted but home and runs leaf symlinks are rejected", async () => {
  const f = await fixture(new ScriptedRuntime(async () => completed()));
  try {
    await configFile(f);
    const run = await terminalRun(f);
    const realParent = join(f.root, "real-parent");
    const aliasParent = join(f.root, "alias-parent");
    const realHome = join(realParent, "state");
    await mkdir(join(realHome, "runs"), { recursive: true, mode: 0o700 });
    symlinkSync(realParent, aliasParent, "dir");
    f.store.paths.home = join(aliasParent, "state");
    f.store.paths.runs = join(aliasParent, "state", "runs");
    const preview = previewHistoryDeletion(f.store, f.config, {
      kind: "selection",
      conversationIds: [],
      runIds: [run.id],
    });
    assert.deepEqual(preview.runIds, [run.id]);
    rmSync(aliasParent, { recursive: true, force: true });
    await mkdir(aliasParent, { recursive: true, mode: 0o700 });
    symlinkSync(realHome, join(aliasParent, "state"), "dir");
    assert.throws(
      () =>
        previewHistoryDeletion(f.store, f.config, {
          kind: "selection",
          conversationIds: [],
          runIds: [run.id],
        }),
      /symlink|private|unsafe/i,
    );
  } finally {
    await f.cleanup();
  }
});

test("a failed database lock does not leak the configuration lock", async () => {
  const f = await fixture(new ScriptedRuntime(async () => completed()));
  try {
    await configFile(f);
    const run = await terminalRun(f);
    const preview = previewHistoryDeletion(f.store, f.config, {
      kind: "selection",
      conversationIds: [],
      runIds: [run.id],
    });
    const releaseDatabase = await lockfile.lock(f.store.paths.database, {
      retries: 0,
      stale: 30_000,
    });
    try {
      await assert.rejects(
        confirmHistoryDeletion(f.store, f.config, preview),
        /lock|ELOCKED|already/i,
      );
    } finally {
      await releaseDatabase();
    }
    const releaseConfig = await lockfile.lock(f.store.paths.config, {
      retries: 0,
      stale: 30_000,
    });
    await releaseConfig();
  } finally {
    await f.cleanup();
  }
});

test("late references during Store.remove abort metadata deletion", async () => {
  const f = await fixture(new ScriptedRuntime(async () => completed()));
  try {
    const run = await terminalRun(f);
    const conversations = new Conversations(f.store);
    const referrer = conversations.create(f.root, {
      dataClass: "private",
      checks: [],
    });
    const removing = f.store.remove(run.id);
    await Promise.resolve();
    conversations.message(referrer, "user", `late ${run.id}`);
    conversations.release(referrer.id);
    await assert.rejects(removing, /reference|retained/i);
    assert.equal(f.store.get(run.id).id, run.id);
  } finally {
    await f.cleanup();
  }
});

test("source links, boundaries, forks, and text references delete as one closed set", async () => {
  const f = await fixture(new ScriptedRuntime(async () => completed()));
  try {
    await configFile(f);
    const conversations = new Conversations(f.store);
    const parent = conversations.create(f.root, {
      dataClass: "private",
      checks: [],
    });
    const child = conversations.create(f.root, {
      dataClass: "private",
      checks: [],
    });
    const parentRun = await terminalRun(f, parent.id);
    const childRun = await terminalRun(f, child.id);
    conversations.link(parent, parentRun);
    conversations.link(child, childRun);
    const artifactId = randomUUID();
    f.store.db
      .prepare("INSERT INTO artifacts VALUES (?,?,?)")
      .run(
        artifactId,
        parentRun.id,
        JSON.stringify({ id: artifactId, runId: parentRun.id }),
      );
    f.store.db
      .prepare("INSERT INTO source_links VALUES (?,?)")
      .run(childRun.id, artifactId);
    const parentMessage = conversations.message(
      parent,
      "user",
      `parent ${child.id}`,
      parentRun.id,
    );
    const childMessage = conversations.message(
      child,
      "user",
      `child ${parent.id} ${artifactId}`,
      childRun.id,
    );
    f.store.saveBoundary({
      id: randomUUID(),
      sessionId: child.id,
      messageSeq: childMessage,
      hash: "boundary",
      payload: "{}",
      stateAvailable: true,
      artifactIds: [artifactId],
    });
    f.store.db
      .prepare("INSERT INTO fork_lineages VALUES (?,?,?,?,?,?,?)")
      .run(
        child.id,
        parent.id,
        parentMessage,
        "history",
        null,
        "{}",
        Date.now(),
      );
    conversations.release(parent.id);
    conversations.release(child.id);
    const parentOnly = previewHistoryDeletion(f.store, f.config, {
      kind: "selection",
      conversationIds: [parent.id],
      runIds: [],
    });
    assert.equal(parentOnly.retained[0]?.id, parent.id);
    const both = previewHistoryDeletion(f.store, f.config, {
      kind: "selection",
      conversationIds: [parent.id, child.id],
      runIds: [],
    });
    const result = await confirmHistoryDeletion(f.store, f.config, both);
    assert.deepEqual(
      result.removedConversations.sort(),
      [child.id, parent.id].sort(),
    );
    assert.equal(
      (f.store.db.prepare("PRAGMA foreign_key_check").all() as unknown[])
        .length,
      0,
    );
  } finally {
    await f.cleanup();
  }
});

test("stale preview rejects changed ids, state, cutoff, and config without expanding selection", async () => {
  const f = await fixture(new ScriptedRuntime(async () => completed()));
  try {
    await configFile(f);
    const first = await terminalRun(f);
    const second = await terminalRun(f);
    for (const run of [first, second]) {
      const payload = f.store.get(run.id);
      payload.updatedAt = 1;
      f.store.db
        .prepare("UPDATE runs SET payload=? WHERE id=?")
        .run(JSON.stringify(payload), run.id);
    }
    const preview = previewHistoryDeletion(f.store, f.config, {
      kind: "retention",
      cutoff: 100,
    });
    assert.equal(preview.runIds.length, 2);
    const changedPayload = f.store.get(first.id);
    changedPayload.reason = "changed";
    f.store.db
      .prepare("UPDATE runs SET state=?,payload=? WHERE id=?")
      .run("failed", JSON.stringify(changedPayload), first.id);
    await writeFile(f.p.config, stringify({ ...f.config, retentionDays: 1 }), {
      mode: 0o600,
    });
    const tampered = {
      ...preview,
      request: { kind: "retention" as const, cutoff: 101 },
      runIds: [first.id],
    };
    await assert.rejects(
      confirmHistoryDeletion(f.store, f.config, tampered),
      /stale|changed/i,
    );
    assert.equal(f.store.get(first.id).id, first.id);
    assert.equal(f.store.get(second.id).id, second.id);
  } finally {
    await f.cleanup();
  }
});

test("rm failure persists a job across Store reopen and explicit retry", async (t) => {
  const f = await fixture(new ScriptedRuntime(async () => completed()));
  let reopened: Store | undefined;
  try {
    await configFile(f);
    const run = await terminalRun(f);
    const preview = previewHistoryDeletion(f.store, f.config, {
      kind: "selection",
      conversationIds: [],
      runIds: [run.id],
    });
    const originalRm = fsPromises.rm.bind(fsPromises);
    let calls = 0;
    t.mock.method(
      fsPromises,
      "rm",
      async (...args: Parameters<typeof fsPromises.rm>) => {
        calls++;
        if (calls === 1) throw new Error("forced rm failure");
        return Reflect.apply(originalRm, fsPromises, args);
      },
    );
    const result = await confirmHistoryDeletion(f.store, f.config, preview);
    assert.equal(result.pendingCleanup.length, 1);
    const jobId = result.pendingCleanup[0]!.id;
    f.store.close();
    reopened = new Store(f.p);
    assert.deepEqual(await retryDeletionCleanup(reopened, [jobId]), []);
  } finally {
    reopened?.close();
    if (reopened) await rm(f.root, { recursive: true, force: true });
    else await f.cleanup();
  }
});

test("malformed cleanup payloads are rejected before any retry", async () => {
  const f = await fixture(new ScriptedRuntime(async () => completed()));
  try {
    const jobId = randomUUID();
    f.store.db.prepare("INSERT INTO deletion_queue VALUES (?,?,?)").run(
      jobId,
      Date.now(),
      JSON.stringify({
        version: 1,
        runIds: [randomUUID()],
        root: { dev: "1", ino: "2" },
        directories: [],
        path: "/tmp/unsafe",
      }),
    );
    assert.throws(() => pendingDeletions(f.store), /malformed|unsafe/i);
    await assert.rejects(
      retryDeletionCleanup(f.store, [jobId]),
      /malformed|unsafe/i,
    );
  } finally {
    await f.cleanup();
  }
});
