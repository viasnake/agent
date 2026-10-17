import { AgentError, type Artifact, type Run, type Task } from "./types.js";
import type { Store } from "./storage.js";
import type { Config } from "./config.js";
import { id, sha256 } from "./util.js";

export function assertReviewerIndependence(
  config: Config,
  tasks: Task[],
): void {
  for (const reviewer of tasks.filter((task) => task.role === "reviewer")) {
    const reviewerModel = config.models[reviewer.model!]?.id;
    if (!reviewerModel) continue;
    const visited = new Set<string>();
    const pending = [...reviewer.dependsOn];
    while (pending.length) {
      const taskId = pending.pop()!;
      if (visited.has(taskId)) continue;
      visited.add(taskId);
      const producer = tasks.find((task) => task.id === taskId);
      if (!producer) continue;
      if (
        producer.role !== "reviewer" &&
        producer.model &&
        config.models[producer.model]?.id === reviewerModel
      )
        throw new AgentError(
          "INVALID_PLAN",
          "A reviewer must use a model distinct from every producer",
        );
      pending.push(...producer.dependsOn);
    }
  }
}

export function isCollaborative(run: Run): boolean {
  return run.mode !== "single";
}

export function isStructuredCollaboration(run: Run, task: Task): boolean {
  return isCollaborative(run) && task.resultFormat === "structured";
}

export function sourceAuthorized(
  store: Store,
  run: Run,
  task: Task,
  source: Artifact,
  ownedSourceIds?: ReadonlySet<string>,
): boolean {
  if (source.kind !== "source") return false;
  if (task.delegatedBy && !task.assignment?.sourceIds.includes(source.id))
    return false;
  const context = run.contextState;
  if (context?.excludedSourceIds?.includes(source.id)) return false;
  if (
    [source.sha256, source.metadata.rawSha256, source.metadata.selectedSha256]
      .filter((value): value is string => typeof value === "string")
      .some((hash) => context?.excludedSourceHashes?.includes(hash))
  )
    return false;
  if (
    [
      source.metadata.url,
      source.metadata.requestedUrl,
      source.metadata.finalUrl,
    ]
      .filter((value): value is string => typeof value === "string")
      .some((url) => context?.excludedSourceUrls?.includes(url))
  )
    return false;
  return ownedSourceIds
    ? ownedSourceIds.has(source.id)
    : store
        .artifacts(run.id)
        .some(
          (candidate) =>
            candidate.id === source.id && candidate.kind === "source",
        );
}

export function authorizedSources(
  store: Store,
  run: Run,
  task: Task,
): Artifact[] {
  const artifacts = store.artifacts(run.id),
    ownedSourceIds = new Set(
      artifacts
        .filter((artifact) => artifact.kind === "source")
        .map((artifact) => artifact.id),
    );
  return artifacts.filter((artifact) =>
    sourceAuthorized(store, run, task, artifact, ownedSourceIds),
  );
}

export function requireAuthorizedSource(
  store: Store,
  run: Run,
  task: Task,
  sourceId: string,
): Artifact {
  const source = authorizedSources(store, run, task).find(
    (artifact) => artifact.id === sourceId,
  );
  if (!source)
    throw new AgentError(
      "SOURCE",
      "Source does not belong to this task or is unavailable",
    );
  return source;
}

export function authorizedTaskReportIds(run: Run, task: Task): Set<string> {
  const ids = new Set(task.attemptReportIds ?? []);
  if (task.delegatedBy) return ids;
  for (const link of task.reworkLinks ?? [])
    for (const reportId of link.priorReportIds) ids.add(reportId);
  const visited = new Set<string>();
  const visit = (taskId: string) => {
    if (visited.has(taskId)) return;
    visited.add(taskId);
    const dependency = run.tasks.find((candidate) => candidate.id === taskId);
    if (!dependency) return;
    for (const reportId of dependency.attemptReportIds ?? []) ids.add(reportId);
    for (const dependencyId of dependency.dependsOn) visit(dependencyId);
  };
  for (const dependencyId of task.dependsOn) visit(dependencyId);
  return ids;
}

