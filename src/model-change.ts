import type { Config } from "./config.js";
import { configHash } from "./config.js";
import {
  assertReviewerIndependence,
  authorizedSources,
} from "./collaboration.js";
import { modelCandidates } from "./policy.js";
import { Store, type RequestReservation } from "./storage.js";
import {
  AgentError,
  terminalStates,
  type Artifact,
  type ModelChange,
  type Run,
  type Task,
} from "./types.js";
import { canonical, sha256 } from "./util.js";

export interface ModelCandidate {
  alias: string;
  modelId: string;
  connection: string;
  type: Config["connections"][string]["type"];
  endpoint?: string;
  billing: Config["connections"][string]["billing"];
  allowedData: Config["connections"][string]["allowedData"];
  localOnly: boolean;
}

export interface ModelChangeTaskPreview {
  id: string;
  role: Task["role"];
  model?: string;
  state: Task["state"];
  attempts: number;
  affected: boolean;
}

export interface ModelChangePreview {
  runId: string;
  generation: number;
  taskId: string;
  fromModel: string;
  toModel: string;
  binding: string;
  affectedTaskIds: string[];
  tasks: ModelChangeTaskPreview[];
  destination: ModelCandidate;
  dataClass: Run["dataClass"];
  localOnly: boolean;
  access: Run["access"];
  preservedChecks: string[];
  elapsedMs: number;
  remainingSeconds: number;
  usage: ReturnType<Store["usage"]>;
  remainingRequests: number;
  minimumRequests: number;
  remainingApiUsd: number;
  artifactCount: number;
  operationCount: number;
  configHash: string;
  modelChangeCount: number;
  operations: ReturnType<Store["operations"]>;
  sourceExclusions: {
    ids: string[];
    hashes: string[];
    urls: string[];
  };
  redactedImageIds: string[];
}

interface ModelChangeOptions {
  appGuard?: () => void;
  signal?: AbortSignal;
}

interface StateSnapshot {
  run: Run;
  usage: ReturnType<Store["usage"]>;
  requests: RequestReservation[];
  artifacts: Artifact[];
  operations: ReturnType<Store["operations"]>;
  cancelled: boolean;
}

const settledOperationStatuses = new Set(["completed", "failed"]);
function destination(config: Config, alias: string): ModelCandidate {
  const model = config.models[alias];
  if (!model) throw new AgentError("NO_MODEL", `Unknown model ${alias}`);
  const connection = config.connections[model.connection];
  if (!connection)
    throw new AgentError("NO_MODEL", `Unknown connection ${model.connection}`);
  return {
    alias,
    modelId: model.id,
    connection: model.connection,
    type: connection.type,
    ...(connection.endpoint ? { endpoint: connection.endpoint } : {}),
    billing: connection.billing,
    allowedData: [...connection.allowedData],
    localOnly: connection.type === "local",
  };
}

function taskNeedsTools(store: Store, run: Run, task: Task): boolean {
  return (
    task.role === "reviewer" ||
    task.write ||
    run.kind !== "chat" ||
    run.inputs.length > 0 ||
    (run.preparedInputs?.length ?? 0) > 0 ||
    (task.assignment?.sourceIds.length ?? 0) > 0 ||
    authorizedSources(store, run, task).length > 0 ||
    (task.contextArchiveIds?.length ?? 0) > 0 ||
    (run.compactions?.length ?? 0) > 0 ||
    (run.contextState?.compactions?.length ?? 0) > 0
  );
}

function affectedTasks(run: Run, taskId: string): Task[] {
  const affected = new Set([taskId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of run.tasks)
      if (
        !affected.has(task.id) &&
        task.dependsOn.some((dependency) => affected.has(dependency))
      ) {
        affected.add(task.id);
        changed = true;
      }
  }
  return run.tasks.filter((task) => affected.has(task.id));
}

