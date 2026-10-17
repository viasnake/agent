import assert from "node:assert/strict";
import test from "node:test";
import {
  readFile,
  writeFile,
  chmod,
  lstat,
  readdir,
  rm,
  symlink,
  rename,
  mkdir,
} from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { Application } from "../src/application.js";
import {
  captureBoundary,
  persistBoundary,
  stateForBoundary,
  verifyBoundaryState,
} from "../src/branching.js";
import { canonical, sha256 } from "../src/util.js";
import { Store } from "../src/storage.js";
import { configHash, paths } from "../src/config.js";
import { DatabaseSync } from "node:sqlite";
import { storePreparedText } from "../src/documents.js";
import { saveImage } from "../src/images.js";
import { Evaluator } from "../src/validation.js";
import { Sandbox } from "../src/sandbox.js";
import { applyRun } from "../src/artifacts.js";
import { fixture, gitWorkspace, ScriptedRuntime } from "./helpers.js";

async function savedCodingBoundary() {
  const runtime = new ScriptedRuntime(async () => "unused");
  const f = await fixture(runtime);
  const origin = await gitWorkspace(f.root, { "main.txt": "baseline\n" });
  const app = new Application(
    f.config,
    f.p,
    f.store,
    origin,
    async () => runtime,
  );
  await app.initialize();
  const run = await f.harness.create({
    objective: "prepare historical copy",
    kind: "coding",
    workspace: origin,
    conversationId: app.session.id,
    access: "change",
    checks: [],
  });
  app.conversations.link(app.session, run);
  app.session.workRunId = run.id;
  await writeFile(
    join(f.store.runDir(run.id), "work/main.txt"),
    "historical change\n",
  );
  await chmod(join(f.store.runDir(run.id), "work/main.txt"), 0o755);
  await writeFile(
    join(f.store.runDir(run.id), "work/evidence.txt"),
    "historical evidence",
  );
  const owned = f.store.claim(run.id, true);
  const source = await f.store.artifact(
    owned,
    "source.txt",
    "source",
    "historical evidence",
  );
  const document = await f.store.artifact(
    owned,
    "report.md",
    "document",
    "historical document",
  );
  f.store.release(owned);
  app.session.context!.sourceIds = [source.id];
  app.session.context!.pins = [
    {
      id: "past",
      text: "historical pin",
      kind: "pin",
      author: "user",
      trusted: true,
      updatedAt: Date.now(),
    },
  ];
  const record = await captureBoundary(
    f.p,
    f.config,
    f.store,
    app.session,
    0,
    undefined,
    { visibleRunIds: [run.id] },
  );
  const seq = app.conversations.message(
    app.session,
    "assistant",
    "historical boundary",
    run.id,
  );
  persistBoundary(f.store, record, seq);
  app.save();
  return {
    ...f,
    origin,
    app,
    runtime,
    run,
    seq,
    source,
    document,
    parentId: app.session.id,
  };
}

