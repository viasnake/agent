import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import lockfile from "proper-lockfile";
import { z } from "zod";
import type { Config, Paths } from "./config.js";
import { configHash } from "./config.js";
import type { Harness, NewRun } from "./harness.js";
import type { Store } from "./storage.js";
import type { Run } from "./types.js";
import { AgentError } from "./types.js";
import {
  atomicWrite,
  canonical,
  errorMessage,
  id,
  privateDirectory,
  sha256,
} from "./util.js";
import { readSnapshot } from "./workspace.js";

const name = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
const variantSchema = z.strictObject({
  id: name,
  mode: z.enum(["single", "reviewed", "assisted"]),
  model: name.optional(),
  reviewer: name.optional(),
});
const caseSchema = z.strictObject({
  id: name,
  objective: z.string().min(1).max(120000),
  kind: z.enum(["coding", "research", "writing"]),
  workspace: z.string().optional(),
  inputs: z.array(z.string()).max(100).default([]),
  checks: z.array(name).max(100).default([]),
  mustKeep: z.array(z.string().min(1)).max(100).default([]),
  dataClass: z.enum(["public", "private", "restricted"]).default("private"),
  localOnly: z.boolean().default(false),
});
export const comparisonSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    name: z.string().min(1).max(200),
    repeats: z.number().int().min(1).max(10).default(1),
    cases: z.array(caseSchema).min(1).max(100),
    variants: z.array(variantSchema).min(2).max(10),
  })
  .superRefine((suite, ctx) => {
    for (const field of ["cases", "variants"] as const) {
      if (
        new Set(suite[field].map((entry) => entry.id)).size !==
        suite[field].length
      )
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: "IDs must be unique",
        });
    }
    if (suite.cases.length * suite.variants.length * suite.repeats > 200)
      ctx.addIssue({
        code: "custom",
        message: "At most 200 runs per comparison",
      });
  });
export type ComparisonSuite = z.infer<typeof comparisonSchema>;

export const assessmentSchema = z.strictObject({
  reviewer: z.string().min(1).max(200),
  accepted: z.boolean(),
  majorDefects: z.number().int().nonnegative().max(100000),
  reworkCount: z.number().int().nonnegative().max(100000),
  evidence: z.string().min(1).max(20000),
});
export type Assessment = z.infer<typeof assessmentSchema>;
export interface ComparisonRow {
  caseId: string;
  variantId: string;
  repeat: number;
  runId?: string;
  state: Run["state"] | "setup_failed";
  reason?: string;
  elapsedMs: number;
  baselineHash?: string;
  comparable: boolean;
  checksPassed: boolean;
  validation: { id: string; passed: boolean; detail: string }[];
  requests: number;
  inputTokens: number | null;
  outputTokens: number | null;
  knownCostUsd: number;
  totalCostUsd: number | null;
  heldUsd: number;
  repairAttempts: number;
  models: string[];
  artifacts: { id: string; name: string; sha256: string }[];
  assessment?: Assessment;
}
export interface ComparisonReport {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  configHash: string;
  suite: ComparisonSuite;
  rows: ComparisonRow[];
  complete: boolean;
  limitations: string[];
  assessmentLog?: { runId: string; at: string; assessment: Assessment }[];
}

