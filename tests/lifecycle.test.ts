import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkerRequest, WorkerResult } from "../src/execution/protocol.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { FauxResponseFactory } from "@earendil-works/pi-ai";
import {
  fixture,
  TestRunner,
  jobInput,
  untilJob,
  codeResponses,
  call,
  answer,
} from "./support.js";
import { AppDoc } from "../src/state.js";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";

function deferredResponse(): {
  response: FauxResponseFactory;
  entered: Promise<void>;
  release: () => void;
} {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    entered,
    release: () => release(),
    response: async (_context, options) => {
      enter();
      await Promise.race([
        held,
        new Promise<void>((resolve) => {
          if (options?.signal?.aborted) resolve();
          else
            options?.signal?.addEventListener("abort", () => resolve(), {
              once: true,
            });
        }),
      ]);
      return options?.signal?.aborted
        ? fauxAssistantMessage([], { stopReason: "aborted" })
        : fauxAssistantMessage("Ready for the next step");
    },
  };
}

test("A05: steering is accepted before applied and is placed before final success", async () => {
  const deferred = deferredResponse();
  const { service, faux } = await fixture([deferred.response], {
    codeFixture: true,
  });
  try {
    const { id } = await service.create(jobInput());
    await deferred.entered;
    await service.input(id, randomUUID(), "既存APIの名前を変えないでください");
    assert.equal((await service.job(id)).inputs.at(-1)!.applied, false);
    faux.appendResponses(codeResponses());
    deferred.release();
    const job = await untilJob(
      service,
      id,
      (job) => job.status === "succeeded" || job.status === "failed",
    );
    assert.equal(job.status, "succeeded", job.detail);
    assert.equal(job.inputs.at(-1)!.applied, true);
  } finally {
    await service.close();
  }
});

test("A06 A07: queued cancel and model pause stop dispatch; resume preserves counters", async () => {
  const deferred = deferredResponse();
  const { service, faux } = await fixture([deferred.response], {
    codeFixture: true,
  });
  try {
    const first = await service.create(jobInput());
    await deferred.entered;
    const queued = await service.create(jobInput());
    await service.action(
      queued.id,
      randomUUID(),
      (await service.job(queued.id)).revision,
      "cancel",
    );
    const before = await service.job(first.id);
    await service.action(first.id, randomUUID(), before.revision, "pause");
    await untilJob(
      service,
      first.id,
      (job) => job.status === "waiting" && job.cleanupConfirmed,
    );
    assert.equal((await service.job(queued.id)).status, "cancelled");
    faux.setResponses(codeResponses());
    const paused = await service.job(first.id);
    await service.action(first.id, randomUUID(), paused.revision, "resume");
    const complete = await untilJob(
      service,
      first.id,
      (job) => job.status === "succeeded" || job.status === "failed",
    );
    assert.equal(complete.status, "succeeded", complete.detail);
    assert.ok(complete.counters.modelRequests > before.counters.modelRequests);
  } finally {
    await service.close();
  }
});

test("R03 R05: interrupted shell becomes unknown and cannot be bypassed by a new operation ID", async () => {
  const { service } = await fixture([
    call("shell", {
      command: "printf before > marker; sleep 30; printf after >> marker",
    }),
    answer("done"),
  ]);
  try {
    const { id } = await service.create(jobInput());
    await untilJob(service, id, (job) =>
      job.operations.some(
        (op) => op.target === "workspace" && op.status === "dispatched",
      ),
    );
    const job = await service.job(id);
    await service.action(id, randomUUID(), job.revision, "pause");
    const stopped = await untilJob(
      service,
      id,
      (job) =>
        job.operations.some((op) => op.status === "unknown") &&
        job.cleanupConfirmed,
    );
    assert.equal(stopped.waitReason, "reconciliation");
    await assert.rejects(
      service.action(id, randomUUID(), stopped.revision, "resume"),
      /未知操作/,
    );
    await assert.rejects(
      service.prepare(id, "shell", "workspace", { command: "printf repeated" }),
      /未知操作/,
    );
    const unknown = stopped.operations.find((op) => op.status === "unknown")!;
    await service.reconcile(
      id,
      randomUUID(),
      stopped.revision,
      unknown.id,
      "completed",
      "作業ログと marker の部分書き込みを確認しました",
    );
    assert.equal((await service.job(id)).waitReason, "user");
  } finally {
    await service.close();
  }
});