test("state fork freezes coding bytes, modes, sources and producer state; seeds never execute", async (t) => {
  const f = await savedCodingBoundary();
  try {
    let releasedAtomically = false;
    const release = f.app.conversations.release.bind(f.app.conversations);
    t.mock.method(f.app.conversations, "release", (sessionId: string) => {
      if (sessionId === f.parentId && f.app.busy) {
        assert.equal(f.store.db.isTransaction, true);
        releasedAtomically = true;
      }
      release(sessionId);
    });
    await writeFile(
      join(f.store.runDir(f.run.id), "work/main.txt"),
      "future change\n",
    );
    const owned = f.store.claim(f.run.id, true);
    owned.state = "failed";
    f.store.save(owned, "test_future_state");
    const future = await f.store.artifact(
      owned,
      "future.txt",
      "source",
      "future source",
    );
    f.store.release(owned);
    f.app.session.context!.pins.push({
      id: "future",
      text: "future pin",
      kind: "pin",
      author: "user",
      trusted: true,
      updatedAt: Date.now(),
    });
    f.app.conversations.message(f.app.session, "user", "future message");
    const preview = await f.app.previewFork(f.seq, "state");
    await f.app.forkConversation(f.seq, "state", preview.binding);
    assert.equal(releasedAtomically, true);
    const childId = f.app.session.id;
    const seed = f.store.get(f.app.session.workRunId!);
    assert.ok(seed.forkCheckpointId);
    assert.equal(seed.conversationId, childId);
    assert.equal(seed.state, "created");
    assert.equal(seed.previousSessions, undefined);
    assert.deepEqual(seed.tasks, []);
    assert.equal(f.app.session.latestRunId, undefined);
    assert.equal(
      await readFile(join(f.store.runDir(seed.id), "work/main.txt"), "utf8"),
      "historical change\n",
    );
    assert.equal(
      (await lstat(join(f.store.runDir(seed.id), "work/main.txt"))).mode &
        0o777,
      0o755,
    );
    assert.deepEqual(
      f.app.history().map((message) => message.text),
      ["historical boundary"],
    );
    assert.deepEqual(
      f.app.session.context!.pins.map((pin) => pin.id),
      ["past"],
    );
    assert.ok(
      f.store
        .artifacts(seed.id)
        .some((artifact) => artifact.id === f.source.id),
    );
    assert.ok(
      !f.store.artifacts(seed.id).some((artifact) => artifact.id === future.id),
    );
    assert.equal(
      (await f.app.artifactHistory("report.md"))[0]!.run.state,
      "created",
    );
    assert.equal(
      await f.app.artifactText(f.document.id, f.run.id),
      "historical document",
    );
    await assert.rejects(f.app.artifactText(future.id, f.run.id), {
      code: "ARTIFACT",
    });
    const signal = new AbortController().signal;
    await assert.rejects(f.harness.execute(seed.id, signal), {
      code: "FORK_SEED",
    });
    await assert.rejects(
      new Evaluator(
        f.config,
        f.store,
        new Sandbox(f.config.execution),
      ).validate(seed, signal),
      { code: "FORK_SEED" },
    );
    await assert.rejects(applyRun(f.config, f.store, seed.id, false, signal), {
      code: "FORK_SEED",
    });
    const continued = await f.harness.create({
      objective: "continue saved code",
      kind: "coding",
      workspace: f.origin,
      parentRunId: seed.id,
      conversationId: childId,
      dataClass: f.app.session.dataClass,
      localOnly: f.app.session.localOnly,
      contextState: f.app.session.context,
      access: "change",
      checks: [],
    });
    assert.equal(
      await readFile(
        join(f.store.runDir(continued.id), "work/main.txt"),
        "utf8",
      ),
      "historical change\n",
    );
    assert.ok(
      f.store
        .artifacts(continued.id)
        .some((artifact) => artifact.id === f.source.id),
    );
    assert.equal(f.runtime.requests.length, 0);
    const nested = f.app.forkPoints().points[0]!;
    const nestedPreview = await f.app.previewFork(nested.seq, "state");
    await f.app.forkConversation(nested.seq, "state", nestedPreview.binding);
    const nestedId = f.app.session.id;
    await assert.rejects(
      f.harness.create({
        objective: "foreign sibling seed",
        kind: "coding",
        workspace: f.origin,
        parentRunId: seed.id,
        conversationId: nestedId,
        dataClass: f.app.session.dataClass,
        access: "change",
      }),
      /owned|conversation/,
    );
    await writeFile(join(f.origin, "main.txt"), "changed original\n");
    await assert.rejects(
      f.harness.create({
        objective: "conflicting continuation",
        kind: "coding",
        workspace: f.origin,
        parentRunId: f.app.session.workRunId,
        conversationId: nestedId,
        dataClass: f.app.session.dataClass,
        access: "change",
      }),
      /changed|conflict|original/i,
    );
  } finally {
    await f.app.close();
    await f.cleanup();
  }
});

