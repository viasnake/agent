import test from "node:test";
import assert from "node:assert/strict";
import { parseResult, validatePlan } from "../src/plan.js";
import { saveAttemptReport } from "../src/collaboration.js";
import {
  collaborationResultInstruction,
  readOnlyCollaborationInstruction,
  taskReportInstruction,
} from "../src/collaboration-prompts.js";
import { TaskTools } from "../src/tools.js";
import { Sandbox } from "../src/sandbox.js";
import type { Run, Task } from "../src/types.js";
import { join } from "node:path";
import { ScriptedRuntime, call, completed, fixture } from "./helpers.js";

test("read-only plans permit independent review without a writer", () => {
  const tasks = [
    {
      id: "reader",
      objective: "Read the assigned evidence",
      role: "worker",
      dependsOn: [],
      write: false,
    },
    {
      id: "review",
      objective: "Review the reader",
      role: "reviewer",
      dependsOn: ["reader"],
      write: false,
    },
  ];
  assert.throws(() => validatePlan({ tasks }, 4));
  assert.equal(validatePlan({ tasks }, 4, { readOnlyPlan: true }).length, 2);
  assert.throws(
    () =>
      validatePlan(
        {
          tasks: [
            {
              id: "writer-a",
              objective: "Write one result",
              role: "worker",
              dependsOn: [],
              write: true,
            },
            {
              id: "writer-b",
              objective: "Write another result",
              role: "worker",
              dependsOn: [],
              write: true,
            },
          ],
        },
        4,
      ),
    /WRITER_CONFLICT|writer/i,
  );
});

test("delegations are accepted only on bounded needs_replan results", () => {
  const request = {
    objective: "Inspect one assigned file",
    constraints: ["Do not edit files"],
    sourceIds: [],
    expectedResult: "A bounded finding",
    acceptance: ["Include the inspected path"],
  };
  assert.throws(() =>
    parseResult(
      JSON.stringify({
        outcome: "completed",
        summary: "done",
        artifacts: [],
        unresolved: [],
        delegations: [request],
      }),
    ),
  );
  assert.throws(() =>
    parseResult(
      JSON.stringify({
        outcome: "needs_replan",
        summary: "delegate",
        artifacts: [],
        unresolved: [],
      }),
    ),
  );
  assert.equal(
    parseResult(
      JSON.stringify({
        outcome: "needs_replan",
        summary: "delegate",
        artifacts: [],
        unresolved: [],
        delegations: [request],
      }),
    ).delegations?.length,
    1,
  );
});

test("assisted read-only execution exposes only scoped tools and synthesizes one answer", async () => {
  const runtime = new ScriptedRuntime(async (request, index) => {
    if (request.role === "lead") {
      assert.deepEqual(request.tools, []);
      return JSON.stringify({
        tasks: [
          {
            id: "reader",
            objective: "Read the assigned evidence",
            role: "worker",
            dependsOn: [],
            write: false,
          },
        ],
      });
    }
    assert.equal(request.objective.includes("private transcript"), false);
    assert.ok(request.system.includes(readOnlyCollaborationInstruction));
    assert.ok(request.system.includes(collaborationResultInstruction));
    assert.match(request.objective, /durable user context/);
    assert.match(request.objective, /host hard boundary/);
    assert.match(request.objective, /host context boundary/);
    assert.ok(
      request.tools
        .find((tool) => tool.name === "read_task_report")
        ?.description.includes(taskReportInstruction),
    );
    assert.equal(
      request.tools.some((tool) => tool.name === "shell"),
      false,
    );
    assert.equal(
      request.tools.some((tool) => tool.name === "research_checkpoint"),
      false,
    );
    assert.equal(
      request.tools.some((tool) => tool.name === "write_file"),
      false,
    );
    assert.equal(
      request.tools.some((tool) => tool.name === "read_task_report"),
      true,
    );
    if (index === 1)
      assert.equal(
        request.tools.some((tool) => tool.name === "read_research_checkpoint"),
        false,
      );
    if (index === 2) {
      assert.match(request.objective, /"taskId":"reader"/);
      assert.equal(
        request.tools.some((tool) => tool.name === "read_research_checkpoint"),
        true,
      );
      assert.match(
        await call(request, "read_research_checkpoint", {}),
        /preserved host checkpoint/,
      );
    }
    return completed([], index === 1 ? "reader result" : "synthesized answer");
  });
  const f = await fixture(runtime);
  try {
    const run = await f.harness.create({
      kind: "research",
      objective: "Inspect the local evidence",
      context: "durable user context that root and synthesis may retain",
      contextState: {
        pins: [],
        decisions: [],
        openQuestions: [],
        constraints: ["host context boundary"],
        instructions: [],
        sourceIds: [],
        imageIds: [],
        originalRunIds: [],
        workingState: {
          checks: [],
          hashes: {},
          artifacts: [],
          operations: [],
          history: [],
        },
        compactions: [],
        researchCheckpoint: {
          summary: "preserved host checkpoint",
          searchedScopes: [],
          openQuestions: [],
          decisions: [],
          author: "model",
          trusted: false,
          updatedAt: Date.now(),
        },
      },
      access: "read-only",
      mode: "assisted",
      constraints: ["host hard boundary"],
    });
    const result = await f.harness.execute(run.id);
    assert.equal(result.state, "succeeded", result.reason);
    assert.equal(runtime.requests.length, 3);
    assert.equal(
      result.tasks.filter((task) => task.purpose === "synthesis").length,
      1,
    );
    assert.equal(
      result.tasks.find((task) => task.purpose === "synthesis")?.result
        ?.summary,
      "synthesized answer",
    );
    assert.ok(
      result.tasks.every((task) => (task.attemptReportIds?.length ?? 0) >= 1),
    );
  } finally {
    await f.cleanup();
  }
});

