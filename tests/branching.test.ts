import assert from "node:assert/strict";
import test from "node:test";
import { Application } from "../src/application.js";
import { fixture, ScriptedRuntime } from "./helpers.js";

test("captures user and assistant boundaries and forks without runtime work", async () => {
  const runtime = new ScriptedRuntime(async () => "応答");
  const f = await fixture(runtime);
  const app = new Application(
    f.config,
    f.p,
    f.store,
    f.root,
    async () => runtime,
  );
  try {
    await app.initialize();
    await app.submit("最初の質問");
    await app.waitForIdle();
    const parentId = app.session.id;
    const points = app.forkPoints();
    assert.equal(points.points.length, 2);
    const selected = points.points.find((point) => point.role === "user")!;
    assert.equal(selected.stateAvailable, true);
    const preview = await app.previewFork(selected.seq, "state");
    assert.equal(preview.messageCount, 1);
    const requests = runtime.requests.length;
    await app.forkConversation(selected.seq, "state", preview.binding);
    assert.notEqual(app.session.id, parentId);
    const seedIds = [app.session.workRunId, app.session.documentRunId].filter(
      (value): value is string => !!value,
    );
    assert.ok(seedIds.every((runId) => f.store.get(runId).forkCheckpointId));
    assert.equal(runtime.requests.length, requests);
    assert.deepEqual(
      app.conversations
        .messages(app.session.id)
        .map((message) => [message.role, message.text]),
      [["user", "最初の質問"]],
    );
    const nested = app.forkPoints().points[0]!;
    const nestedPreview = await app.previewFork(nested.seq, "history");
    await app.forkConversation(nested.seq, "history", nestedPreview.binding);
    assert.equal(runtime.requests.length, requests);
    assert.equal(app.session.workRunId, undefined);
    assert.equal(app.session.documentRunId, undefined);
    assert.equal(app.session.context?.sourceIds.length, 0);
  } finally {
    await app.close();
    await f.cleanup();
  }
});

test("legacy messages are explicitly history-only", async () => {
  const runtime = new ScriptedRuntime(async () => "unused");
  const f = await fixture(runtime);
  const app = new Application(
    f.config,
    f.p,
    f.store,
    f.root,
    async () => runtime,
  );
  try {
    await app.initialize();
    const seq = app.conversations.message(app.session, "user", "legacy");
    const point = app.forkPoints().points.find((item) => item.seq === seq)!;
    assert.equal(point.stateAvailable, false);
    assert.match(point.unavailableReason!, /保存状態/);
    await assert.rejects(app.previewFork(seq, "state"), /保存状態|復元/);
    const preview = await app.previewFork(seq, "history");
    await app.forkConversation(seq, "history", preview.binding);
    assert.equal(runtime.requests.length, 0);
  } finally {
    await app.close();
    await f.cleanup();
  }
});