function assertTaskGraph(tasks: Task[]): void {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  if (byId.size !== tasks.length)
    throw new AgentError("INVALID_PLAN", "Duplicate task IDs");
  for (const task of tasks)
    for (const dependency of task.dependsOn)
      if (!byId.has(dependency))
        throw new AgentError(
          "INVALID_PLAN",
          `Unknown dependency ${dependency}`,
        );
  const visiting = new Set<string>(),
    visited = new Set<string>();
  const visit = (taskId: string) => {
    if (visiting.has(taskId))
      throw new AgentError("INVALID_PLAN", "Cyclic task dependencies");
    if (visited.has(taskId)) return;
    visiting.add(taskId);
    for (const dependency of byId.get(taskId)!.dependsOn) visit(dependency);
    visiting.delete(taskId);
    visited.add(taskId);
  };
  for (const task of tasks) visit(task.id);
}

function assertEligible(store: Store, config: Config, run: Run): void {
  if (
    run.state !== "waiting_input" &&
    run.state !== "waiting_quota" &&
    run.state !== "waiting_approval"
  )
    throw new AgentError(
      "MODEL_CHANGE_STATE",
      "Only an idle waiting run can replace a task model",
    );
  if (!run.prepared || run.forkCheckpointId)
    throw new AgentError(
      "MODEL_CHANGE_STATE",
      "Only a prepared execution run can replace a task model",
    );
  if (terminalStates.includes(run.state))
    throw new AgentError("TERMINAL_RUN", "A terminal run cannot be replaced");
  if (!run.tasks.length)
    throw new AgentError("MODEL_CHANGE_STATE", "The run has no selected tasks");
  if (run.configHash !== configHash(config))
    throw new AgentError(
      "POLICY_CHANGED",
      "Configuration changed; review the model replacement again",
    );
  if (store.cancelRequested(run.id))
    throw new AgentError("CANCELLED", "Cancellation was requested");
  if (
    store
      .operations(run.id)
      .some((operation) => !settledOperationStatuses.has(operation.status))
  )
    throw new AgentError(
      "OPERATION",
      "Reconcile or finish pending operations before replacing a model",
    );
  if (run.elapsedMs >= config.limits.maxSeconds * 1000)
    throw new AgentError("BUDGET", "Run time budget exhausted");
  if ((run.modelChanges?.length ?? 0) >= config.limits.maxRequests)
    throw new AgentError(
      "MODEL_CHANGE_LIMIT",
      "Model replacement limit reached",
    );
  assertTaskGraph(run.tasks);
}

function requiredTaskIds(run: Run, affected: Task[]): Set<string> {
  const ids = new Set(
    run.tasks
      .filter((task) => task.state !== "succeeded")
      .map((task) => task.id),
  );
  for (const task of affected) ids.add(task.id);
  return ids;
}

function assertBudget(
  store: Store,
  config: Config,
  run: Run,
  modelOverride: { taskId: string; model: string },
  affected: Task[],
): {
  usage: ReturnType<Store["usage"]>;
  minimumRequests: number;
  remainingApiUsd: number;
} {
  const usage = store.usage(run.id);
  const required = requiredTaskIds(run, affected);
  if (
    usage.requests + required.size + (run.modelChanges?.length ?? 0) >
    config.limits.maxRequests
  )
    throw new AgentError(
      "BUDGET",
      "The remaining request budget cannot execute every affected task",
    );
  let futureApiUsd = 0;
  for (const taskId of required) {
    const task = run.tasks.find((candidate) => candidate.id === taskId)!;
    const alias =
      task.id === modelOverride.taskId ? modelOverride.model : task.model;
    const selected = alias && config.models[alias];
    if (!selected)
      throw new AgentError("NO_MODEL", `Task ${task.id} has no selected model`);
    const connection = config.connections[selected.connection];
    if (!connection)
      throw new AgentError(
        "NO_MODEL",
        `Unknown connection ${selected.connection}`,
      );
    if (connection.billing === "api") futureApiUsd += connection.maxRequestUsd;
  }
  const remainingApiUsd =
    config.limits.maxApiUsd - usage.knownCostUsd - usage.heldUsd;
  if (futureApiUsd > remainingApiUsd + 1e-9)
    throw new AgentError(
      "BUDGET",
      "The remaining API budget cannot execute every affected task",
    );
  return {
    usage,
    minimumRequests: required.size,
    remainingApiUsd: Math.max(0, remainingApiUsd),
  };
}