test("plain-text collaborative chat exposes only the bounded report tool", async () => {
  const runtime = new ScriptedRuntime(async (request) => {
    if (request.role === "lead")
      return JSON.stringify({
        tasks: [
          {
            id: "answer",
            objective: "Answer the user's question",
            role: "worker",
            dependsOn: [],
            write: false,
          },
        ],
      });
    assert.deepEqual(
      request.tools.map((tool) => tool.name),
      ["read_task_report"],
    );
    return completed([], "Integrated answer");
  });
  const f = await fixture(runtime);
  try {
    f.config.limits.maxRepairs = 0;
    const run = await f.harness.create({
      kind: "chat",
      objective: "What is a stable task graph?",
      access: "read-only",
      mode: "assisted",
    });
    const result = await f.harness.execute(run.id);
    assert.equal(result.state, "succeeded", result.reason);
    assert.equal(runtime.requests.length, 3);
  } finally {
    await f.cleanup();
  }
});

test("task reports deny sibling access while preserving legacy checkpoint tools", async () => {
  const f = await fixture(new ScriptedRuntime(async () => completed()));
  try {
    const created = await f.harness.create({
        kind: "research",
        objective: "Bounded review",
        access: "read-only",
        mode: "assisted",
      }),
      run = f.store.claim(created.id),
      producer = {
        id: "producer",
        objective: "Produce evidence",
        role: "worker" as const,
        dependsOn: [],
        write: false,
        state: "succeeded" as const,
        attempts: 1,
        resultFormat: "structured" as const,
        attemptReportIds: [],
      },
      sibling = {
        id: "sibling",
        objective: "Review only your own evidence",
        role: "worker" as const,
        dependsOn: [],
        write: false,
        state: "pending" as const,
        attempts: 0,
        resultFormat: "structured" as const,
        attemptReportIds: [],
      };
    run.tasks = [producer, sibling];
    f.store.save(run);
    const reportId = await saveAttemptReport(
      f.store,
      run,
      producer,
      producer.id,
      "worker",
      1,
      { result: completed([], "producer evidence") },
      { terminalState: "succeeded" },
    );
    const tools = new TaskTools(
      f.config,
      f.store,
      run,
      sibling,
      join(f.store.runDir(run.id), "work"),
      new Sandbox(f.config.execution),
    ).all();
    await assert.rejects(
      () =>
        tools
          .find((tool) => tool.name === "read_task_report")!
          .execute(
            { reportId, start: 0, bytes: 1000 },
            new AbortController().signal,
          ),
      { code: "REPORT" },
    );

    const legacy = { ...sibling, resultFormat: undefined };
    const legacyTools = new TaskTools(
      f.config,
      f.store,
      run,
      legacy,
      join(f.store.runDir(run.id), "work"),
      new Sandbox(f.config.execution),
    ).all();
    assert.equal(
      legacyTools.some((tool) => tool.name === "read_task_report"),
      false,
    );
    assert.equal(
      legacyTools.some((tool) => tool.name === "research_checkpoint"),
      true,
    );
    f.store.release(run);
  } finally {
    await f.cleanup();
  }
});

