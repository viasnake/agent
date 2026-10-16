import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Runtime } from "../src/types.js";
import {
  comparisonSchema,
  comparisonSchedule,
  comparisonSummary,
  compareRuns,
  assessComparison,
  readComparison,
  type ComparisonReport,
} from "../src/evaluation.js";
import { call, completed, fixture, ScriptedRuntime } from "./helpers.js";

const suite = () =>
  comparisonSchema.parse({
    schemaVersion: 1,
    name: "synthetic writing comparison — not real provider quality",
    cases: [
      {
        id: "japanese",
        kind: "writing",
        objective:
          "案内文を作成してください。青葉会議は2026年11月5日14:30、参加費0円です。",
        mustKeep: ["青葉会議", "2026年11月5日", "14:30", "0円"],
      },
    ],
    variants: [
      { id: "single", mode: "single" },
      { id: "reviewed", mode: "reviewed" },
    ],
  });

test("comparison schedules rotate every variant without omitting or repeating a pair", () => {
  const input = suite();
  input.repeats = 3;
  input.cases.push({ ...input.cases[0]!, id: "another" });
  const schedule = comparisonSchedule(input);
  assert.equal(schedule.length, 12);
  assert.equal(
    new Set(schedule.map((entry) => JSON.stringify(entry))).size,
    12,
  );
  assert.deepEqual(
    schedule.slice(0, 4).map((entry) => entry.variantIndex),
    [0, 1, 1, 0],
  );
  assert.throws(() =>
    comparisonSchema.parse({
      ...input,
      variants: [input.variants[0], input.variants[0]],
    }),
  );
  assert.throws(() => comparisonSchema.parse({ ...input, repeats: 11 }));
});

test("comparison retains exact mechanical evidence and does not invent semantic scores", async () => {
  const runtime = new ScriptedRuntime(async (request) => {
    if (request.role === "worker") {
      await call(request, "write_file", {
        path: "answer.md",
        content:
          "# 青葉会議\n2026年11月5日14:30に開催します。参加費は0円です。",
        expectedSha256: null,
      });
      return completed(["answer.md"]);
    }
    return completed();
  });
  const f = await fixture(runtime);
  try {
    const report = await compareRuns(
      suite(),
      f.config,
      f.store,
      () => f.harness,
      new AbortController().signal,
    );
    assert.equal(report.complete, true);
    assert.deepEqual(
      report.rows.map((row) => row.state),
      ["succeeded", "succeeded"],
    );
    assert.deepEqual(
      report.rows.map((row) => row.requests),
      [1, 2],
    );
    assert.deepEqual(
      report.rows.map((row) => row.inputTokens),
      [20, 40],
    );
    assert.deepEqual(
      report.rows.map((row) => row.outputTokens),
      [10, 20],
    );
    assert.equal(report.rows[0]!.baselineHash, report.rows[1]!.baselineHash);
    assert.ok(
      report.rows.every(
        (row) => row.checksPassed && row.validation.length && row.elapsedMs > 0,
      ),
    );
    assert.ok(
      report.rows.every((row) =>
        row.artifacts.some((artifact) => artifact.name === "answer.md"),
      ),
    );
    const summary = comparisonSummary(report);
    assert.deepEqual(
      summary.map((row) => row.checksPassRate),
      [1, 1],
    );
    assert.deepEqual(
      summary.map((row) => row.humanAcceptanceRate),
      [null, null],
    );
    assert.deepEqual(
      summary.map((row) => row.majorDefects),
      [null, null],
    );
    assert.deepEqual(
      summary.map((row) => row.totalCostUsd),
      [0, 0],
    );
    assert.deepEqual(
      JSON.parse(
        await readFile(
          join(f.p.home, "comparisons", `${report.id}.json`),
          "utf8",
        ),
      ),
      report,
    );
    const reviewed = structuredClone(report);
    reviewed.rows[0]!.assessment = {
      reviewer: "synthetic-test",
      accepted: false,
      majorDefects: 2,
      reworkCount: 1,
      evidence: "Synthetic assessment fixture; not real provider evaluation.",
    };
    assert.equal(comparisonSummary(reviewed)[0]!.humanAcceptanceRate, 0);
    assert.equal(comparisonSummary(reviewed)[0]!.majorDefects, 2);
    assert.equal(comparisonSummary(reviewed)[0]!.reworkCount, 1);
    assert.equal(comparisonSummary(report)[0]!.humanAcceptanceRate, null);
    const assessed = await assessComparison(
      f.p,
      report.id,
      report.rows[0]!.runId!,
      reviewed.rows[0]!.assessment,
    );
    assert.equal(assessed.assessmentLog?.length, 1);
    assert.equal(
      comparisonSummary(await readComparison(f.p, report.id))[0]!
        .humanAcceptanceRate,
      0,
    );
    await assert.rejects(
      assessComparison(
        f.p,
        report.id,
        "not-a-run",
        reviewed.rows[0]!.assessment,
      ),
      { code: "EVAL_RUN" },
    );
    await assert.rejects(readComparison(f.p, "../outside"));
  } finally {
    await f.cleanup();
  }
});