export async function authorizedTaskReportSummaries(
  store: Store,
  run: Run,
  task: Task,
  maxBytes = 24_000,
): Promise<Array<Record<string, unknown>>> {
  const reportIds = authorizedTaskReportIds(run, task),
    artifacts = new Map(
      store.artifacts(run.id).map((artifact) => [artifact.id, artifact]),
    ),
    summaries: Array<Record<string, unknown>> = [];
  let usedBytes = 0,
    omitted = 0;
  for (const reportId of reportIds) {
    const artifact = artifacts.get(reportId);
    if (
      !artifact ||
      artifact.kind !== "report" ||
      artifact.metadata.type !== "task-attempt"
    )
      continue;
    const owner = run.tasks.find(
      (candidate) =>
        candidate.id === artifact.metadata.taskId &&
        candidate.attemptReportIds?.includes(reportId),
    );
    if (!owner) continue;
    let parsed: {
      taskId?: unknown;
      attempt?: unknown;
      result?: {
        outcome?: unknown;
        summary?: unknown;
        unresolved?: unknown;
      };
      rawFailure?: unknown;
      hostError?: unknown;
    };
    try {
      parsed = JSON.parse((await store.content(artifact)).toString("utf8"));
    } catch {
      continue;
    }
    if (
      parsed.taskId !== owner.id ||
      parsed.attempt !== artifact.metadata.attempt ||
      !Number.isSafeInteger(parsed.attempt)
    )
      continue;
    const base = {
      reportId,
      taskId: owner.id,
      attempt: parsed.attempt,
      outcome: boundedSummary(
        parsed.result?.outcome,
        artifact.metadata.outcome,
        40,
      ),
    };
    const optional = {
        summary: boundedSummary(parsed.result?.summary, undefined, 800),
        unresolved: Array.isArray(parsed.result?.unresolved)
          ? parsed.result.unresolved
              .slice(0, 4)
              .map((value) => boundedSummary(value, undefined, 300))
          : [],
        rawFailure: boundedSummary(parsed.rawFailure, undefined, 800),
        hostError: boundedSummary(parsed.hostError, undefined, 400),
      },
      baseBytes = Buffer.byteLength(JSON.stringify(base));
    if (usedBytes + baseBytes > maxBytes) {
      omitted++;
      continue;
    }
    const optionalBytes = Buffer.byteLength(JSON.stringify(optional));
    if (usedBytes + baseBytes + optionalBytes > maxBytes) {
      summaries.push({ ...base, truncated: true });
      usedBytes += baseBytes;
    } else {
      summaries.push({ ...base, ...optional });
      usedBytes += baseBytes + optionalBytes;
    }
  }
  if (omitted) summaries.push({ truncated: true, omittedReports: omitted });
  summaries.unshift({
    authorizedReportIds: [...reportIds].slice(0, 128),
    authorizedReportCount: reportIds.size,
    ...(reportIds.size > 128 ? { authorizedReportIdsTruncated: true } : {}),
  });
  return summaries;
}