test("history mode drops saved resources, keeps safety floors, and cannot resurrect checkpoints", async () => {
  const f = await savedCodingBoundary();
  try {
    const owned = f.store.claim(f.run.id, true);
    owned.dataClass = "restricted";
    owned.localOnly = true;
    f.store.save(owned, "test_policy_floor");
    f.store.release(owned);
    f.app.session.dataClass = "public";
    f.app.session.context!.excludedSourceIds = [f.source.id];
    f.app.session.context!.excludedSourceHashes = [f.source.sha256];
    f.app.session.context!.redactedImageIds = [`img-${"a".repeat(64)}`];
    const preview = await f.app.previewFork(f.seq, "history");
    assert.equal(preview.savedWorkspaceFiles, 0);
    await f.app.forkConversation(f.seq, "history", preview.binding);
    assert.equal(f.app.session.workRunId, undefined);
    assert.equal(f.app.session.documentRunId, undefined);
    assert.equal(f.app.session.dataClass, "restricted");
    assert.equal(f.app.session.localOnly, true);
    assert.deepEqual(f.app.session.context!.pins, []);
    assert.deepEqual(f.app.session.images, []);
    assert.deepEqual(f.app.session.context!.excludedSourceIds, [f.source.id]);
    assert.deepEqual(f.app.session.context!.redactedImageIds, [
      `img-${"a".repeat(64)}`,
    ]);
    assert.equal(f.app.forkPoints().points[0]!.stateAvailable, false);
    f.app.session.dataClass = "public";
    f.app.session.localOnly = false;
    await assert.rejects(
      f.harness.create({
        objective: "bypass floor",
        kind: "chat",
        conversationId: f.app.session.id,
        dataClass: "public",
      }),
      { code: "DISCLOSURE_DENIED" },
    );
    assert.equal(f.runtime.requests.length, 0);
  } finally {
    await f.app.close();
    await f.cleanup();
  }
});

test("corrupt checkpoints and stale message prefixes fail without releasing the parent", async () => {
  const f = await savedCodingBoundary();
  try {
    const row = f.store.boundary(f.parentId, f.seq)!;
    const state = stateForBoundary(row);
    const preview = await f.app.previewFork(f.seq, "state");
    const blob = join(f.p.checkpoints, "blobs", state.coding!.work[0]!.hash);
    await writeFile(blob, "corrupt");
    await assert.rejects(
      f.app.forkConversation(f.seq, "state", preview.binding),
    );
    assert.equal(f.app.busy, false);
    assert.equal(f.app.session.id, f.parentId);
    f.app.save();
    const history = await f.app.previewFork(f.seq, "history");
    f.store.db
      .prepare("UPDATE messages SET text=? WHERE seq=?")
      .run("mutated prefix", f.seq);
    await assert.rejects(
      f.app.forkConversation(f.seq, "history", history.binding),
      { code: "STALE_VIEW" },
    );
    assert.equal(f.app.session.id, f.parentId);
    assert.equal(f.app.conversations.list(f.app.session.workspace).length, 1);
    assert.equal(f.runtime.requests.length, 0);
  } finally {
    await f.app.close();
    await f.cleanup();
  }
});