test("R07 R14: dispatch budget and deadline survive reopen and repeated resume", async () => {
  const initial = await fixture([
    call("read_file", { path: "project/missing" }),
    answer("must not dispatch"),
  ]);
  let service = initial.service;
  try {
    initial.config.limits.modelRequests = 1;
    const { id } = await service.create(jobInput());
    const stopped = await untilJob(
      service,
      id,
      (job) => job.waitReason === "budget",
    );
    assert.equal(stopped.counters.modelRequests, 1);
    assert.equal(initial.faux.state.callCount, 1);
    const deadline = stopped.deadlineAt;
    await service.close();
    const reopened = await fixture([answer("must not dispatch")], {
      dataRoot: initial.root,
    });
    service = reopened.service;
    for (let attempt = 0; attempt < 2; attempt++) {
      const job = await service.job(id);
      await service.action(id, randomUUID(), job.revision, "resume");
      await untilJob(service, id, (job) => job.waitReason === "budget");
    }
    assert.equal((await service.job(id)).counters.modelRequests, 1);
    assert.equal((await service.job(id)).deadlineAt, deadline);
    assert.equal(reopened.faux.state.callCount, 0);
    await service.harness.commit(async (tx) => {
      const job = (await tx.doc(AppDoc)).jobs.find((job) => job.id === id)!;
      job.counters.modelRequests = 0;
      job.deadlineAt = Date.now() - 1;
    }, ctx);
    const expired = await service.job(id);
    await service.action(id, randomUUID(), expired.revision, "resume");
    await untilJob(service, id, (job) => job.waitReason === "budget");
    assert.equal(reopened.faux.state.callCount, 0);
  } finally {
    await service.close();
  }
});

test("R08 A09: authentication failures wait without probing and transient provider errors have finite retries", async () => {
  for (const errorMessage of [
    "401 authentication failed",
    "429 rate limit exceeded",
    "network connection lost",
  ]) {
    const { service, faux } = await fixture(
      Array.from({ length: 5 }, () =>
        fauxAssistantMessage([], { stopReason: "error", errorMessage }),
      ),
    );
    try {
      const { id } = await service.create(jobInput());
      const job = await untilJob(
        service,
        id,
        (job) =>
          job.waitReason === "credentials" || job.waitReason === "network",
        18000,
      );
      assert.ok(
        faux.state.callCount >= 1 && faux.state.callCount <= 4,
        errorMessage,
      );
      assert.ok(job.counters.modelRequests <= 4);
    } finally {
      await service.close();
    }
  }
});

test("A06: a cancel accepted during final artifact verification cannot be overwritten by success", async () => {
  const { service } = await fixture(codeResponses(), { codeFixture: true });
  const read = service.artifacts.read.bind(service.artifacts);
  let patchReads = 0,
    reached!: () => void,
    release!: () => void;
  const checking = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  service.artifacts.read = async (artifact) => {
    if (
      "name" in artifact &&
      artifact.name === "changes.patch" &&
      ++patchReads === 2
    ) {
      reached();
      await held;
    }
    return read(artifact);
  };
  try {
    const { id } = await service.create(jobInput());
    await checking;
    const job = await service.job(id);
    await service.action(id, randomUUID(), job.revision, "cancel");
    release();
    const cancelled = await untilJob(
      service,
      id,
      (job) => job.status === "cancelled" && job.cleanupConfirmed,
    );
    assert.equal(cancelled.status, "cancelled");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal((await service.job(id)).status, "cancelled");
  } finally {
    release();
    await service.close();
  }
});

test("R11 R15: graceful shutdown preserves work; an unclean external grant without an operation still requires recovery", async () => {
  const deferred = deferredResponse();
  const initial = await fixture([deferred.response]);
  let service = initial.service;
  const { id } = await service.create(jobInput());
  await deferred.entered;
  await service.close();
  ({ service } = await fixture([], { noModel: true, dataRoot: initial.root }));
  try {
    const job = await service.job(id);
    assert.equal(job.status, "waiting");
    assert.notEqual(job.status, "cancelled");
    assert.equal(job.counters.modelRequests, 1);
  } finally {
    await service.close();
  }
  const unclean = await fixture([], { noModel: true });
  const created = await unclean.service.create(
    jobInput({ externalAllowed: true }),
  );
  await unclean.service.harness.close(ctx);
  await unclean.service.close();
  const reopened = await fixture([], { noModel: true, dataRoot: unclean.root });
  try {
    const job = await reopened.service.job(created.id);
    assert.equal(job.recoveryRequired, true);
    assert.equal(job.waitReason, "reconciliation");
    assert.equal(job.operations.length, 0);
    assert.equal(reopened.faux.state.callCount, 0);
  } finally {
    await reopened.service.close();
  }
});

test("R07: explicit model replacement preserves the saved request budget and absolute deadline", async () => {
  const deferred = deferredResponse();
  const first = await fixture([deferred.response], { codeFixture: true });
  const { id } = await first.service.create(jobInput());
  await deferred.entered;
  await first.service.action(
    id,
    randomUUID(),
    (await first.service.job(id)).revision,
    "pause",
  );
  const paused = await untilJob(
    first.service,
    id,
    (job) => job.status === "waiting" && job.cleanupConfirmed,
  );
  await first.service.close();
  const second = await fixture(codeResponses(), {
    dataRoot: first.root,
    modelId: "faux-2",
  });
  try {
    const before = await second.service.job(id);
    await second.service.action(
      id,
      randomUUID(),
      before.revision,
      "resume",
      undefined,
      undefined,
      true,
    );
    const admitted = await second.service.job(id);
    assert.equal(admitted.modelId, "faux-2");
    assert.equal(
      admitted.counters.modelRequests,
      paused.counters.modelRequests,
    );
    assert.equal(admitted.deadlineAt, paused.deadlineAt);
    assert.equal(admitted.policyRevision, paused.policyRevision + 1);
    const completed = await untilJob(
      second.service,
      id,
      (job) => job.status === "succeeded" || job.status === "failed",
    );
    assert.equal(completed.status, "succeeded", completed.detail);
  } finally {
    await second.service.close();
  }
});