const count = z.number().int().nonnegative();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const rowSchema = z.strictObject({
  caseId: name,
  variantId: name,
  repeat: count,
  runId: z.uuid().optional(),
  state: z.enum([
    "created",
    "planning",
    "running",
    "validating",
    "repairing",
    "waiting_input",
    "waiting_quota",
    "waiting_approval",
    "succeeded",
    "failed",
    "cancelled",
    "setup_failed",
  ]),
  reason: z.string().optional(),
  elapsedMs: z.number().nonnegative(),
  baselineHash: digest.optional(),
  comparable: z.boolean(),
  checksPassed: z.boolean(),
  validation: z.array(
    z.strictObject({ id: z.string(), passed: z.boolean(), detail: z.string() }),
  ),
  requests: count,
  inputTokens: count.nullable(),
  outputTokens: count.nullable(),
  knownCostUsd: z.number().nonnegative(),
  totalCostUsd: z.number().nonnegative().nullable(),
  heldUsd: z.number().nonnegative(),
  repairAttempts: count,
  models: z.array(name),
  artifacts: z.array(
    z.strictObject({ id: z.uuid(), name: z.string(), sha256: digest }),
  ),
  assessment: assessmentSchema.optional(),
});
const reportSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: z.uuid(),
    createdAt: z.iso.datetime(),
    configHash: digest,
    suite: comparisonSchema,
    rows: z.array(rowSchema).max(200),
    complete: z.boolean(),
    limitations: z.array(z.string()),
    assessmentLog: z
      .array(
        z.strictObject({
          runId: z.uuid(),
          at: z.iso.datetime(),
          assessment: assessmentSchema,
        }),
      )
      .optional(),
  })
  .superRefine((report, ctx) => {
    const keys = new Set<string>();
    const runIds = new Set<string>();
    for (const row of report.rows) {
      const key = `${row.caseId}/${row.variantId}/${row.repeat}`;
      if (
        keys.has(key) ||
        (row.runId && runIds.has(row.runId)) ||
        row.repeat >= report.suite.repeats ||
        !report.suite.cases.some((item) => item.id === row.caseId) ||
        !report.suite.variants.some((item) => item.id === row.variantId)
      )
        ctx.addIssue({
          code: "custom",
          message: "Invalid or duplicate comparison pair",
        });
      keys.add(key);
      if (row.runId) runIds.add(row.runId);
    }
    if (
      report.complete &&
      report.rows.length !== comparisonSchedule(report.suite).length
    )
      ctx.addIssue({
        code: "custom",
        message: "Completed report has missing attempts",
      });
  });
const maxReportBytes = 64_000_000;

export async function readComparison(
  paths: Paths,
  reportId: string,
): Promise<ComparisonReport> {
  z.uuid().parse(reportId);
  await privateDirectory(paths.home);
  const directory = join(paths.home, "comparisons");
  await privateDirectory(directory);
  const file = await open(
    join(directory, `${reportId}.json`),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.mode & 0o077 ||
      (process.getuid && stat.uid !== process.getuid()) ||
      stat.size > maxReportBytes
    )
      throw new AgentError(
        "EVAL_STORAGE",
        "Comparison report must be a bounded private regular file",
      );
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await file.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (!read.bytesRead)
        throw new AgentError(
          "EVAL_STORAGE",
          "Comparison report changed while reading",
        );
      offset += read.bytesRead;
    }
    if ((await file.stat()).size !== stat.size)
      throw new AgentError(
        "EVAL_STORAGE",
        "Comparison report changed while reading",
      );
    const report = reportSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (report.id !== reportId)
      throw new AgentError("EVAL_STORAGE", "Comparison report ID mismatch");
    return report;
  } finally {
    await file.close();
  }
}

export async function assessComparison(
  paths: Paths,
  reportId: string,
  runId: string,
  assessment: unknown,
): Promise<ComparisonReport> {
  const parsed = assessmentSchema.parse(assessment);
  const initial = await readComparison(paths, reportId);
  if (!initial.complete)
    throw new AgentError(
      "EVAL_ACTIVE",
      "Assess only a completed comparison; partial reports remain available for inspection",
    );
  const path = join(paths.home, "comparisons", `${reportId}.json`);
  const release = await lockfile.lock(path, { realpath: false, retries: 0 });
  try {
    const report = await readComparison(paths, reportId);
    if (!report.complete)
      throw new AgentError("EVAL_ACTIVE", "Comparison is still active");
    const row = report.rows.find((value) => value.runId === runId);
    if (!row)
      throw new AgentError(
        "EVAL_RUN",
        "Run does not belong to this comparison",
      );
    row.assessment = parsed;
    report.assessmentLog = [
      ...(report.assessmentLog ?? []),
      { runId, at: new Date().toISOString(), assessment: parsed },
    ];
    const content = JSON.stringify(report, null, 2);
    if (Buffer.byteLength(content) > maxReportBytes)
      throw new AgentError("EVAL_SIZE", "Comparison report is too large");
    await atomicWrite(path, content);
    return report;
  } finally {
    await release();
  }
}