export async function saveAttemptReport(
  store: Store,
  run: Run,
  task: Task | undefined,
  taskId: string,
  model: string | undefined,
  attempt: number,
  contents: {
    assignment?: Task["assignment"];
    result?: unknown;
    rawFailure?: string;
    hostError?: string;
  },
  options: {
    terminalState?: Task["state"];
    onPersist?: (reportId: string) => void;
  } = {},
): Promise<string> {
  const dependencyReportIds: string[] = [];
  if (task && !task.delegatedBy) {
    const visited = new Set<string>();
    const visit = (taskId: string) => {
      if (visited.has(taskId)) return;
      visited.add(taskId);
      const dependency = run.tasks.find((candidate) => candidate.id === taskId);
      if (!dependency) return;
      dependencyReportIds.push(...(dependency.attemptReportIds ?? []));
      for (const dependencyId of dependency.dependsOn) visit(dependencyId);
    };
    for (const dependencyId of task.dependsOn) visit(dependencyId);
  }
  const report: Record<string, unknown> = {
    taskId,
    model,
    attempt,
    assignment: contents.assignment,
    result: contents.result,
    reworkLinks: task?.reworkLinks?.map((link) => ({
      ...link,
      priorReportIds: link.priorReportIds.slice(-50),
      reason: boundedText(link.reason, 2000),
    })),
    rawFailure: boundedText(contents.rawFailure, 20_000),
    hostError: boundedText(contents.hostError, 4000),
    dependencyReportIds: [...new Set(dependencyReportIds)],
    author: "model" as const,
    trusted: false as const,
  };
  const completeText = JSON.stringify(report),
    completeBytes = Buffer.byteLength(completeText);
  let truncated = false;
  if (completeBytes > 128_000) {
    truncated = true;
    report.assignment = boundedJson(contents.assignment, 12_000);
    report.result = boundedResult(contents.result);
    report.reworkLinks = Array.isArray(report.reworkLinks)
      ? report.reworkLinks.slice(-16).map((link) => boundedJson(link, 2_000))
      : report.reworkLinks;
    report.rawFailure = boundedText(contents.rawFailure, 12_000);
    report.hostError = boundedText(contents.hostError, 2_000);
    report.audit = {
      truncated: true,
      fullBytes: completeBytes,
      fullSha256: sha256(completeText),
      note: "The run retains the complete result; this audit evidence is bounded.",
    };
  }
  const text = JSON.stringify(report);
  if (Buffer.byteLength(text) > 128_000)
    throw new AgentError(
      "REPORT_SIZE",
      "Bounded task attempt report is invalid",
    );
  const artifact = await store.artifact(
    run,
    `task-reports/${taskId}-${attempt}-${id()}.json`,
    "report",
    text,
    {
      type: "task-attempt",
      taskId,
      attempt,
      model,
      author: "model",
      trusted: false,
      truncated,
      fullBytes: truncated ? completeBytes : Buffer.byteLength(text),
      fullSha256: truncated ? sha256(completeText) : sha256(text),
    },
    (saved) => {
      if (task)
        task.attemptReportIds = [...(task.attemptReportIds ?? []), saved.id];
      if (options.terminalState && task) task.state = options.terminalState;
      options.onPersist?.(saved.id);
      store.saveInTransaction(
        run,
        options.terminalState === "succeeded"
          ? "task_succeeded"
          : "task_attempt_reported",
        {
          taskId,
          attempt,
          reportId: saved.id,
          ...(options.terminalState === "succeeded" ? { terminal: true } : {}),
        },
      );
    },
  );
  return artifact.id;
}

function boundedSummary(
  value: unknown,
  fallback: unknown,
  maxBytes: number,
): string | undefined {
  const text =
    typeof value === "string"
      ? value
      : typeof fallback === "string"
        ? fallback
        : undefined;
  if (text === undefined) return undefined;
  const bytes = Buffer.from(text);
  if (bytes.length <= maxBytes) return text;
  return `${bytes.subarray(0, maxBytes).toString("utf8")}…[truncated]`;
}

function boundedText(
  value: string | undefined,
  maxBytes: number,
): string | undefined {
  if (!value) return value;
  const bytes = Buffer.from(value);
  if (bytes.length <= maxBytes) return value;
  return `${bytes.subarray(0, maxBytes).toString("utf8")}…[truncated]`;
}

function boundedJson(value: unknown, maxBytes: number): unknown {
  if (value === undefined) return undefined;
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) <= maxBytes) return value;
  return {
    truncated: true,
    fullBytes: Buffer.byteLength(text),
    fullSha256: sha256(text),
    excerpt: boundedText(text, maxBytes),
  };
}

function boundedResult(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const input = result as {
    outcome?: unknown;
    summary?: unknown;
    unresolved?: unknown;
    artifacts?: unknown;
  };
  return {
    outcome: input.outcome,
    summary:
      typeof input.summary === "string"
        ? boundedText(input.summary, 8_000)
        : input.summary,
    unresolved: Array.isArray(input.unresolved)
      ? input.unresolved.slice(0, 16).map((value) => boundedJson(value, 800))
      : input.unresolved,
    artifacts: Array.isArray(input.artifacts)
      ? input.artifacts.slice(0, 32).map((value) => boundedJson(value, 800))
      : input.artifacts,
    truncated: true,
  };
}
