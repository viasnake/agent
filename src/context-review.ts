import { z } from "zod";
import { requireAuthorizedSource } from "./collaboration.js";
import { Store } from "./storage.js";
import {
  AgentError,
  terminalStates,
  type ContextIssue,
  type Run,
  type Task,
} from "./types.js";
import { canonical, id, sha256 } from "./util.js";

const idSchema = z.string().min(1).max(160);
const issueSchema = z.object({
  kind: z.enum(["missing_condition", "contradiction", "repeated_exploration"]),
  detail: z.string().min(1).max(4000),
  evidence: z.string().min(1).max(2000),
  sourceIds: z.array(idSchema).max(8).default([]),
  archiveIds: z.array(idSchema).max(8).default([]),
  operationIds: z.array(idSchema).max(8).default([]),
});
export type ContextIssueInput = z.input<typeof issueSchema>;

export interface ContextReviewPreview {
  runId: string;
  generation: number;
  binding: string;
  issues: ContextIssue[];
  policy: {
    dataClass: Run["dataClass"];
    localOnly: boolean;
    access?: Run["access"];
    constraints: string[];
    checks: string[];
    mustKeep: string[];
    usage: ReturnType<Store["usage"]>;
  };
}

function pendingIssues(run: Run): ContextIssue[] {
  return (run.contextIssues ?? []).filter((issue) => !issue.acknowledged);
}

export function assertContextReady(run: Run): void {
  const issue = pendingIssues(run)[0];
  if (issue)
    throw new AgentError(
      "CONTEXT_REVIEW_REQUIRED",
      `Context integrity requires human review; use /context-review (${issue.id})`,
    );
}

function bounded(value: string, maxBytes: number, label: string): string {
  if (!value.trim() || Buffer.byteLength(value) > maxBytes)
    throw new AgentError("CONTEXT_REVIEW", `${label} is invalid or too large`);
  return value;
}

function authorizedArchiveIds(run: Run, task: Task): Set<string> {
  return new Set(
    task.delegatedBy
      ? (task.contextArchiveIds ?? [])
      : [
          ...(run.compactions ?? []),
          ...(run.contextState?.compactions ?? []),
        ].map((record) => record.archiveId),
  );
}

function validateReferences(
  store: Store,
  run: Run,
  task: Task,
  input: z.output<typeof issueSchema>,
): void {
  for (const sourceId of input.sourceIds)
    requireAuthorizedSource(store, run, task, sourceId);
  const archives = authorizedArchiveIds(run, task);
  if (input.archiveIds.some((archiveId) => !archives.has(archiveId)))
    throw new AgentError(
      "SOURCE",
      "Context archive does not belong to this task or conversation",
    );
  const operations = new Set(
    store
      .operations(run.id)
      .filter((operation) => operation.task_id === task.id)
      .map((operation) => operation.id),
  );
  if (input.operationIds.some((operationId) => !operations.has(operationId)))
    throw new AgentError("SOURCE", "Operation does not belong to this task");
}

export function recordContextIssue(
  store: Store,
  run: Run,
  task: Task,
  input: ContextIssueInput,
  origin: "host" | "model",
): ContextIssue {
  store.assertLease(run.id, run.generation);
  const existing = pendingIssues(run)[0];
  if (existing) return structuredClone(existing);
  if ((run.contextIssues?.length ?? 0) >= 32)
    throw new AgentError(
      "CONTEXT_LIMIT",
      "Context review history is full; start a new conversation",
    );
  const parsed = issueSchema.parse(input);
  if (origin === "model") validateReferences(store, run, task, parsed);
  const issue: ContextIssue = {
    id: id(),
    taskId: task.id,
    at: Date.now(),
    kind: parsed.kind,
    origin,
    detail: bounded(parsed.detail, 4000, "Context issue detail"),
    evidence: bounded(parsed.evidence, 2000, "Context issue evidence"),
    sourceIds: [...parsed.sourceIds],
    archiveIds: [...parsed.archiveIds],
    operationIds: [...parsed.operationIds],
  };
  run.contextIssues = [...(run.contextIssues ?? []), issue];
  store.save(run, "context_issue_recorded", {
    issueId: issue.id,
    taskId: task.id,
    kind: issue.kind,
    origin,
  });
  return structuredClone(issue);
}