function snapshot(
  store: Store,
  run: Run,
  omitArtifactId?: string,
): StateSnapshot {
  return {
    run: structuredClone(run),
    usage: structuredClone(store.usage(run.id)),
    requests: structuredClone(store.requestLedger(run.id)),
    artifacts: structuredClone(
      store
        .artifacts(run.id)
        .filter((artifact) => artifact.id !== omitArtifactId),
    ) as StateSnapshot["artifacts"],
    operations: structuredClone(store.operations(run.id)),
    cancelled: store.cancelRequested(run.id),
  };
}

function snapshotDigest(value: StateSnapshot): string {
  return sha256(canonical(value));
}

function candidateAliases(
  store: Store,
  config: Config,
  run: Run,
  task: Task,
): string[] {
  const current = config.models[task.model!];
  if (!current) throw new AgentError("NO_MODEL", `Unknown model ${task.model}`);
  const aliases = modelCandidates(
    config,
    run,
    task.role,
    taskNeedsTools(store, run, task),
  );
  return aliases.filter((alias) => {
    if (alias === task.model) return false;
    const candidate = config.models[alias]!;
    if (
      candidate.connection === current.connection &&
      candidate.id === current.id
    )
      return false;
    const proposed = structuredClone(run.tasks);
    proposed.find((entry) => entry.id === task.id)!.model = alias;
    try {
      assertReviewerIndependence(config, proposed);
      return true;
    } catch {
      return false;
    }
  });
}

export function taskModelCandidates(
  store: Store,
  config: Config,
  run: Run,
  taskId: string,
): ModelCandidate[] {
  assertEligible(store, config, run);
  const task = run.tasks.find((candidate) => candidate.id === taskId);
  if (!task || !task.model)
    throw new AgentError("TASK", "Task is not selected in this run");
  return candidateAliases(store, config, run, task).map((alias) =>
    destination(config, alias),
  );
}

export function previewTaskModelChange(
  store: Store,
  config: Config,
  run: Run,
  taskId: string,
  model: string,
): ModelChangePreview {
  assertEligible(store, config, run);
  const task = run.tasks.find((candidate) => candidate.id === taskId);
  if (!task || !task.model)
    throw new AgentError("TASK", "Task is not selected in this run");
  if (!candidateAliases(store, config, run, task).includes(model))
    throw new AgentError(
      "NO_MODEL",
      "The selected model is not authorized for this task",
    );
  const affected = affectedTasks(run, taskId);
  const budget = assertBudget(store, config, run, { taskId, model }, affected);
  const state = snapshot(store, run);
  const binding = sha256(
    canonical({
      state,
      configHash: configHash(config),
      taskId,
      model,
      affectedTaskIds: affected.map((entry) => entry.id),
    }),
  );
  return {
    runId: run.id,
    generation: run.generation,
    taskId,
    fromModel: task.model,
    toModel: model,
    binding,
    affectedTaskIds: affected.map((entry) => entry.id),
    tasks: run.tasks.map((entry) => ({
      id: entry.id,
      role: entry.role,
      model: entry.model,
      state: entry.state,
      attempts: entry.attempts,
      affected: affected.some((candidate) => candidate.id === entry.id),
    })),
    destination: destination(config, model),
    dataClass: run.dataClass,
    localOnly: run.localOnly,
    access: run.access,
    preservedChecks: [...run.checks],
    elapsedMs: run.elapsedMs,
    remainingSeconds: Math.max(
      0,
      config.limits.maxSeconds - run.elapsedMs / 1000,
    ),
    usage: budget.usage,
    remainingRequests: config.limits.maxRequests - budget.usage.requests,
    minimumRequests: budget.minimumRequests,
    remainingApiUsd: budget.remainingApiUsd,
    artifactCount: state.artifacts.length,
    operationCount: state.operations.length,
    configHash: configHash(config),
    modelChangeCount: run.modelChanges?.length ?? 0,
    operations: state.operations,
    sourceExclusions: {
      ids: run.contextState?.excludedSourceIds ?? [],
      hashes: run.contextState?.excludedSourceHashes ?? [],
      urls: run.contextState?.excludedSourceUrls ?? [],
    },
    redactedImageIds: run.contextState?.redactedImageIds ?? [],
  };
}

