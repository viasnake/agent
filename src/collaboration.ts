import { AgentError, type Artifact, type Run, type Task } from "./types.js";
import type { Store } from "./storage.js";
import { id } from "./util.js";

export function isCollaborative(run: Run): boolean {
  return run.mode !== "single";
}

export function sourceAuthorized(
  store: Store,
  run: Run,
  task: Task,
  source: Artifact,
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
  return store
    .artifacts(run.id)
    .some(
      (candidate) => candidate.id === source.id && candidate.kind === "source",
    );
}

export function authorizedSources(
  store: Store,
  run: Run,
  task: Task,
): Artifact[] {
  return store
    .artifacts(run.id)
    .filter((artifact) => sourceAuthorized(store, run, task, artifact));
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
): Promise<string> {
  const dependencyReportIds: string[] = [];
  if (task) {
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
  const report = {
    taskId,
    model,
    attempt,
    assignment: contents.assignment,
    result: contents.result,
    reworkLinks: task?.reworkLinks,
    rawFailure: boundedText(contents.rawFailure, 20_000),
    hostError: boundedText(contents.hostError, 4000),
    dependencyReportIds: [...new Set(dependencyReportIds)],
    author: "model" as const,
    trusted: false as const,
  };
  const text = JSON.stringify(report);
  if (Buffer.byteLength(text) > 128_000)
    throw new AgentError(
      "REPORT_SIZE",
      "Task attempt report exceeds its limit",
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
    },
  );
  if (task)
    task.attemptReportIds = [...(task.attemptReportIds ?? []), artifact.id];
  store.save(run, "task_attempt_reported", {
    taskId,
    attempt,
    reportId: artifact.id,
  });
  return artifact.id;
}

function boundedText(value: string | undefined, maxBytes: number) {
  if (!value) return value;
  const bytes = Buffer.from(value);
  if (bytes.length <= maxBytes) return value;
  return `${bytes.subarray(0, maxBytes).toString("utf8")}…`;
}