async function repeatedReadIssue(
  store: Store,
  run: Run,
  task: Task,
): Promise<ContextIssue | undefined> {
  const cursor = run.contextReviewCursor;
  const rows = store.db
    .prepare(
      `SELECT o.id,o.name,o.status,o.args_hash,a.payload
       FROM operations o
       LEFT JOIN artifacts a ON a.id=o.result AND a.run_id=o.run_id
       WHERE o.run_id=? AND o.task_id=?
         AND o.rowid>COALESCE((SELECT rowid FROM operations WHERE run_id=? AND id=?),0)
       ORDER BY o.rowid DESC LIMIT 16`,
    )
    .all(run.id, task.id, run.id, cursor ?? "") as Array<{
    id: string;
    name: string;
    status: string;
    args_hash: string;
    payload: string | null;
  }>;
  const reads = new Set([
    "read_file",
    "read_source",
    "list_files",
    "search_files",
    "code_info",
    "read_context",
    "read_task_report",
    "read_research_checkpoint",
  ]);
  const counts = new Map<string, { ids: string[]; sha256: string }>();
  for (const row of rows) {
    if (!reads.has(row.name) || row.status !== "completed" || !row.payload)
      break;
    let artifact: {
      id?: unknown;
      sha256?: unknown;
      metadata?: Record<string, unknown>;
    };
    try {
      artifact = JSON.parse(row.payload);
    } catch {
      break;
    }
    if (
      artifact.metadata?.taskId !== task.id ||
      artifact.metadata?.operationId !== row.id ||
      artifact.metadata?.tool !== row.name ||
      typeof artifact.sha256 !== "string"
    )
      break;
    let content: Buffer;
    try {
      content = await store.content({
        id: String(artifact.id ?? ""),
        runId: run.id,
        name: `tool-${row.id}.txt`,
        kind: "report",
        sha256: artifact.sha256,
        bytes: 0,
        dataClass: run.dataClass,
        metadata: artifact.metadata ?? {},
      });
    } catch {
      break;
    }
    if (sha256(content) !== artifact.sha256) break;
    const key = `${row.name}:${row.args_hash}:${artifact.sha256}`;
    const prior = counts.get(key) ?? { ids: [], sha256: artifact.sha256 };
    prior.ids.push(row.id);
    counts.set(key, prior);
    if (prior.ids.length >= 4)
      return recordContextIssue(
        store,
        run,
        task,
        {
          kind: "repeated_exploration",
          detail:
            "The same exploration read was repeated without verified progress.",
          evidence: `Repeated operation IDs: ${prior.ids.slice(0, 4).join(", ")}; result ${prior.sha256}`,
          operationIds: prior.ids.slice(0, 8),
          sourceIds: [],
          archiveIds: [],
        },
        "host",
      );
  }
  return undefined;
}

export async function inspectCompletedRead(
  store: Store,
  run: Run,
  task: Task,
): Promise<ContextIssue | undefined> {
  return repeatedReadIssue(store, run, task);
}

function previewBinding(run: Run, usage: ReturnType<Store["usage"]>): string {
  return sha256(canonical({ run, usage }));
}

export function previewContextReview(
  store: Store,
  runId: string,
): ContextReviewPreview {
  const run = store.get(runId);
  store.assertIdle(runId);
  const issues = pendingIssues(run);
  if (!issues.length)
    throw new AgentError("CONTEXT_REVIEW", "No pending context issue");
  if (
    !["waiting_input", "waiting_quota", "waiting_approval"].includes(
      run.state,
    ) &&
    !terminalStates.includes(run.state)
  )
    throw new AgentError("CONTEXT_REVIEW", "Run is not idle");
  const usage = store.usage(run.id);
  return structuredClone({
    runId: run.id,
    generation: run.generation,
    binding: previewBinding(run, usage),
    issues,
    policy: {
      dataClass: run.dataClass,
      localOnly: run.localOnly,
      access: run.access,
      constraints: run.constraints ?? [],
      checks: run.checks,
      mustKeep: run.mustKeep,
      usage,
    },
  });
}

export function confirmContextReview(
  store: Store,
  preview: ContextReviewPreview,
  note: string,
): Run {
  bounded(note, 2000, "Context review note");
  store.assertIdle(preview.runId);
  let run: Run | undefined;
  try {
    run = store.claim(preview.runId, false, true, (candidate) => {
      const issues = pendingIssues(candidate);
      if (
        !issues.length ||
        (!["waiting_input", "waiting_quota", "waiting_approval"].includes(
          candidate.state,
        ) &&
          !terminalStates.includes(candidate.state))
      )
        throw new AgentError(
          "CONTEXT_REVIEW",
          "Run is not eligible for review",
        );
      const usage = store.usage(candidate.id);
      if (preview.binding !== previewBinding(candidate, usage))
        throw new AgentError("CONTEXT_REVIEW_STALE", "Context review is stale");
    });
    const latest = store.db
      .prepare(
        "SELECT id FROM operations WHERE run_id=? ORDER BY rowid DESC LIMIT 1",
      )
      .get(run.id) as { id?: string } | undefined;
    const at = Date.now();
    run.contextIssues = (run.contextIssues ?? []).map((issue) =>
      issue.acknowledged ? issue : { ...issue, acknowledged: { at, note } },
    );
    run.contextReviewCursor = latest?.id;
    const acknowledgedTaskIds = new Set(
      preview.issues.map((issue) => issue.taskId),
    );
    for (const task of run.tasks)
      if (acknowledgedTaskIds.has(task.id))
        task.contextReviewCount = (task.contextReviewCount ?? 0) + 1;
    if (!terminalStates.includes(run.state)) {
      run.state = "waiting_input";
      run.reason =
        "Context reviewed; explicit resume or new request is required";
    } else run.reason = "Context reviewed; explicit new request is required";
    store.save(run, "context_review_confirmed", {
      issueCount: preview.issues.length,
    });
    return structuredClone(run);
  } finally {
    if (run) store.release(run);
  }
}