test("oversized attempt audits retain bounded evidence and truthful truncation metadata", async () => {
  const f = await fixture(new ScriptedRuntime(async () => completed()));
  try {
    const created = await f.harness.create({
        kind: "research",
        objective: "Preserve an oversized result",
        access: "read-only",
        mode: "reviewed",
      }),
      run = f.store.claim(created.id),
      hugeSummary = "bounded evidence ".repeat(20_000),
      result = {
        outcome: "failed" as const,
        summary: hugeSummary,
        artifacts: [],
        unresolved: ["The result cannot fit in one report"],
      },
      task: Task = {
        id: "oversized",
        objective: "Inspect",
        role: "worker",
        dependsOn: [],
        write: false,
        state: "failed",
        attempts: 1,
        resultFormat: "structured",
        result,
      };
    run.tasks = [task];
    f.store.save(run);
    const reportId = await saveAttemptReport(
      f.store,
      run,
      task,
      task.id,
      "worker",
      task.attempts,
      { result },
    );
    const reportArtifact = f.store
        .artifacts(run.id)
        .find((artifact) => artifact.id === reportId)!,
      report = JSON.parse(
        (await f.store.content(reportArtifact)).toString("utf8"),
      ) as {
        audit: { fullBytes: number; fullSha256: string; truncated: boolean };
        result: { summary: string };
      };
    assert.equal(reportArtifact.metadata.truncated, true);
    assert.ok(report.audit.fullBytes > 128_000);
    assert.equal(report.audit.fullSha256.length, 64);
    assert.equal(report.audit.truncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(report)) < 128_000);
    assert.ok(report.result.summary.includes("[truncated]"));
    assert.equal(task.result?.summary, hugeSummary);
    assert.deepEqual(task.attemptReportIds, [reportId]);
    f.store.release(run);
  } finally {
    await f.cleanup();
  }
});

test("delegation stages two ready parents without rolling back live run metadata", async () => {
  const f = await fixture(new ScriptedRuntime(async () => completed()));
  try {
    const created = await f.harness.create({
        kind: "research",
        objective: "Inspect two independent areas",
        access: "read-only",
        mode: "assisted",
      }),
      run = f.store.claim(created.id),
      makeParent = (id: string): Task => ({
        id,
        objective: `Inspect ${id}`,
        role: "worker",
        dependsOn: [],
        write: false,
        state: "pending",
        attempts: 1,
        resultFormat: "structured",
        result: {
          outcome: "needs_replan",
          summary: "Delegate one bounded inspection",
          artifacts: [],
          unresolved: [],
          delegations: [
            {
              objective: `Inspect child of ${id}`,
              constraints: [],
              sourceIds: [],
              expectedResult: "One finding",
              acceptance: ["Report the finding"],
            },
          ],
        },
      }),
      parents = [makeParent("first"), makeParent("second")];
    run.tasks = parents;
    f.store.save(run);

    const originalSelect = f.harness.planner.router.select.bind(
      f.harness.planner.router,
    );
    let routed = 0,
      releaseRoute!: () => void,
      routeStarted!: () => void;
    const gate = new Promise<void>((resolve) => {
        releaseRoute = resolve;
      }),
      started = new Promise<void>((resolve) => {
        routeStarted = resolve;
      });
    f.harness.planner.router.select = async (...args) => {
      if (++routed === 1) routeStarted();
      await gate;
      return originalSelect(...args);
    };
    const admission = f.harness.planner.admitDelegations(
      run,
      parents,
      new AbortController().signal,
    );
    await started;
    run.elapsedMs = 1234;
    releaseRoute();
    await admission;

    assert.equal(run.elapsedMs, 1234);
    assert.equal(run.tasks.filter((task) => task.delegatedBy).length, 2);
    assert.deepEqual(
      run.tasks
        .filter((task) => task.delegatedBy)
        .map((task) => task.delegatedBy)
        .sort(),
      ["first", "second"],
    );
    f.store.release(run);
  } finally {
    await f.cleanup();
  }
});