export function comparisonSchedule(suite: ComparisonSuite) {
  const schedule: {
    caseIndex: number;
    variantIndex: number;
    repeat: number;
  }[] = [];
  for (let repeat = 0; repeat < suite.repeats; repeat++)
    for (let caseIndex = 0; caseIndex < suite.cases.length; caseIndex++)
      for (let offset = 0; offset < suite.variants.length; offset++)
        schedule.push({
          caseIndex,
          variantIndex: (offset + repeat + caseIndex) % suite.variants.length,
          repeat,
        });
  return schedule;
}

export function comparisonSummary(report: ComparisonReport) {
  return report.suite.variants.map((variant) => {
    const rows = report.rows.filter((row) => row.variantId === variant.id);
    const comparable = rows.filter((row) => row.comparable);
    const reviewed = comparable.filter((row) => row.assessment !== undefined);
    const sum = (key: "elapsedMs" | "requests" | "knownCostUsd") =>
      rows.reduce((n, row) => n + row[key], 0);
    return {
      variantId: variant.id,
      attempted: rows.length,
      expected: report.suite.cases.length * report.suite.repeats,
      comparable: comparable.length,
      setupFailed: rows.filter((row) => row.state === "setup_failed").length,
      failed: rows.filter((row) => row.state === "failed").length,
      attemptSuccessRate: rows.length
        ? rows.filter((row) => row.state === "succeeded").length / rows.length
        : null,
      checksPassed: comparable.filter((row) => row.checksPassed).length,
      checksPassRate: comparable.length
        ? comparable.filter((row) => row.checksPassed).length /
          comparable.length
        : null,
      humanReviewed: reviewed.length,
      humanAcceptanceRate: reviewed.length
        ? reviewed.filter((row) => row.assessment!.accepted).length /
          reviewed.length
        : null,
      majorDefects: reviewed.length
        ? reviewed.reduce((n, row) => n + row.assessment!.majorDefects, 0)
        : null,
      reworkCount: reviewed.length
        ? reviewed.reduce((n, row) => n + row.assessment!.reworkCount, 0)
        : null,
      meanElapsedMs: rows.length ? sum("elapsedMs") / rows.length : null,
      requests: sum("requests"),
      knownCostUsd: sum("knownCostUsd"),
      totalCostUsd:
        rows.length && rows.every((row) => row.totalCostUsd !== null)
          ? rows.reduce((n, row) => n + row.totalCostUsd!, 0)
          : null,
    };
  });
}

