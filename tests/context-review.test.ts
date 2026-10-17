import assert from "node:assert/strict";
import test from "node:test";
import {
  assertContextReady,
  confirmContextReview,
  previewContextReview,
  recordContextIssue,
} from "../src/context-review.js";
import { AgentError, type Task } from "../src/types.js";
import { fixture } from "./helpers.js";

const task: Task = {
  id: "work",
  objective: "fixture",
  role: "worker",
  dependsOn: [],
  write: false,
  state: "pending",
  attempts: 0,
};

test("context issues pause a run and require an explicit bound acknowledgement", async () => {
  const f = await fixture({
    contract: {
      version: 1,
      context: "messages-v1",
      tools: true,
      images: false,
    },
    async run() {
      return "unused";
    },
    async close() {},
  });
  try {
    const run = await f.harness.create({
      objective: "fixture",
      kind: "writing",
      mode: "single",
      model: "worker",
      localOnly: true,
    });
    run.tasks = [structuredClone(task)];
    run.state = "waiting_input";
    const leased = f.store.claim(run.id);
    leased.tasks = [structuredClone(task)];
    leased.state = "waiting_input";
    f.store.save(leased);
    const issue = recordContextIssue(
      f.store,
      leased,
      leased.tasks[0]!,
      {
        kind: "contradiction",
        detail: "The retained condition conflicts with new evidence.",
        evidence: "literal fixture evidence",
        sourceIds: [],
        archiveIds: [],
        operationIds: [],
      },
      "host",
    );
    f.store.release(leased);
    assert.throws(() => assertContextReady(leased), {
      code: "CONTEXT_REVIEW_REQUIRED",
    });
    const preview = previewContextReview(f.store, run.id);
    assert.equal(preview.issues[0]!.id, issue.id);
    const acknowledged = confirmContextReview(
      f.store,
      preview,
      "I reviewed the retained condition and will resume explicitly.",
    );
    assert.equal(
      acknowledged.contextIssues?.[0]?.acknowledged?.note.startsWith(
        "I reviewed",
      ),
      true,
    );
    assert.equal(acknowledged.tasks[0]?.contextReviewCount, 1);
    assert.doesNotThrow(() => assertContextReady(acknowledged));
    assert.equal(acknowledged.state, "waiting_input");
  } finally {
    await f.cleanup();
  }
});

test("context review rejects a stale binding and bounded empty notes", async () => {
  const f = await fixture({
    contract: {
      version: 1,
      context: "messages-v1",
      tools: true,
      images: false,
    },
    async run() {
      return "unused";
    },
    async close() {},
  });
  try {
    const run = await f.harness.create({
      objective: "fixture",
      kind: "writing",
      mode: "single",
      model: "worker",
      localOnly: true,
    });
    run.tasks = [structuredClone(task)];
    run.state = "waiting_input";
    const leased = f.store.claim(run.id);
    leased.tasks = [structuredClone(task)];
    leased.state = "waiting_input";
    f.store.save(leased);
    recordContextIssue(
      f.store,
      leased,
      leased.tasks[0]!,
      {
        kind: "missing_condition",
        detail: "condition",
        evidence: "evidence",
        sourceIds: [],
        archiveIds: [],
        operationIds: [],
      },
      "host",
    );
    f.store.release(leased);
    const preview = previewContextReview(f.store, run.id);
    const changed = f.store.claim(run.id);
    changed.objective = "changed";
    f.store.save(changed);
    f.store.release(changed);
    assert.throws(
      () => confirmContextReview(f.store, preview, "acknowledged"),
      { code: "CONTEXT_REVIEW_STALE" },
    );
    assert.throws(() => confirmContextReview(f.store, preview, " "), {
      code: "CONTEXT_REVIEW",
    });
    assert.ok(new AgentError("CONTEXT_REVIEW", "fixture"));
  } finally {
    await f.cleanup();
  }
});