test("delegation preflight counts failed work before routing", async () => {
  const f = await fixture(new ScriptedRuntime(async () => completed()));
  try {
    f.config.limits.maxRequests = 2;
    const created = await f.harness.create({
        kind: "research",
        objective: "Inspect with a bounded request budget",
        access: "read-only",
        mode: "assisted",
      }),
      run = f.store.claim(created.id),
      parent: Task = {
        id: "parent",
        objective: "Inspect",
        role: "worker",
        dependsOn: [],
        write: false,
        state: "pending",
        attempts: 1,
        resultFormat: "structured",
        result: {
          outcome: "needs_replan",
          summary: "Delegate",
          artifacts: [],
          unresolved: [],
          delegations: [
            {
              objective: "Inspect one child",
              constraints: [],
              sourceIds: [],
              expectedResult: "Finding",
              acceptance: ["State finding"],
            },
          ],
        },
      },
      historicFailure: Task = {
        id: "historic",
        objective: "Earlier failed work",
        role: "worker",
        dependsOn: [],
        write: false,
        state: "failed",
        attempts: 1,
        resultFormat: "structured",
      };
    run.tasks = [parent, historicFailure];
    f.store.save(run);
    let routeCalls = 0;
    const originalSelect = f.harness.planner.router.select.bind(
      f.harness.planner.router,
    );
    f.harness.planner.router.select = async (...args) => {
      routeCalls++;
      return originalSelect(...args);
    };
    await assert.rejects(
      () =>
        f.harness.planner.admitDelegations(
          run,
          [parent],
          new AbortController().signal,
        ),
      { code: "BUDGET" },
    );
    assert.equal(routeCalls, 0);
    assert.equal(
      run.tasks.some((task) => task.delegatedBy),
      false,
    );
    f.config.limits.maxRequests = 60;
    f.config.limits.maxTasks = 2;
    await assert.rejects(
      () =>
        f.harness.planner.admitDelegations(
          run,
          [parent],
          new AbortController().signal,
        ),
      { code: "TASK_LIMIT" },
    );
    assert.equal(routeCalls, 0);
    assert.equal(
      run.tasks.some((task) => task.delegatedBy),
      false,
    );
    f.store.release(run);
  } finally {
    await f.cleanup();
  }
});

test("delegated assignments enforce the source cap before routing", async () => {
  const f = await fixture(new ScriptedRuntime(async () => completed()));
  try {
    const created = await f.harness.create({
        kind: "research",
        objective: "Inspect assigned sources",
        access: "read-only",
        mode: "assisted",
      }),
      run = f.store.claim(created.id),
      parent: Task = {
        id: "parent",
        objective: "Inspect",
        role: "worker",
        dependsOn: [],
        write: false,
        state: "pending",
        attempts: 1,
        resultFormat: "structured",
        result: {
          outcome: "needs_replan",
          summary: "Delegate",
          artifacts: [],
          unresolved: [],
          delegations: [
            {
              objective: "Inspect one child",
              constraints: [],
              sourceIds: Array.from(
                { length: 51 },
                (_, index) => `source-${index}`,
              ),
              expectedResult: "Finding",
              acceptance: ["State finding"],
            },
          ],
        },
      };
    run.tasks = [parent];
    f.store.save(run);
    let routeCalls = 0;
    const originalSelect = f.harness.planner.router.select.bind(
      f.harness.planner.router,
    );
    f.harness.planner.router.select = async (...args) => {
      routeCalls++;
      return originalSelect(...args);
    };
    await assert.rejects(
      () =>
        f.harness.planner.admitDelegations(
          run,
          [parent],
          new AbortController().signal,
        ),
      { code: "SOURCE_LIMIT" },
    );
    assert.equal(routeCalls, 0);
    assert.equal(
      run.tasks.some((task) => task.delegatedBy),
      false,
    );
    f.store.release(run);
  } finally {
    await f.cleanup();
  }
});

