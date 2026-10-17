import test from "node:test";
import assert from "node:assert/strict";
import { parseResult, validatePlan } from "../src/plan.js";
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
      context: "private transcript that must stay out of task prompts",
      contextState: {
        pins: [],
        decisions: [],
        openQuestions: [],
        constraints: [],
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
    });
    const result = await f.harness.execute(run.id);
    assert.equal(result.state, "succeeded");
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

test("plain-text collaborative chat does not require or expose tools", async () => {
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
    assert.deepEqual(request.tools, []);
    return completed([], "Integrated answer");
  });
  const f = await fixture(runtime);
  try {
    const run = await f.harness.create({
      kind: "chat",
      objective: "What is a stable task graph?",
      access: "read-only",
      mode: "assisted",
    });
    const result = await f.harness.execute(run.id);
    assert.equal(result.state, "succeeded");
    assert.equal(runtime.requests.length, 3);
  } finally {
    await f.cleanup();
  }
});

test("review failure repairs only the producer chain and preserves every report", async () => {
  let reviewerAttempts = 0;
  let calls = 0;
  const runtime = new ScriptedRuntime(async (request) => {
    const index = calls++;
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
    assert.equal(result.state, "succeeded");
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