export async function confirmTaskModelChange(
  store: Store,
  config: Config,
  preview: ModelChangePreview,
  options: ModelChangeOptions = {},
): Promise<ModelChange> {
  let run: Run | undefined;
  const beforeClaim = (candidate: Run) => {
    const current = previewTaskModelChange(
      store,
      config,
      candidate,
      preview.taskId,
      preview.toModel,
    );
    if (current.binding !== preview.binding)
      throw new AgentError(
        "STALE_MODEL_CHANGE",
        "Model replacement preview is stale",
      );
    options.appGuard?.();
  };
  run = store.claim(preview.runId, false, false, beforeClaim);
  const claimedSnapshot = snapshot(store, run);
  const oldTask = run.tasks.find((task) => task.id === preview.taskId);
  if (!oldTask || oldTask.model !== preview.fromModel)
    throw new AgentError("STALE_MODEL_CHANGE", "The selected task changed");
  const affected = affectedTasks(run, preview.taskId);
  const supersededReportIds = (run.modelChanges ?? [])
    .filter(
      (change) =>
        change.taskId === preview.taskId &&
        !change.supersededByReportId &&
        !change.resolutionReportId,
    )
    .map((change) => change.reportId);
  const report = {
    version: 1,
    type: "task-model-change",
    runId: run.id,
    taskId: preview.taskId,
    fromModel: preview.fromModel,
    toModel: preview.toModel,
    affectedTaskIds: affected.map((task) => task.id),
    at: Date.now(),
    supersededReportIds,
    priorTasks: affected.map((task) => structuredClone(task)),
    preserved: {
      configHash: run.configHash,
      constraints: run.constraints ?? [],
      checks: run.checks,
      mustKeep: run.mustKeep,
      usage: claimedSnapshot.usage,
      requests: claimedSnapshot.requests,
      operations: claimedSnapshot.operations,
    },
    semanticEquivalence: "not-established",
  };
  const reportText = JSON.stringify(report, null, 2);
  if (Buffer.byteLength(reportText) > config.limits.maxFileBytes)
    throw new AgentError(
      "REPORT_SIZE",
      "Model-change evidence cannot retain the previous task results within the file limit",
    );
  const heartbeat = setInterval(() => {
    try {
      store.heartbeat(run!);
    } catch {
      // The commit callback performs the authoritative lease check.
    }
  }, 1000);
  heartbeat.unref();
  try {
    await store.artifact(
      run,
      `model-changes/${preview.taskId}-${Date.now()}.json`,
      "report",
      reportText,
      {
        type: "task-model-change",
        taskId: preview.taskId,
        fromModel: preview.fromModel,
        toModel: preview.toModel,
        affectedTaskIds: affected.map((task) => task.id),
        author: "host",
        trusted: true,
      },
      (artifact) => {
        if (options.signal?.aborted || store.cancelRequested(run!.id))
          throw new AgentError("CANCELLED", "Model replacement was cancelled");
        options.appGuard?.();
        assertEligible(store, config, run!);
        if (
          run!.tasks.find((task) => task.id === preview.taskId)?.model !==
          preview.fromModel
        )
          throw new AgentError(
            "STALE_MODEL_CHANGE",
            "The selected task changed",
          );
        const currentSnapshot = snapshot(store, run!, artifact.id);
        if (snapshotDigest(currentSnapshot) !== snapshotDigest(claimedSnapshot))
          throw new AgentError(
            "STALE_MODEL_CHANGE",
            "Run state changed during model replacement",
          );
        const budget = assertBudget(
          store,
          config,
          run!,
          { taskId: preview.taskId, model: preview.toModel },
          affected,
        );
        const task = run!.tasks.find(
          (candidate) => candidate.id === preview.taskId,
        )!;
        const affectedIds = new Set(affected.map((candidate) => candidate.id));
        for (const candidate of run!.tasks)
          if (affectedIds.has(candidate.id)) {
            if (candidate.attempts > 0)
              candidate.modelChangeCount =
                (candidate.modelChangeCount ?? 0) + 1;
            candidate.state = "pending";
            candidate.result = undefined;
            candidate.sessionFile = undefined;
            if (run!.previousSessions)
              delete run!.previousSessions[candidate.id];
          }
        const changes = [...(run!.modelChanges ?? [])];
        for (const change of changes)
          if (supersededReportIds.includes(change.reportId))
            change.supersededByReportId = artifact.id;
        const change: ModelChange = {
          reportId: artifact.id,
          taskId: task.id,
          fromModel: preview.fromModel,
          toModel: preview.toModel,
          affectedTaskIds: [...affectedIds],
          at: Date.now(),
        };
        changes.push(change);
        task.model = preview.toModel;
        run!.modelChanges = changes;
        run!.state = "waiting_input";
        run!.reason = "Task model changed; explicit resume is required";
        void budget;
        store.saveInTransaction(run!, "task_model_changed", {
          reportId: artifact.id,
          taskId: task.id,
          fromModel: preview.fromModel,
          toModel: preview.toModel,
          affectedTaskIds: [...affectedIds],
        });
      },
    );
    return run.modelChanges!.at(-1)!;
  } finally {
    clearInterval(heartbeat);
    store.release(run);
  }
}