test("dynamic child routing excludes reviewer model identities", async () => {
  const f = await fixture(new ScriptedRuntime(async () => completed()));
  try {
    f.config.models.reviewerAlias = {
      ...f.config.models.reviewer!,
      roles: ["worker"],
    };
    const created = await f.harness.create({
        kind: "research",
        objective: "Inspect without reviewer self-review",
        access: "read-only",
        mode: "assisted",
      }),
      run = f.store.claim(created.id),
      parent: Task = {
        id: "parent",
        objective: "Inspect",
        role: "worker",
        model: "worker",
        dependsOn: [],
        write: false,
        state: "pending",
        attempts: 1,
        resultFormat: "structured",
        result: {
          outcome: "needs_replan",
          summary: "Delegate",
          artifacts: [],
          unresolved: [],
          delegations: [
            {
              objective: "Inspect one child",
              constraints: [],
              sourceIds: [],
              expectedResult: "Finding",
              acceptance: ["State finding"],
              model: "reviewerAlias",
            },
          ],
        },
      },
      reviewer: Task = {
        id: "review",
        objective: "Review",
        role: "reviewer",
        model: "reviewer",
        dependsOn: ["parent"],
        write: false,
        state: "pending",
        attempts: 0,
        resultFormat: "structured",
      };
    run.tasks = [parent, reviewer];
    f.store.save(run);
    await assert.rejects(
      () =>
        f.harness.planner.admitDelegations(
          run,
          [parent],
          new AbortController().signal,
        ),
      { code: "NO_MODEL" },
    );
    assert.equal(
      run.tasks.some((task) => task.delegatedBy),
      false,
    );
    f.store.release(run);
  } finally {
    await f.cleanup();
  }
});

test("read-only repair invalidates dependent workers but retains unrelated success", async () => {
  const f = await fixture(new ScriptedRuntime(async () => completed()));
  try {
    const created = await f.harness.create({
        kind: "research",
        objective: "Repair only the failed evidence chain",
        access: "read-only",
        mode: "assisted",
      }),
      run = f.store.claim(created.id),
      task = (
        id: string,
        role: Task["role"],
        dependsOn: string[],
        state: Task["state"],
      ): Task => ({
        id,
        objective: id,
        role,
        dependsOn,
        write: false,
        state,
        attempts: 1,
        resultFormat: "structured",
        attemptReportIds: [`report-${id}`],
        result: {
          outcome: state === "failed" ? "failed" : "completed",
          summary: `${id} result`,
          artifacts: [],
          unresolved: [],
        },
      });
    run.tasks = [
      task("producer", "worker", [], "failed"),
      task("dependent-worker", "worker", ["producer"], "succeeded"),
      task("reviewer", "reviewer", ["dependent-worker"], "succeeded"),
      task("synthesis", "worker", ["reviewer"], "succeeded"),
      task("unrelated", "worker", [], "succeeded"),
    ];
    f.store.save(run);
    await (
      f.harness as unknown as {
        repair(run: Run, feedback: string, work: string): Promise<void>;
      }
    ).repair(
      run,
      "Repair the concrete missing evidence",
      f.store.runDir(run.id),
    );
    assert.deepEqual(
      run.tasks.map((task) => [task.id, task.state]),
      [
        ["producer", "pending"],
        ["dependent-worker", "pending"],
        ["reviewer", "pending"],
        ["synthesis", "pending"],
        ["unrelated", "succeeded"],
      ],
    );
    assert.deepEqual(run.tasks[0]?.reworkLinks?.[0]?.priorReportIds, [
      "report-producer",
    ]);
    f.store.release(run);
  } finally {
    await f.cleanup();
  }
});

