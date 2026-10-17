import assert from "node:assert/strict";
import test from "node:test";
import { Application } from "../src/application.js";
import { taskModelCandidates } from "../src/model-change.js";
import { Sandbox } from "../src/sandbox.js";
import { Store } from "../src/storage.js";
import { sha256 } from "../src/util.js";
import {
  fixture,
  ScriptedRuntime,
  testConfig,
  completed,
  call,
  gitWorkspace,
} from "./helpers.js";
import { AgentError, type Artifact, type Run } from "../src/types.js";

async function blockedReviewedChat(config = testConfig()) {
  const runtime = new ScriptedRuntime(async () => {
    throw new AgentError("AUTH", "synthetic provider authorization failure");
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
  app.session.access = "read-only";
  await app.submit("Summarize the request without changing files");
  await app.waitForIdle();
  assert.equal(app.currentRun()?.state, "waiting_input");
  return { f, app, runtime, workspace };
}

function persistRun(store: Store, run: Run): void {
  store.db
    .prepare("UPDATE runs SET payload=? WHERE id=?")
    .run(JSON.stringify(run), run.id);
}

test("real AUTH waiting supports exact request-boundary replacement and explicit resume", async () => {
  const config = testConfig();
  config.limits.maxRepairs = 0;
  config.limits.maxRequests = 4;
  config.models.worker2 = {
    ...config.models.worker!,
    id: "worker-fixture-2",
  };
  config.models.worker3 = {
    ...config.models.worker!,
    id: "worker-fixture-3",
  };
  let failed = true;
  const runtime = new ScriptedRuntime(async (request) => {
    if (failed) {
      failed = false;
      throw new AgentError("AUTH", "synthetic provider authorization failure");
    }
    return completed([], `${request.model} completed`);
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
  let appClosed = false;
  try {
    await app.initialize();
    app.session.kind = "chat";
    app.session.strategy = "reviewed";
    app.session.access = "read-only";
    await app.submit("Summarize the request without changing files");
    await app.waitForIdle();
    const waiting = app.currentRun()!;
    assert.equal(waiting.state, "waiting_input");
    assert.equal(runtime.requests.length, 1);
    const task = waiting.tasks.find((candidate) => candidate.id === "work")!;
    const attempts = task.attempts;
    const elapsedMs = waiting.elapsedMs;
    const repairAttempts = waiting.repairAttempts;
    const priorReportIds = f.store
      .artifacts(waiting.id)
      .filter((artifact) => artifact.kind === "report")
      .map((artifact) => artifact.id);
    const usageBefore = f.store.usage(waiting.id);
    const events: string[] = [];
    app.on("event", (event) => events.push(event.type));
    const first = app.previewTaskModelChange(task.id, "worker2");
    await app.confirmTaskModelChange(first);
    const afterFirst = app.currentRun()!;
    assert.equal(runtime.requests.length, 1);
    assert.equal(
      afterFirst.tasks.find((candidate) => candidate.id === task.id)?.model,
      "worker2",
    );
    assert.equal(
      afterFirst.tasks.find((candidate) => candidate.id === task.id)?.attempts,
      attempts,
    );
    assert.equal(afterFirst.elapsedMs, elapsedMs);
    assert.equal(afterFirst.repairAttempts, repairAttempts);
    for (const reportId of priorReportIds)
      assert.ok(
        f.store.artifacts(afterFirst.id).some(({ id }) => id === reportId),
      );
    assert.deepEqual(f.store.usage(afterFirst.id), usageBefore);
    assert.equal(afterFirst.modelChanges?.length, 1);
    assert.ok(events.includes("changed"));

    const second = app.previewTaskModelChange(task.id, "worker3");
    await app.confirmTaskModelChange(second);
    const afterSecond = app.currentRun()!;
    assert.equal(
      afterSecond.tasks.find((candidate) => candidate.id === task.id)?.model,
      "worker3",
    );
    assert.equal(afterSecond.modelChanges?.length, 2);
    assert.equal(afterSecond.elapsedMs, elapsedMs);
    assert.equal(afterSecond.repairAttempts, repairAttempts);
    for (const reportId of priorReportIds)
      assert.ok(
        f.store.artifacts(afterSecond.id).some(({ id }) => id === reportId),
      );
    assert.deepEqual(f.store.usage(afterSecond.id), usageBefore);
    await assert.rejects(
      app.confirmTaskModelChange(first),
      (error: unknown) =>
        error instanceof AgentError && error.code === "STALE_MODEL_CHANGE",
    );
    assert.equal(app.currentRun()?.modelChanges?.length, 2);

    const sessionId = app.session.id;
    await app.close();
    appClosed = true;
    const reopened = new Application(
      config,
      f.p,
      f.store,
      workspace,
      async () => runtime,
    );
    try {
      await reopened.initialize();
      reopened.openSession(sessionId);
      assert.equal(
        reopened
          .currentRun()
          ?.tasks.find((candidate) => candidate.id === task.id)?.model,
        "worker3",
      );
      await reopened.resume();
      await reopened.waitForIdle();
      const completedRun = reopened.currentRun()!;
      assert.equal(completedRun.state, "succeeded", completedRun.reason);
      assert.equal(runtime.requests.length, 4);
      assert.deepEqual(
        runtime.requests.slice(1).map((request) => request.model),
        ["worker3", "reviewer", "worker"],
      );
      const resolution = f.store
        .artifacts(completedRun.id)
        .find(
          (artifact) =>
            artifact.metadata.type === "task-model-change-resolution",
        );
      assert.ok(resolution);
      assert.equal(
        completedRun.modelChanges?.at(-1)?.resolutionReportId,
        resolution.id,
      );
      const reopenedStore = new Store(f.p);
      try {
        assert.equal(
          reopenedStore.get(completedRun.id).modelChanges?.at(-1)
            ?.resolutionReportId,
          resolution.id,
        );
      } finally {
        reopenedStore.close();
      }
      const evidence = JSON.parse(
        (await f.store.content(resolution!)).toString(),
      );
      assert.equal(evidence.checks, "not-run-read-only");
      assert.equal(evidence.semanticEquivalence, "not-established");
      assert.ok(evidence.currentResultReportIds.length > 0);
    } finally {
      await reopened.close();
    }
  } finally {
    if (!appClosed) await app.close();
    await f.cleanup();
  }
});

test("replacement invalidates the dependent graph, preserves readers, and requires delegated workspace tools", async () => {
  const config = testConfig();
  config.models.worker2 = {
    ...config.models.worker!,
    id: "worker-fixture-2",
  };
  config.models.workerNoTools = {
    ...config.models.worker!,
    id: "worker-fixture-no-tools",
    tools: false,
  };
  config.models.workerCollision = {
    ...config.models.worker!,
    id: "worker-fixture",
  };
  config.models.reviewerAlias = {
    ...config.models.reviewer!,
    id: "reviewer-fixture",
  };
  const { f, app, workspace } = await blockedReviewedChat(config);
  try {
    const run = app.currentRun()!;
    const work = run.tasks.find((task) => task.id === "work")!;
    const review = run.tasks.find((task) => task.id === "review")!;
    const synthesis = run.tasks.find((task) => task.purpose === "synthesis")!;
    const child = {
      ...work,
      id: "child",
      objective: "Inspect the assigned evidence",
      dependsOn: ["work"],
      delegatedBy: work.id,
      state: "succeeded" as const,
      attempts: 1,
      result: {
        outcome: "completed" as const,
        summary: "old child result",
        artifacts: [],
        unresolved: [],
      },
    };
    review.dependsOn = [child.id];
    synthesis.dependsOn = [review.id];
    for (const task of [work, review, synthesis]) {
      task.state = "succeeded";
      task.attempts = 1;
      task.result = {
        outcome: "completed",
        summary: `old ${task.id} result`,
        artifacts: [],
        unresolved: [],
      };
    }
    const reader = {
      ...work,
      id: "reader",
      dependsOn: [],
      state: "succeeded" as const,
      attempts: 1,
      result: {
        outcome: "completed" as const,
        summary: "independent reader result",
        artifacts: [],
        unresolved: [],
      },
    };
    run.tasks = [work, child, review, synthesis, reader];
    run.workspace = workspace;
    persistRun(f.store, run);
    const candidateAliases = taskModelCandidates(
      f.store,
      config,
      f.store.get(run.id),
      child.id,
    ).map((candidate) => candidate.alias);
    assert.ok(candidateAliases.includes("worker2"));
    assert.ok(!candidateAliases.includes("workerNoTools"));
    assert.ok(!candidateAliases.includes("workerCollision"));
    assert.deepEqual(
      app.taskModelCandidates(review.id).map((candidate) => candidate.alias),
      [],
    );
    assert.throws(
      () => app.previewTaskModelChange(review.id, "reviewerAlias"),
      (error: unknown) =>
        error instanceof AgentError && error.code === "NO_MODEL",
    );
    const preview = app.previewTaskModelChange(work.id, "worker2");
    assert.deepEqual(
      new Set(preview.affectedTaskIds),
      new Set(["work", "child", "review", synthesis.id]),
    );
    await app.confirmTaskModelChange(preview);
    const changed = app.currentRun()!;
    assert.equal(
      changed.tasks.find((task) => task.id === "reader")?.state,
      "succeeded",
    );
    assert.equal(
      changed.tasks.find((task) => task.id === "reader")?.model,
      "worker",
    );
    assert.equal(
      changed.tasks.find((task) => task.id === "work")?.model,
      "worker2",
    );
    for (const id of ["child", "review", synthesis.id])
      assert.equal(
        changed.tasks.find((task) => task.id === id)?.state,
        "pending",
      );
    const reportArtifact = f.store
      .artifacts(changed.id)
      .find((artifact) => artifact.metadata.type === "task-model-change");
    assert.ok(reportArtifact);
    const report = JSON.parse(
      (await f.store.content(reportArtifact!)).toString(),
    );
    assert.equal(
      report.priorTasks.find((task: Run["tasks"][number]) => task.id === "work")
        .result.summary,
      "old work result",
    );
    assert.equal(report.fromDestination.modelId, "worker-fixture");
    assert.equal(report.toDestination.modelId, "worker-fixture-2");
    assert.ok(report.preserved.policy);
  } finally {
    await app.close();
    await f.cleanup();
  }
});

test("oversized evidence releases the lease and asynchronous authorization rejects stale state", async (t) => {
  const config = testConfig();
  config.limits.maxFileBytes = 1000;
  config.models.worker2 = {
    ...config.models.worker!,
    id: "worker-fixture-2",
  };
  const { f, app } = await blockedReviewedChat(config);
  try {
    const run = app.currentRun()!;
    const task = run.tasks.find((candidate) => candidate.id === "work")!;
    task.objective = "x".repeat(5000);
    persistRun(f.store, run);
    const preview = app.previewTaskModelChange(task.id, "worker2");
    await assert.rejects(
      app.confirmTaskModelChange(preview),
      (error: unknown) =>
        error instanceof AgentError && error.code === "REPORT_SIZE",
    );
    const oversized = f.store.get(run.id);
    assert.equal(
      oversized.tasks.find((candidate) => candidate.id === task.id)?.model,
      "worker",
    );
    assert.equal(oversized.modelChanges?.length ?? 0, 0);
    f.store.assertIdle(run.id);

    const normalConfig = testConfig();
    normalConfig.models.worker2 = {
      ...normalConfig.models.worker!,
      id: "worker-fixture-2",
    };
    const second = await blockedReviewedChat(normalConfig);
    try {
      const secondRun = second.app.currentRun()!;
      const secondTask = secondRun.tasks.find(
        (candidate) => candidate.id === "work",
      )!;
      const secondPreview = second.app.previewTaskModelChange(
        secondTask.id,
        "worker2",
      );
      const originalArtifact = second.f.store.artifact.bind(second.f.store);
      t.mock.method(
        second.f.store,
        "artifact",
        async (
          owned: Run,
          name: string,
          kind: Artifact["kind"],
          content: string | Buffer,
          metadata: Record<string, unknown>,
          commit?: (artifact: Artifact) => void,
        ) => {
          const mutated = second.f.store.get(owned.id);
          mutated.reason = "authoritative external mutation";
          persistRun(second.f.store, mutated);
          await new Promise((resolve) => setTimeout(resolve, 1100));
          return originalArtifact(owned, name, kind, content, metadata, commit);
        },
      );
      await assert.rejects(
        second.app.confirmTaskModelChange(secondPreview),
        (error: unknown) =>
          error instanceof AgentError && error.code === "STALE_MODEL_CHANGE",
      );
      assert.equal(
        second.f.store.get(secondRun.id).reason,
        "authoritative external mutation",
      );
      assert.equal(
        second.f.store.get(secondRun.id).modelChanges?.length ?? 0,
        0,
      );
      assert.equal(
        second.f.store
          .get(secondRun.id)
          .tasks.find((candidate) => candidate.id === secondTask.id)?.model,
        "worker",
      );
      second.f.store.assertIdle(secondRun.id);
    } finally {
      await second.app.close();
      await second.f.cleanup();
    }
    const cancelled = await blockedReviewedChat(normalConfig);
    try {
      const cancelledRun = cancelled.app.currentRun()!;
      const cancelledTask = cancelledRun.tasks.find(
        (candidate) => candidate.id === "work",
      )!;
      const cancelledPreview = cancelled.app.previewTaskModelChange(
        cancelledTask.id,
        "worker2",
      );
      const originalArtifact = cancelled.f.store.artifact.bind(
        cancelled.f.store,
      );
      t.mock.method(
        cancelled.f.store,
        "artifact",
        async (
          owned: Run,
          name: string,
          kind: Artifact["kind"],
          content: string | Buffer,
          metadata: Record<string, unknown>,
          commit?: (artifact: Artifact) => void,
        ) => {
          cancelled.f.store.cancel(owned.id);
          await new Promise((resolve) => setTimeout(resolve, 1100));
          return originalArtifact(owned, name, kind, content, metadata, commit);
        },
      );
      await assert.rejects(
        cancelled.app.confirmTaskModelChange(cancelledPreview),
        (error: unknown) =>
          error instanceof AgentError && error.code === "CANCELLED",
      );
      assert.equal(
        cancelled.f.store.get(cancelledRun.id).modelChanges?.length ?? 0,
        0,
      );
      assert.equal(
        cancelled.f.store
          .get(cancelledRun.id)
          .tasks.find((candidate) => candidate.id === cancelledTask.id)?.model,
        "worker",
      );
      cancelled.f.store.assertIdle(cancelledRun.id);
    } finally {
      await cancelled.app.close();
      await cancelled.f.cleanup();
    }
  } finally {
    await app.close();
    await f.cleanup();
  }
});

test("candidate authorization is repeated after artifact work and live leases are rejected", async (t) => {
  const config = testConfig();
  config.connections.remote = {
    type: "compatible",
    enabled: true,
    account: "fixture",
    billing: "subscription",
    maxRequestUsd: 0,
    allowedData: ["public", "private", "restricted"],
    secretEnv: "MODEL_CHANGE_FAKE_TOKEN",
    endpoint: "https://example.invalid/v1",
    requestsPerMinute: 60,
  };
  config.connections.publicRemote = {
    ...config.connections.remote,
    allowedData: ["public"],
  };
  config.connections.imageRemote = {
    ...config.connections.remote,
    allowedData: ["public", "private", "restricted"],
  };
  config.models.worker = {
    ...config.models.worker!,
    connection: "remote",
    id: "remote-worker",
  };
  config.models.worker2 = {
    ...config.models.worker!,
    id: "remote-worker-2",
  };
  config.models.workerPublic = {
    ...config.models.worker!,
    connection: "publicRemote",
    id: "public-worker",
  };
  config.models.workerImage = {
    ...config.models.worker!,
    connection: "imageRemote",
    id: "image-worker",
    images: true,
  };
  config.models.workerLocal = {
    ...config.models.worker!,
    connection: "local",
    id: "local-worker",
  };
  process.env.MODEL_CHANGE_FAKE_TOKEN = "synthetic";
  const { f, app } = await blockedReviewedChat(config);
  try {
    const run = app.currentRun()!;
    const task = run.tasks.find((candidate) => candidate.id === "work")!;
    const filteredByData = app
      .taskModelCandidates(task.id)
      .map((candidate) => candidate.alias);
    assert.ok(!filteredByData.includes("workerPublic"));
    const localRun = f.store.get(run.id);
    localRun.localOnly = true;
    persistRun(f.store, localRun);
    const localOnlyCandidates = app
      .taskModelCandidates(task.id)
      .map((candidate) => candidate.alias);
    assert.ok(localOnlyCandidates.includes("workerLocal"));
    assert.ok(!localOnlyCandidates.includes("worker2"));
    localRun.localOnly = false;
    localRun.images = [
      {
        id: "synthetic-image",
        name: "fixture.png",
        mimeType: "image/png",
        width: 1,
        height: 1,
        bytes: 1,
        sha256: "0".repeat(64),
        dataClass: "private",
        localOnly: false,
      },
    ];
    persistRun(f.store, localRun);
    const imageCandidates = app
      .taskModelCandidates(task.id)
      .map((candidate) => candidate.alias);
    assert.ok(imageCandidates.includes("workerImage"));
    assert.ok(!imageCandidates.includes("worker2"));
    localRun.images = [];
    persistRun(f.store, localRun);
    for (const status of ["prepared", "dispatched", "unknown"] as const) {
      const operationLease = f.store.claim(run.id);
      const operationId = f.store.prepare(
        operationLease,
        task.id,
        `synthetic-${status}`,
        {},
      );
      if (status !== "prepared")
        f.store.operation(operationLease, operationId, status);
      f.store.release(operationLease);
      assert.throws(
        () => app.taskModelCandidates(task.id),
        (error: unknown) =>
          error instanceof AgentError && error.code === "OPERATION",
      );
      f.store.db
        .prepare("UPDATE operations SET status='completed' WHERE id=?")
        .run(operationId);
    }
    const configMaxRequests = config.limits.maxRequests;
    config.limits.maxRequests++;
    assert.throws(
      () => app.taskModelCandidates(task.id),
      (error: unknown) =>
        error instanceof AgentError && error.code === "POLICY_CHANGED",
    );
    config.limits.maxRequests = configMaxRequests;
    const sourceRun = f.store.get(run.id);
    assert.ok(sourceRun.contextState);
    sourceRun.contextState.excludedSourceIds = ["synthetic-excluded-source"];
    persistRun(f.store, sourceRun);
    assert.throws(
      () => app.taskModelCandidates(task.id),
      (error: unknown) =>
        error instanceof AgentError && error.code === "SOURCE_EXCLUDED",
    );
    sourceRun.contextState.excludedSourceIds = [];
    persistRun(f.store, sourceRun);
    const sessionPreview = app.previewTaskModelChange(task.id, "worker2");
    app.session.access = "change";
    await assert.rejects(
      app.confirmTaskModelChange(sessionPreview),
      (error: unknown) =>
        error instanceof AgentError && error.code === "STALE_MODEL_CHANGE",
    );
    app.session.access = "read-only";
    const generationPreview = app.previewTaskModelChange(task.id, "worker2");
    f.store.db
      .prepare("UPDATE runs SET generation=generation+1 WHERE id=?")
      .run(run.id);
    await assert.rejects(
      app.confirmTaskModelChange(generationPreview),
      (error: unknown) =>
        error instanceof AgentError && error.code === "STALE_MODEL_CHANGE",
    );
    const leased = f.store.claim(run.id);
    assert.throws(
      () => app.taskModelCandidates(task.id),
      (error: unknown) =>
        error instanceof AgentError && error.code === "RUN_BUSY",
    );
    assert.throws(
      () => app.previewTaskModelChange(task.id, "worker2"),
      (error: unknown) =>
        error instanceof AgentError && error.code === "RUN_BUSY",
    );
    f.store.release(leased);
    const preview = app.previewTaskModelChange(task.id, "worker2");
    const originalArtifact = f.store.artifact.bind(f.store);
    t.mock.method(
      f.store,
      "artifact",
      async (
        owned: Run,
        name: string,
        kind: Artifact["kind"],
        content: string | Buffer,
        metadata: Record<string, unknown>,
        commit?: (artifact: Artifact) => void,
      ) => {
        await new Promise((resolve) => setTimeout(resolve, 1100));
        delete process.env.MODEL_CHANGE_FAKE_TOKEN;
        return originalArtifact(owned, name, kind, content, metadata, commit);
      },
    );
    await assert.rejects(
      app.confirmTaskModelChange(preview),
      (error: unknown) =>
        error instanceof AgentError && error.code === "NO_MODEL",
    );
    assert.equal(f.store.get(run.id).modelChanges?.length ?? 0, 0);
    assert.equal(
      f.store.get(run.id).tasks.find((candidate) => candidate.id === task.id)
        ?.model,
      "worker",
    );
    f.store.assertIdle(run.id);
  } finally {
    delete process.env.MODEL_CHANGE_FAKE_TOKEN;
    await app.close();
    await f.cleanup();
  }
});

test("mutable replacement records only fresh passing checks and no failed resolution", async (t) => {
  let validationPasses = true;
  let checkCount = 0;
  t.mock.method(Sandbox.prototype, "probe", async () => ({
    ok: true,
    detail: "synthetic sandbox",
  }));
  t.mock.method(Sandbox.prototype, "execute", async () => {
    checkCount++;
    return {
      code: validationPasses ? 0 : 1,
      stdout: "synthetic check",
      stderr: "",
      truncated: false,
    };
  });

  async function runScenario(passes: boolean) {
    validationPasses = passes;
    const checksBefore = checkCount;
    const config = testConfig();
    config.limits.maxRepairs = 0;
    config.checks = {
      unit: { command: "test -f app.txt", protectedPaths: [] },
    };
    config.models.worker2 = {
      ...config.models.worker!,
      id: "worker-fixture-2",
    };
    let firstRequest = true;
    const runtime = new ScriptedRuntime(async (request) => {
      if (firstRequest) {
        firstRequest = false;
        throw new AgentError(
          "AUTH",
          "synthetic provider authorization failure",
        );
      }
      assert.equal(request.model, "worker2");
      await call(request, "write_file", {
        path: "app.txt",
        content: "changed\n",
        expectedSha256: sha256("baseline\n"),
      });
      return completed(["app.txt"], "synthetic change");
    });
    const f = await fixture(runtime, config);
    const workspace = await gitWorkspace(f.root, { "app.txt": "baseline\n" });
    const app = new Application(
      config,
      f.p,
      f.store,
      workspace,
      async () => runtime,
    );
    try {
      await app.initialize();
      app.session.kind = "coding";
      app.session.access = "change";
      await app.submit("fix app.txt");
      await app.waitForIdle();
      const waiting = app.currentRun()!;
      assert.equal(waiting.state, "waiting_input");
      const task = waiting.tasks.find((candidate) => candidate.id === "work")!;
      let historicalCheckId: string | undefined;
      if (passes) {
        const leased = f.store.claim(waiting.id);
        try {
          historicalCheckId = (
            await f.store.artifact(
              leased,
              "historical-check.txt",
              "check",
              "historical check output",
              { checkId: "unit" },
            )
          ).id;
        } finally {
          f.store.release(leased);
        }
      }
      const preview = app.previewTaskModelChange(task.id, "worker2");
      await app.confirmTaskModelChange(preview);
      await app.resume();
      await app.waitForIdle();
      const result = app.currentRun()!;
      assert.equal(checkCount - checksBefore, 1);
      const resolutions = f.store
        .artifacts(result.id)
        .filter(
          (artifact) =>
            artifact.metadata.type === "task-model-change-resolution",
        );
      if (!passes) {
        assert.notEqual(result.state, "succeeded");
        assert.deepEqual(resolutions, []);
        return;
      }
      assert.equal(result.state, "succeeded", result.reason);
      assert.equal(resolutions.length, 1);
      assert.equal(
        result.modelChanges?.at(-1)?.resolutionReportId,
        resolutions[0]!.id,
      );
      const evidence = JSON.parse(
        (await f.store.content(resolutions[0]!)).toString(),
      );
      const freshCheckIds = f.store
        .artifacts(result.id)
        .filter(
          (artifact) =>
            artifact.kind === "check" && artifact.id !== historicalCheckId,
        )
        .map((artifact) => artifact.id);
      assert.ok(historicalCheckId);
      assert.deepEqual(evidence.validationArtifactIds, freshCheckIds);
      assert.ok(!evidence.validationArtifactIds.includes(historicalCheckId));
      assert.equal(evidence.checks, "fresh-passing-validation");
      assert.equal(evidence.semanticEquivalence, "not-established");
    } finally {
      await app.close();
      await f.cleanup();
    }
  }

  await runScenario(false);
  await runScenario(true);
});