test("input drift invalidates all paired measurements and does not send the changed fixture", async () => {
  let input = "";
  const runtime = new ScriptedRuntime(async (request) => {
    await call(request, "write_file", {
      path: "answer.md",
      content: "青葉会議 2026年11月5日 14:30 0円",
      expectedSha256: null,
    });
    await writeFile(input, "Changed between variants", { mode: 0o600 });
    return completed(["answer.md"]);
  });
  const f = await fixture(runtime);
  try {
    input = join(f.root, "input.md");
    await writeFile(input, "Original immutable comparison fixture", {
      mode: 0o600,
    });
    const specification = suite();
    specification.cases[0]!.inputs = [input];
    const report = await compareRuns(
      specification,
      f.config,
      f.store,
      () => f.harness,
      new AbortController().signal,
    );
    assert.equal(runtime.requests.length, 1);
    assert.deepEqual(
      report.rows.map((row) => row.comparable),
      [false, false],
    );
    assert.equal(report.rows[1]!.state, "setup_failed");
    assert.match(report.rows[1]!.reason!, /EVAL_BASELINE_CHANGED/);
    assert.deepEqual(
      comparisonSummary(report).map((row) => row.checksPassRate),
      [null, null],
    );
    assert.equal(report.rows[0]!.checksPassed, true);
  } finally {
    await f.cleanup();
  }
});

test("provider-unknown usage and failed attempts remain unknown rather than zero", async () => {
  let calls = 0;
  const runtime: Runtime = {
    async run(request) {
      const reservation = request.beforeRequest(
        Buffer.byteLength(request.objective),
      );
      if (calls++ > 0)
        throw new Error("Synthetic interrupted provider request");
      await call(request, "write_file", {
        path: "answer.md",
        content: "青葉会議 2026年11月5日 14:30 0円",
        expectedSha256: null,
      });
      request.afterRequest(reservation, {
        input: null,
        output: 10,
        costUsd: null,
      });
      return completed(["answer.md"]);
    },
    async close() {},
  };
  const f = await fixture(runtime);
  try {
    const specification = suite();
    specification.variants[1]!.mode = "single";
    const report = await compareRuns(
      specification,
      f.config,
      f.store,
      () => f.harness,
      new AbortController().signal,
    );
    assert.equal(report.rows[0]!.inputTokens, null);
    assert.equal(report.rows[0]!.outputTokens, 10);
    assert.equal(report.rows[0]!.totalCostUsd, null);
    assert.equal(report.rows[0]!.knownCostUsd, 0);
    assert.equal(report.rows[0]!.checksPassed, true);
    const connection = f.store.usageByConnection(report.rows[0]!.runId!)[0]!;
    assert.equal(connection.inputTokens, null);
    assert.equal(connection.outputTokens, 10);
    assert.equal(connection.usageComplete, false);
    assert.equal(report.rows[1]!.requests, 1);
    assert.equal(report.rows[1]!.state, "failed");
    assert.equal(report.rows[1]!.inputTokens, null);
    assert.equal(report.rows[1]!.outputTokens, null);
    assert.equal(report.rows[1]!.totalCostUsd, null);
    assert.equal(report.rows[1]!.checksPassed, false);
    assert.equal(comparisonSummary(report)[1]!.failed, 1);
    assert.equal(comparisonSummary(report)[1]!.attemptSuccessRate, 0);
    assert.equal(comparisonSummary(report)[1]!.checksPassRate, 0);
    assert.equal((await readComparison(f.p, report.id)).rows.length, 2);
  } finally {
    await f.cleanup();
  }
});

test("comparison refuses a harness with a different budget before any request", async () => {
  const runtime = new ScriptedRuntime(async () => "must not run");
  const f = await fixture(runtime);
  try {
    const expected = structuredClone(f.config);
    expected.limits.maxRequests += 1;
    const report = await compareRuns(
      suite(),
      expected,
      f.store,
      () => f.harness,
      new AbortController().signal,
    );
    assert.equal(runtime.requests.length, 0);
    assert.ok(
      report.rows.every(
        (row) =>
          row.state === "setup_failed" && row.requests === 0 && !row.comparable,
      ),
    );
    assert.ok(
      report.rows.every((row) => row.reason?.includes("EVAL_CONFIG_CHANGED")),
    );
  } finally {
    await f.cleanup();
  }
});

test("cancellation leaves a recoverable partial report", async () => {
  const abort = new AbortController();
  const runtime = new ScriptedRuntime(async (request) => {
    await call(request, "write_file", {
      path: "answer.md",
      content: "青葉会議 2026年11月5日 14:30 0円",
      expectedSha256: null,
    });
    return completed(["answer.md"]);
  });
  const f = await fixture(runtime);
  let capture: ComparisonReport | undefined;
  try {
    await assert.rejects(
      compareRuns(
        suite(),
        f.config,
        f.store,
        () => f.harness,
        abort.signal,
        (report) => {
          capture = report;
          if (report.rows.length === 1) abort.abort();
        },
      ),
      { name: "AbortError" },
    );
    assert.ok(capture);
    assert.equal(capture.complete, false);
    assert.equal(capture.rows.length, 1);
    const persisted = JSON.parse(
      await readFile(
        join(f.p.home, "comparisons", `${capture.id}.json`),
        "utf8",
      ),
    ) as ComparisonReport;
    assert.equal(persisted.complete, false);
    assert.equal(persisted.rows.length, 1);
    const unknown = structuredClone(persisted);
    unknown.rows[0]!.totalCostUsd = null;
    assert.equal(comparisonSummary(unknown)[0]!.totalCostUsd, null);
    assert.equal(comparisonSummary(unknown)[1]!.checksPassRate, null);
  } finally {
    await f.cleanup();
  }
});