test("review failure repairs only the producer chain and preserves every report", async () => {
  let reviewerAttempts = 0;
  let workerAttempts = 0;
  let repairObjective = "";
  let calls = 0;
  const runtime = new ScriptedRuntime(async (request) => {
    const index = calls++;
    if (request.role === "worker") {
      const invocation = JSON.parse(request.objective) as {
        dependencies: unknown[];
      };
      if (!invocation.dependencies.length && workerAttempts++ > 0) {
        repairObjective = request.objective;
        assert.match(request.objective, /The evidence needs another pass/);
        assert.match(request.objective, /Attempt report:/);
      }
    }
    if (request.role === "reviewer" && reviewerAttempts++ === 0)
      return JSON.stringify({
        outcome: "failed",
        summary: "Contradictory finding",
        artifacts: [],
        unresolved: ["The evidence needs another pass"],
      });
    if (request.role === "reviewer")
      return completed([], "Independent review passed");
    return completed(
      [],
      index === 4 ? "Synthesized result" : "Producer result",
    );
  });
  const f = await fixture(runtime);
  try {
    const run = await f.harness.create({
      kind: "research",
      objective: "Inspect",
      access: "read-only",
      mode: "reviewed",
    });
    const result = await f.harness.execute(run.id);
    assert.equal(result.state, "succeeded", result.reason);
    assert.equal(result.repairAttempts, 1);
    assert.equal(result.tasks.find((task) => task.id === "work")?.attempts, 2);
    assert.equal(
      result.tasks.find((task) => task.id === "review")?.attempts,
      2,
    );
    assert.equal(
      result.tasks.find((task) => task.purpose === "synthesis")?.result
        ?.summary,
      "Synthesized result",
    );
    assert.equal(
      result.tasks.every((task) => (task.attemptReportIds?.length ?? 0) >= 1),
      true,
    );
    assert.equal(
      result.tasks.find((task) => task.id === "review")?.attemptReportIds
        ?.length,
      2,
    );
    const reviewReportId = result.tasks.find((task) => task.id === "review")!
      .attemptReportIds?.[0];
    assert.ok(reviewReportId);
    assert.ok(repairObjective.includes(reviewReportId));
    const repairedProducer = result.tasks.find((task) => task.id === "work")!;
    assert.equal(repairedProducer.reworkLinks?.[0]?.status, "resolved");
    assert.deepEqual(repairedProducer.reworkLinks?.[0]?.resolvedByReportIds, [
      result.tasks.find((task) => task.id === "review")!.attemptReportIds![1],
    ]);
  } finally {
    await f.cleanup();
  }
});

test("assisted delegation is admitted at a scheduler boundary with isolated children", async () => {
  let parentAttempts = 0;
  let calls = 0;
  const runtime = new ScriptedRuntime(async (request) => {
    const index = calls++;
    if (request.role === "lead")
      return JSON.stringify({
        tasks: [
          {
            id: "worker",
            objective: "Inspect the evidence",
            role: "worker",
            dependsOn: [],
            write: false,
          },
        ],
      });
    assert.equal(
      request.tools.some((tool) => tool.name === "shell"),
      false,
    );
    if (request.objective.includes('"taskObjective":"Inspect the evidence"')) {
      if (parentAttempts++ === 0)
        return JSON.stringify({
          outcome: "needs_replan",
          summary: "Split the inspection",
          artifacts: [],
          unresolved: ["A child must inspect the assignment"],
          delegations: [
            {
              objective: "Inspect one bounded part",
              constraints: ["Do not write"],
              sourceIds: [],
              expectedResult: "One bounded finding",
              acceptance: ["State the finding"],
            },
          ],
        });
      return completed(
        [],
        index === 4 ? "Synthesized result" : "Parent synthesis",
      );
    }
    return completed([], index === 4 ? "Synthesized result" : "Child finding");
  });
  const f = await fixture(runtime);
  try {
    const run = await f.harness.create({
      kind: "research",
      objective: "Inspect the evidence",
      access: "read-only",
      mode: "assisted",
    });
    const result = await f.harness.execute(run.id);
    const child = result.tasks.find((task) => task.delegatedBy);
    assert.equal(result.state, "succeeded");
    assert.ok(child);
    assert.equal(child?.assignment?.objective, "Inspect one bounded part");
    assert.equal(child?.dependsOn.length, 0);
    assert.equal(
      result.tasks.find((task) => task.id === "worker")?.delegationRounds,
      1,
    );
    assert.equal(
      result.tasks.find((task) => task.purpose === "synthesis")?.result
        ?.summary,
      "Synthesized result",
    );
  } finally {
    await f.cleanup();
  }
});