export async function compareRuns(
  input: unknown,
  config: Config,
  store: Store,
  createHarness: () => Harness,
  signal: AbortSignal,
  notify: (report: ComparisonReport) => void = () => {},
): Promise<ComparisonReport> {
  const suite = comparisonSchema.parse(input);
  const report: ComparisonReport = {
    schemaVersion: 1,
    id: id(),
    createdAt: new Date().toISOString(),
    configHash: configHash(config),
    suite,
    rows: [],
    complete: false,
    limitations: [
      "Check success is not a semantic quality score; factual support, Japanese prose and major defects require evidence-backed human assessment.",
      "Missing usage or cost is null, not zero. Failed, cancelled and setup-failed attempts remain in the report.",
      "Variant order is rotated, not randomized. Caching, provider load, rate limits and model nondeterminism are not controlled. No statistical superiority is claimed.",
      "Every run has the same configured per-run budget and fresh workspace/session; collaboration overhead counts toward that budget. No patch is applied to the original workspace.",
    ],
  };
  const directory = join(store.paths.home, "comparisons");
  await privateDirectory(store.paths.home);
  await privateDirectory(directory);
  const persist = async () => {
    const serialized = JSON.stringify(report, null, 2);
    if (Buffer.byteLength(serialized) > maxReportBytes)
      throw new AgentError("EVAL_SIZE", "Comparison report is too large");
    await atomicWrite(join(directory, `${report.id}.json`), serialized);
    notify(structuredClone(report));
  };
  await persist();
  const baselines = new Map<string, string>();
  const invalidCases = new Set<string>();
  for (const item of comparisonSchedule(suite)) {
    signal.throwIfAborted();
    const entry = suite.cases[item.caseIndex]!;
    const variant = suite.variants[item.variantIndex]!;
    const row: ComparisonRow = {
      caseId: entry.id,
      variantId: variant.id,
      repeat: item.repeat,
      state: "setup_failed",
      elapsedMs: 0,
      comparable: false,
      checksPassed: false,
      validation: [],
      requests: 0,
      inputTokens: null,
      outputTokens: null,
      knownCostUsd: 0,
      totalCostUsd: null,
      heldUsd: 0,
      repairAttempts: 0,
      models: [],
      artifacts: [],
    };
    const started = performance.now();
    try {
      if (invalidCases.has(entry.id))
        throw new AgentError(
          "EVAL_BASELINE_CHANGED",
          "This case was invalidated by an input/workspace change; no provider request was sent",
        );
      const runner = createHarness();
      if (configHash(runner.config) !== report.configHash)
        throw new AgentError(
          "EVAL_CONFIG_CHANGED",
          "Comparison configuration changed; no provider request was sent",
        );
      const { id: _case, ...request } = entry;
      const { id: _variant, ...profile } = variant;
      const run = await runner.create({
        ...request,
        ...profile,
      } satisfies NewRun);
      row.runId = run.id;
      const snapshot = await readSnapshot(store.runDir(run.id));
      row.baselineHash = sha256(
        canonical({
          files: snapshot.files,
          inputs: store
            .artifacts(run.id)
            .filter((a) => a.kind === "source")
            .map((a) => ({ name: a.name, sha256: a.sha256 }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        }),
      );
      const baseline = baselines.get(entry.id);
      if (baseline && baseline !== row.baselineHash) {
        invalidCases.add(entry.id);
        for (const previous of report.rows)
          if (previous.caseId === entry.id) previous.comparable = false;
        throw new AgentError(
          "EVAL_BASELINE_CHANGED",
          "Input/workspace changed between comparison runs; no provider request was sent for this attempt",
        );
      }
      baselines.set(entry.id, row.baselineHash);
      row.comparable = true;
      const result = await runner.execute(run.id, signal);
      row.state = result.state;
      if (result.reason !== undefined) row.reason = result.reason;
      row.repairAttempts = result.repairAttempts;
      row.models = [
        ...new Set(
          result.tasks
            .map((task) => task.model)
            .filter((model): model is string => !!model),
        ),
      ];
      const validationEvent = store.db
        .prepare(
          "SELECT detail FROM events WHERE run_id=? AND type='artifact_saved' AND json_extract(detail,'$.name')='validation.json' AND json_extract(detail,'$.kind')='check' ORDER BY seq DESC LIMIT 1",
        )
        .get(run.id) as { detail: string } | undefined;
      const artifacts = store.artifacts(run.id);
      if (validationEvent) {
        const artifactId = (
          JSON.parse(validationEvent.detail) as { artifactId: string }
        ).artifactId;
        const artifact = artifacts.find((value) => value.id === artifactId);
        if (artifact)
          row.validation = z
            .array(
              z.strictObject({
                id: z.string(),
                passed: z.boolean(),
                detail: z.string(),
              }),
            )
            .parse(
              JSON.parse((await store.content(artifact)).toString("utf8")),
            );
      }
      row.checksPassed =
        result.state === "succeeded" &&
        row.validation.length > 0 &&
        row.validation.every((check) => check.passed);
      row.artifacts = artifacts
        .filter((a) => ["document", "patch", "check"].includes(a.kind))
        .map(({ id, name, sha256 }) => ({ id, name, sha256 }));
    } catch (error) {
      row.reason = errorMessage(error);
      if (row.runId && row.comparable) row.state = store.get(row.runId).state;
    } finally {
      row.elapsedMs = performance.now() - started;
      if (row.runId) {
        const usage = store.usage(row.runId);
        row.requests = usage.requests;
        row.inputTokens = usage.input;
        row.outputTokens = usage.output;
        row.knownCostUsd = usage.knownCostUsd;
        row.totalCostUsd =
          usage.requests &&
          usage.unknownCostRequests === 0 &&
          usage.heldUsd === 0
            ? usage.knownCostUsd
            : null;
        row.heldUsd = usage.heldUsd;
      }
      report.rows.push(row);
      await persist();
    }
    signal.throwIfAborted();
  }
  report.complete = true;
  await persist();
  return report;
}