test("actual chat boundaries retain images and prepared documents, not future queued attachments, across restart", async () => {
  let ready!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runtime = new ScriptedRuntime(async () => {
    ready();
    await gate;
    return "保存された資料を確認しました";
  });
  const f = await fixture(runtime);
  f.config.models.worker!.images = true;
  f.config.models.worker!.kinds.push("chat");
  let store = f.store;
  let app = new Application(f.config, f.p, store, f.root, async () => runtime);
  try {
    const imagePath = join(f.root, "visible.png"),
      futurePath = join(f.root, "future.png"),
      documentPath = join(f.root, "input.txt");
    await writeFile(
      imagePath,
      await sharp({
        create: { width: 2, height: 2, channels: 3, background: "red" },
      })
        .png()
        .toBuffer(),
    );
    await writeFile(
      futurePath,
      await sharp({
        create: { width: 2, height: 2, channels: 3, background: "blue" },
      })
        .png()
        .toBuffer(),
    );
    await writeFile(documentPath, "stable source text");
    await app.initialize();
    app.session.kind = "chat";
    app.session.access = "read-only";
    await app.submit("資料を読んでください @visible.png @input.txt");
    await started;
    const visibleImage = app.session.images![0]!;
    await app.submit("あとで確認 @future.png", "next");
    const queued = app.session.queue.find((item) =>
      item.text.includes("あとで"),
    )!;
    const futureImage = queued.images!.find(
      (image) => image.id !== visibleImage.id,
    )!;
    assert.ok(futureImage);
    app.cancelQueued(queued.id);
    release();
    await app.waitForIdle();
    const points = app.forkPoints().points;
    assert.equal(points.length, 2);
    assert.ok(points.every((point) => point.stateAvailable));
    for (const point of points) {
      const state = stateForBoundary(
        store.boundary(app.session.id, point.seq)!,
      );
      assert.deepEqual(
        state.images.map((image) => image.id),
        [visibleImage.id],
      );
      assert.equal(state.preparedInputs.length, 1);
    }
    const selected = points.find((point) => point.role === "assistant")!;
    const preview = await app.previewFork(selected.seq, "state");
    await app.forkConversation(selected.seq, "state", preview.binding);
    const childId = app.session.id;
    const seeds = app.conversations.runs(childId);
    assert.equal(seeds.length, 1);
    assert.equal(store.get(seeds[0]!).kind, "chat");
    assert.ok(store.get(seeds[0]!).forkCheckpointId);
    assert.equal(store.get(seeds[0]!).preparedInputs!.length, 1);
    assert.ok(
      store.artifacts(seeds[0]!).some((artifact) => artifact.kind === "source"),
    );
    assert.deepEqual(
      app.session.images!.map((image) => image.id),
      [visibleImage.id],
    );
    assert.ok(
      !app.session.images!.some((image) => image.id === futureImage.id),
    );
    assert.deepEqual(app.session.queue, []);
    await app.close();
    store.close();
    store = new Store(f.p);
    app = new Application(f.config, f.p, store, f.root, async () => runtime);
    await app.initialize();
    app.openSession(childId);
    assert.deepEqual(
      app.session.images!.map((image) => image.id),
      [visibleImage.id],
    );
    assert.ok(
      store.artifacts(seeds[0]!).some((artifact) => artifact.kind === "source"),
    );
    assert.equal(runtime.requests.length, 1);
  } finally {
    release();
    await app.close();
    store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("writing seed restores only the saved document tree and supports a fresh continuation", async () => {
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
    const run = await f.harness.create({
      kind: "writing",
      objective: "write",
      conversationId: app.session.id,
      access: "change",
    });
    app.conversations.link(app.session, run);
    app.session.documentRunId = run.id;
    await writeFile(
      join(f.store.runDir(run.id), "work/article.md"),
      "historical document\n",
    );
    const record = await captureBoundary(
      f.p,
      f.config,
      f.store,
      app.session,
      0,
      undefined,
      { visibleRunIds: [run.id] },
    );
    const seq = app.conversations.message(
      app.session,
      "assistant",
      "document saved",
      run.id,
    );
    persistBoundary(f.store, record, seq);
    app.save();
    await writeFile(
      join(f.store.runDir(run.id), "work/article.md"),
      "future document\n",
    );
    const preview = await app.previewFork(seq, "state");
    await app.forkConversation(seq, "state", preview.binding);
    const seed = f.store.get(app.session.documentRunId!);
    assert.ok(seed.forkCheckpointId);
    assert.equal(seed.workspace, undefined);
    assert.equal(
      await readFile(join(f.store.runDir(seed.id), "work/article.md"), "utf8"),
      "historical document\n",
    );
    const continued = await f.harness.create({
      kind: "writing",
      objective: "continue document",
      conversationId: app.session.id,
      parentRunId: seed.id,
      dataClass: app.session.dataClass,
      access: "change",
    });
    assert.equal(
      await readFile(
        join(f.store.runDir(continued.id), "work/article.md"),
        "utf8",
      ),
      "historical document\n",
    );
    await assert.rejects(app.resume(), { code: "TERMINAL_RUN" });
    assert.equal(runtime.requests.length, 0);
  } finally {
    await app.close();
    await f.cleanup();
  }
});

test("restore failure rolls back child rows and directories while retaining the parent lease", async () => {
  const f = await savedCodingBoundary();
  const create = f.store.create.bind(f.store);
  try {
    const preview = await f.app.previewFork(f.seq, "state");
    const before = await readdir(f.p.runs);
    const checkpoint = join(f.p.checkpoints, "blobs");
    f.store.create = (run) => {
      create(run);
      if (run.forkCheckpointId)
        throw new Error("simulated failure after allocating seed");
    };
    await assert.rejects(
      f.app.forkConversation(f.seq, "state", preview.binding),
      /simulated failure/,
    );
    assert.equal(f.app.session.id, f.parentId);
    assert.equal(f.app.busy, false);
    assert.equal(f.app.conversations.list(f.app.session.workspace).length, 1);
    assert.deepEqual(await readdir(f.p.runs), before);
    assert.equal(
      (
        f.store.db.prepare("SELECT COUNT(*) AS n FROM fork_lineages").get() as {
          n: number;
        }
      ).n,
      0,
    );
    f.app.save();
    await rename(checkpoint, `${checkpoint}-original`);
    await symlink(`${checkpoint}-original`, checkpoint, "dir");
    await assert.rejects(f.app.previewFork(f.seq, "state"));
    await rm(checkpoint);
    await rename(`${checkpoint}-original`, checkpoint);
    const row = f.store.boundary(f.parentId, f.seq)!;
    const state = stateForBoundary(row);
    await assert.rejects(
      verifyBoundaryState(f.p, f.config, state, f.app.session.workspace, 0),
      { code: "FORK_TIMEOUT" },
    );
    for (const mutate of [
      (candidate: typeof state) => {
        candidate.coding!.work[0]!.path = "../outside";
      },
      (candidate: typeof state) => {
        candidate.coding!.work[0]!.bytes =
          f.config.limits.maxWorkspaceBytes + 1;
      },
    ]) {
      const candidate = structuredClone(state);
      mutate(candidate);
      const payload = canonical(candidate);
      f.store.db
        .prepare("UPDATE boundaries SET payload=?,hash=? WHERE id=?")
        .run(payload, sha256(payload), row.id);
      await assert.rejects(f.app.previewFork(f.seq, "state"));
    }
  } finally {
    f.store.create = create;
    await f.app.close();
    await f.cleanup();
  }
});

test("v2 storage migrates without fabricating boundaries; retained artifacts block deletion before files", async () => {
  const f = await savedCodingBoundary();
  try {
    f.store.db
      .prepare("DELETE FROM conversation_runs WHERE run_id=?")
      .run(f.run.id);
    f.store.db
      .prepare("UPDATE messages SET run_id=NULL WHERE run_id=?")
      .run(f.run.id);
    await assert.rejects(
      f.store.remove(f.run.id),
      /checkpoint|boundary|retained|保存/i,
    );
    assert.equal(
      await readFile(join(f.store.runDir(f.run.id), "work/main.txt"), "utf8"),
      "historical change\n",
    );
    const legacyPaths = paths(join(f.root, "legacy"));
    await mkdir(legacyPaths.home, { mode: 0o700 });
    const legacy = new DatabaseSync(legacyPaths.database);
    legacy.exec("PRAGMA user_version=2");
    legacy.close();
    await chmod(legacyPaths.database, 0o600);
    const migrated = new Store(legacyPaths);
    try {
      assert.equal(
        (
          migrated.db.prepare("PRAGMA user_version").get() as {
            user_version: number;
          }
        ).user_version,
        4,
      );
      assert.equal(
        (
          migrated.db.prepare("SELECT COUNT(*) AS n FROM boundaries").get() as {
            n: number;
          }
        ).n,
        0,
      );
      assert.ok(
        (await readdir(legacyPaths.home)).some(
          (name) => name.includes(".v2-") && name.endsWith(".bak"),
        ),
      );
    } finally {
      migrated.close();
    }
  } finally {
    await f.app.close();
    await f.cleanup();
  }
});

test("exclusions introduced after a checkpoint remove restored evidence from continuation inputs and work", async () => {
  const f = await savedCodingBoundary();
  try {
    const exclusion = await f.app.previewSourceExclusion(f.source.id);
    await f.app.excludeSource(f.source.id, exclusion.binding);
    const preview = await f.app.previewFork(f.seq, "state");
    await f.app.forkConversation(f.seq, "state", preview.binding);
    const seed = f.store.get(f.app.session.workRunId!);
    await assert.rejects(
      readFile(join(f.store.runDir(seed.id), "work/evidence.txt")),
      { code: "ENOENT" },
    );
    const continued = await f.harness.create({
      kind: "coding",
      objective: "fresh continuation",
      workspace: f.origin,
      conversationId: f.app.session.id,
      parentRunId: seed.id,
      dataClass: f.app.session.dataClass,
      contextState: f.app.session.context,
      access: "change",
      sourceRunIds: [seed.id],
    });
    assert.ok(
      !f.store
        .artifacts(continued.id)
        .some((artifact) => artifact.id === f.source.id),
    );
    await assert.rejects(
      readFile(join(f.store.runDir(continued.id), "work/evidence.txt")),
      { code: "ENOENT" },
    );
    assert.equal(f.runtime.requests.length, 0);
  } finally {
    await f.app.close();
    await f.cleanup();
  }
});

test("applied system boundaries use the applied baseline including newly created extra files", async () => {
  const f = await savedCodingBoundary();
  try {
    f.config.checks.fixture = { command: "fixture-check", protectedPaths: [] };
    const owned = f.store.claim(f.run.id, true);
    owned.checks = ["fixture"];
    owned.configHash = configHash(f.config);
    const sandbox = new Sandbox(f.config.execution);
    sandbox.execute = async () => ({
      code: 0,
      stdout: "fixture",
      stderr: "",
      truncated: false,
    });
    const checks = await new Evaluator(f.config, f.store, sandbox).validate(
      owned,
      new AbortController().signal,
    );
    assert.ok(checks.every((check) => check.passed));
    owned.state = "succeeded";
    f.store.save(owned, "fixture_validated");
    f.store.release(owned);
    const diff = await f.app.diff();
    assert.equal(diff.applicable, true);
    await f.app.apply(diff.token);
    const point = f.app
      .forkPoints()
      .points.find((item) => item.role === "system")!;
    assert.equal(point.stateAvailable, true, point.unavailableReason);
    const state = stateForBoundary(f.store.boundary(f.parentId, point.seq)!);
    assert.deepEqual(state.coding!.baseline, state.coding!.work);
    assert.ok(state.coding!.extraPaths!.includes("evidence.txt"));
    await writeFile(
      join(f.store.runDir(f.run.id), "work/main.txt"),
      "mutated prior private copy\n",
    );
    const preview = await f.app.previewFork(point.seq, "state");
    await f.app.forkConversation(point.seq, "state", preview.binding);
    const seed = f.store.get(f.app.session.workRunId!);
    assert.equal(
      await readFile(
        join(f.store.runDir(seed.id), "baseline/main.txt"),
        "utf8",
      ),
      "historical change\n",
    );
    assert.equal(
      await readFile(
        join(f.store.runDir(seed.id), "work/evidence.txt"),
        "utf8",
      ),
      "historical evidence",
    );
    assert.deepEqual(f.store.operations(seed.id), []);
    assert.equal((await f.app.diff()).applicable, false);
    assert.equal(f.runtime.requests.length, 0);
  } finally {
    await f.app.close();
    await f.cleanup();
  }
});

test("branched PDF source families retain non-visible page associations and exclusions through a nested fork", async () => {
  const runtime = new ScriptedRuntime(async () => "unused");
  const f = await fixture(runtime);
  f.config.models.worker!.images = true;
  f.config.models.worker!.kinds.push("chat");
  const app = new Application(
    f.config,
    f.p,
    f.store,
    f.root,
    async () => runtime,
  );
  try {
    await app.initialize();
    const raw = Buffer.from("%PDF-family-fixture\nPage one\nPage two\n");
    const prepared = await Promise.all(
      [1, 2].map((page) =>
        storePreparedText(
          f.p,
          "report.pdf",
          "pdf",
          `pages=${page}`,
          raw,
          `Selected PDF page ${page}\n`,
          `page ${page}`,
          false,
        ),
      ),
    );
    const images = await Promise.all(
      prepared.map(async ({ reference }, index) => ({
        ...(await saveImage(
          f.p,
          `page-${index + 1}.png`,
          await sharp({
            create: {
              width: 2,
              height: 2,
              channels: 3,
              background: index ? "blue" : "red",
            },
          })
            .png()
            .toBuffer(),
          "private",
          false,
        )),
        documentId: reference.id,
      })),
    );
    for (const [index, input] of prepared.entries()) {
      input.reference.imageIds = [images[index]!.id];
      input.images = [images[index]!];
    }
    const original = await f.harness.create({
      kind: "chat",
      objective: "PDF fixture",
      access: "read-only",
      conversationId: app.session.id,
      images,
      preparedInputs: prepared,
    });
    app.conversations.link(app.session, original);
    app.conversations.message(app.session, "user", "PDF pages", original.id);
    const visible = await f.harness.create({
      kind: "chat",
      objective: "show first page only",
      access: "read-only",
      conversationId: app.session.id,
      sourceRunIds: [original.id],
      images: [images[0]!],
    });
    app.conversations.link(app.session, visible);
    app.session.images = [images[0]!];
    const sources = f.store
      .artifacts(original.id)
      .filter((artifact) => artifact.kind === "source");
    assert.equal(sources.length, 2);
    app.session.context!.sourceIds = sources.map((artifact) => artifact.id);
    const record = await captureBoundary(
      f.p,
      f.config,
      f.store,
      app.session,
      0,
      undefined,
      { visibleRunIds: [visible.id] },
    );
    const seq = app.conversations.message(
      app.session,
      "assistant",
      "first page",
      visible.id,
    );
    persistBoundary(f.store, record, seq);
    app.save();
    const preview = await app.previewFork(seq, "state");
    await app.forkConversation(seq, "state", preview.binding);
    assert.deepEqual(
      app.session.images!.map((image) => image.id),
      [images[0]!.id],
    );
    const search = await app.search({
      kind: "artifacts",
      text: "Selected PDF page",
      conversationId: app.session.id,
    });
    assert.equal(search.hits.length, 2);
    assert.match(
      (await app.readSearchResult(search.hits[0]!)).text,
      /Selected PDF page/,
    );
    const family = await app.previewSourceExclusion(sources[0]!.id);
    assert.ok(family.family.sourceIds.includes(sources[1]!.id));
    assert.ok(family.family.imageIds.includes(images[1]!.id));
    await app.excludeSource(sources[0]!.id, family.binding);
    const point = app.forkPoints().points[0]!;
    const nested = await app.previewFork(point.seq, "state");
    await app.forkConversation(point.seq, "state", nested.binding);
    assert.deepEqual(app.session.images, []);
    assert.ok(app.session.context!.redactedImageIds!.includes(images[1]!.id));
    const seedIds = app.conversations.runs(app.session.id);
    const continued = await f.harness.create({
      kind: "chat",
      objective: "continue without PDF",
      access: "read-only",
      conversationId: app.session.id,
      dataClass: app.session.dataClass,
      contextState: app.session.context,
      sourceRunIds: seedIds,
    });
    assert.ok(
      !f.store
        .artifacts(continued.id)
        .some((artifact) => artifact.kind === "source"),
    );
    assert.equal(runtime.requests.length, 0);
  } finally {
    await app.close();
    await f.cleanup();
  }
});

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