export function recordModelChangeResolution(
  store: Store,
  run: Run,
  validationArtifactIds: string[],
  checksNotRun: boolean,
): Promise<void> {
  const unresolved = (run.modelChanges ?? []).filter(
    (change) => !change.supersededByReportId && !change.resolutionReportId,
  );
  if (!unresolved.length) return Promise.resolve();
  const artifacts = store.artifacts(run.id);
  const latestReports = new Map<string, string>();
  for (const task of run.tasks) {
    const reportId = task.attemptReportIds?.at(-1);
    const report =
      reportId && artifacts.find((artifact) => artifact.id === reportId);
    if (
      report &&
      report.kind === "report" &&
      report.metadata.type === "task-attempt" &&
      report.metadata.taskId === task.id &&
      report.metadata.model === task.model
    )
      latestReports.set(task.id, report.id);
  }
  return (async () => {
    for (const change of unresolved) {
      if (
        change.affectedTaskIds.some((taskId) => !latestReports.has(taskId)) ||
        change.affectedTaskIds.some(
          (taskId) =>
            run.tasks.find((task) => task.id === taskId)?.state !== "succeeded",
        )
      )
        continue;
      const currentReportIds = change.affectedTaskIds.map((taskId) =>
        latestReports.get(taskId)!,
      );
      const reportText = JSON.stringify(
        {
          version: 1,
          type: "task-model-change-resolution",
          initialReportId: change.reportId,
          currentResultReportIds: currentReportIds,
          validationArtifactIds,
          checks: checksNotRun
            ? "not-run-read-only"
            : "fresh-passing-validation",
          semanticEquivalence: "not-established",
          at: Date.now(),
        },
        null,
        2,
      );
      await store.artifact(
        run,
        `model-changes/resolution-${change.reportId}.json`,
        "report",
        reportText,
        {
          type: "task-model-change-resolution",
          initialReportId: change.reportId,
          currentResultReportIds: currentReportIds,
          validationArtifactIds,
          semanticEquivalence: "not-established",
        },
        (artifact) => {
          const entry = run.modelChanges?.find(
            (candidate) => candidate.reportId === change.reportId,
          );
          if (!entry || entry.supersededByReportId || entry.resolutionReportId)
            throw new AgentError(
              "STALE_MODEL_CHANGE",
              "Model-change resolution is stale",
            );
          entry.resolutionReportId = artifact.id;
          store.saveInTransaction(run, "task_model_change_resolved", {
            reportId: change.reportId,
            resolutionReportId: artifact.id,
          });
        },
      );
    }
  })();
}