test("persisted needs_replan is admitted before a parent provider retry", async () => {
  let parentCalls = 0;
  let childCalls = 0;
  const runtime = new ScriptedRuntime(async (request) => {
    const objective = JSON.parse(request.objective) as {
      taskObjective: string;
    };
    if (objective.taskObjective === "Resume the parent") {
      parentCalls++;
      return completed([], "Parent continued after child");
    }
    if (objective.taskObjective === "Inspect one bounded child") {
      childCalls++;
      return completed([], "Child finding");
    }
    throw new Error(`Unexpected task objective: ${objective.taskObjective}`);
  });
  const f = await fixture(runtime);
  try {
    const created = await f.harness.create({
        kind: "research",
        objective: "Resume delegated inspection",
        access: "read-only",
        mode: "assisted",
      }),
      run = f.store.claim(created.id),
      parent: Task = {
        id: "parent",
        objective: "Resume the parent",
        role: "worker",
        model: "worker",
        dependsOn: [],
        write: false,
        state: "pending",
        attempts: 1,
        resultFormat: "structured",
        result: {
          outcome: "needs_replan",
          summary: "A child must inspect one bounded part",
          artifacts: [],
          unresolved: ["One child finding remains"],
          delegations: [
            {
              objective: "Inspect one bounded child",
              constraints: ["Read only"],
              sourceIds: [],
              expectedResult: "One child finding",
              acceptance: ["Report the child finding"],
            },
          ],
        },
      };
    run.tasks = [parent];
    f.store.save(run, "persisted_replan_fixture");
    f.store.release(run);
    const result = await f.harness.execute(run.id);
    assert.equal(result.state, "succeeded", result.reason);
    assert.equal(parentCalls, 1);
    assert.equal(childCalls, 1);
    assert.equal(
      result.tasks.find((task) => task.id === "parent")?.attempts,
      2,
    );
    assert.equal(result.tasks.filter((task) => task.delegatedBy).length, 1);
  } finally {
    await f.cleanup();
  }
});

test("invalid delegated admission publishes no child graph", async () => {
  const runtime = new ScriptedRuntime(async (request) => {
    if (request.role === "lead")
      return JSON.stringify({
        tasks: [
          {
            id: "worker",
            objective: "Inspect one source",
            role: "worker",
            dependsOn: [],
            write: false,
          },
        ],
      });
    if (request.objective.includes('"taskObjective":"Inspect one source"'))
      return JSON.stringify({
        outcome: "needs_replan",
        summary: "Need a missing source",
        artifacts: [],
        unresolved: [],
        delegations: [
          {
            objective: "Read the missing source",
            constraints: [],
            sourceIds: ["00000000-0000-4000-8000-000000000001"],
            expectedResult: "One finding",
            acceptance: ["Name the finding"],
          },
        ],
      });
    throw new Error("No child should run");
  });
  const f = await fixture(runtime);
  try {
    const run = await f.harness.create({
      kind: "research",
      objective: "Inspect one source",
      access: "read-only",
      mode: "assisted",
    });
    const result = await f.harness.execute(run.id);
    assert.notEqual(result.state, "succeeded");
    assert.equal(
      result.tasks.some((task) => task.delegatedBy),
      false,
    );
  } finally {
    await f.cleanup();
  }
});

test("delegation admission is atomic across a scheduler batch", async () => {
  const runtime = new ScriptedRuntime(async (request) => {
    if (request.role === "lead")
      return JSON.stringify({
        tasks: [
          {
            id: "worker",
            objective: "Inspect two bounded parts",
            role: "worker",
            dependsOn: [],
            write: false,
          },
        ],
      });
    if (
      request.objective.includes('"taskObjective":"Inspect two bounded parts"')
    )
      return JSON.stringify({
        outcome: "needs_replan",
        summary: "Split the inspection",
        artifacts: [],
        unresolved: [],
        delegations: [
          {
            objective: "First bounded part",
            constraints: [],
            sourceIds: [],
            expectedResult: "One finding",
            acceptance: ["State the finding"],
          },
          {
            objective: "Second bounded part",
            constraints: [],
            sourceIds: [],
            expectedResult: "One finding",
            acceptance: ["State the finding"],
            model: "missing-model",
          },
        ],
      });
    throw new Error("No child should run");
  });
  const f = await fixture(runtime);
  try {
    const run = await f.harness.create({
      kind: "research",
      objective: "Inspect two bounded parts",
      access: "read-only",
      mode: "assisted",
    });
    const result = await f.harness.execute(run.id);
    assert.notEqual(result.state, "succeeded");
    assert.equal(
      result.tasks.some((task) => task.delegatedBy),
      false,
    );
  } finally {
    await f.cleanup();
  }
});