test("R03 R11: restart exposes unknown operations on cancelled jobs and can recover the held cleanup slot", async () => {
  for (const pending of [true, false]) {
    const initial = await fixture([], { noModel: true });
    const first = await initial.service.create(jobInput());
    const second = await initial.service.create(jobInput());
    const operationId = randomUUID();
    await initial.service.harness.commit(async (tx) => {
      const app = await tx.doc(AppDoc),
        job = app.jobs.find((job) => job.id === first.id)!;
      job.status = "cancelled";
      job.workspaceReady = true;
      job.cleanupConfirmed = false;
      app.activeJobId = job.id;
      if (pending)
        job.operations.push({
          id: operationId,
          jobId: job.id,
          kind: "shell",
          target: "workspace",
          argumentHash: "0".repeat(64),
          policyRevision: job.policyRevision,
          status: "dispatched",
        });
    }, ctx);
    await initial.service.close();
    const reopened = await fixture([], {
      noModel: true,
      dataRoot: initial.root,
    });
    try {
      if (pending) {
        const job = await reopened.service.job(first.id);
        assert.equal(job.operations[0]!.status, "unknown");
        assert.equal((await reopened.service.job(second.id)).status, "queued");
        await reopened.service.reconcile(
          first.id,
          randomUUID(),
          job.revision,
          operationId,
          "completed",
          "取消時の実行結果と作業領域を確認しました",
        );
      }
      await untilJob(
        reopened.service,
        second.id,
        (job) => job.waitReason === "credentials",
      );
      const cancelled = await reopened.service.job(first.id);
      assert.equal(cancelled.status, "cancelled");
      assert.equal(cancelled.cleanupConfirmed, true);
    } finally {
      await reopened.service.close();
    }
  }
});

test("A06 R06: replaying a completed cancel receipt cannot clean another active job", async () => {
  const firstWait = deferredResponse(),
    secondWait = deferredResponse();
  const { service, faux } = await fixture([firstWait.response]);
  try {
    const first = await service.create(jobInput());
    await firstWait.entered;
    const original = await service.job(first.id),
      requestId = randomUUID();
    await service.action(first.id, requestId, original.revision, "cancel");
    const cancelled = await untilJob(
      service,
      first.id,
      (job) => job.status === "cancelled" && job.cleanupConfirmed,
    );
    faux.setResponses([secondWait.response]);
    const second = await service.create(jobInput());
    await secondWait.entered;
    await service.action(first.id, requestId, original.revision, "cancel");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal((await service.job(first.id)).revision, cancelled.revision);
    assert.equal((await service.job(second.id)).status, "running");
  } finally {
    await service.close();
  }
});

test("A07 R07: initial workspace processes receive both pause and absolute deadline cancellation", async () => {
  for (const mode of ["pause", "deadline"]) {
    const root = await mkdtemp(join(tmpdir(), "agent-init-stop-"));
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    class SlowInitializer extends TestRunner {
      stopped = false;
      override async call(
        id: string,
        op: WorkerRequest["op"],
        args: Record<string, unknown>,
        signal?: AbortSignal,
      ): Promise<WorkerResult> {
        if (op !== "init") return super.call(id, op, args, signal);
        assert.ok(signal, "Initialization must receive its job abort signal");
        await super.call(id, op, args, signal);
        const running = super.call(
          id,
          "shell",
          {
            command: "printf started > initialization-marker; sleep 30",
            timeout: 40,
            maxBytes: 1048576,
          },
          signal,
        );
        for (let attempt = 0; attempt < 200; attempt++) {
          try {
            await readFile(
              join(this.root, "jobs", id, "initialization-marker"),
            );
            started();
            break;
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        }
        try {
          return await running;
        } finally {
          this.stopped = true;
        }
      }
    }
    const runner = new SlowInitializer(join(root, "work"));
    const { service, config, faux } = await fixture([], {
      dataRoot: root,
      runner,
    });
    if (mode === "deadline") config.limits.deadlineSeconds = 1;
    try {
      const { id } = await service.create(jobInput());
      await Promise.race([
        entered,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("Initial process did not start")),
            5000,
          ).unref(),
        ),
      ]);
      if (mode === "pause")
        await service.action(
          id,
          randomUUID(),
          (await service.job(id)).revision,
          "pause",
        );
      const job = await untilJob(
        service,
        id,
        (job) =>
          job.status === "waiting" &&
          job.waitReason === "reconciliation" &&
          job.cleanupConfirmed,
      );
      assert.equal(runner.stopped, true);
      assert.equal(faux.state.callCount, 0);
      assert.ok(
        job.operations.some(
          (operation) =>
            operation.target === "workspace-init" &&
            operation.status === "unknown",
        ),
      );
      if (mode === "deadline") assert.ok(job.deadlineAt! <= Date.now());
    } finally {
      await service.close();
    }
  }
});
