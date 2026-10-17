import { type Config } from "./config.js";
import {
  isCollaborative,
  requireAuthorizedSource,
  saveAttemptReport,
} from "./collaboration.js";
import {
  independentTaskReviewInstruction,
  planningInstruction,
} from "./collaboration-prompts.js";
import { McpTools } from "./mcp.js";
import { validatePlan } from "./plan.js";
import { Router } from "./routing.js";
import { Store } from "./storage.js";
import { TaskExecutor } from "./task-executor.js";
import { AgentError, type Run, type Task } from "./types.js";
import { errorMessage, id, jsonObject } from "./util.js";

export class Planner {
  constructor(
    readonly config: Config,
    readonly store: Store,
    readonly router: Router,
    readonly executor: TaskExecutor,
  ) {}

  async plan(run: Run, signal: AbortSignal, mcp: McpTools): Promise<void> {
    void mcp;
    this.store.transition(run, "planning");
    this.requireRequestBudget(
      run,
      run.mode === "reviewed" || run.mode === "assisted" ? 3 : 1,
    );
    const collaborative = isCollaborative(run);
    const toolsRequired =
      run.kind !== "chat" ||
      run.inputs.length > 0 ||
      (run.preparedInputs?.length ?? 0) > 0 ||
      !!run.contextState?.researchCheckpoint ||
      this.store
        .artifacts(run.id)
        .some((artifact) => artifact.kind === "source") ||
      !!run.compactions?.length ||
      !!run.contextState?.compactions?.length;
    let plannedTasks: Task[] = [];

    if (run.mode === "single") {
      const model = await this.router.select(
        run,
        "worker",
        toolsRequired,
        signal,
        run.model,
      );
      plannedTasks = [
        {
          id: "work",
          role: "worker",
          objective: run.objective,
          model,
          dependsOn: [],
          write: run.access === "change" && run.kind !== "chat",
          state: "pending",
          attempts: 0,
          resultFormat:
            run.access === "read-only" || run.kind === "chat"
              ? "text"
              : "structured",
        },
      ];
    } else if (run.mode === "reviewed") {
      if (this.config.limits.maxTasks < 3)
        throw new AgentError(
          "TASK_LIMIT",
          "Reviewed mode requires a producer, reviewer and synthesis task",
        );
      const worker = await this.router.select(
          run,
          "worker",
          toolsRequired,
          signal,
          run.model,
        ),
        reviewer = await this.router.select(
          run,
          "reviewer",
          true,
          signal,
          run.reviewer,
          worker,
        );
      plannedTasks = [
        {
          id: "work",
          role: "worker",
          objective: run.objective,
          model: worker,
          dependsOn: [],
          write: run.access !== "read-only" && run.kind !== "chat",
          state: "pending",
          attempts: 0,
          resultFormat: "structured",
          attemptReportIds: [],
          contextArchiveIds: [],
        },
        {
          id: "review",
          role: "reviewer",
          objective: independentTaskReviewInstruction,
          model: reviewer,
          dependsOn: ["work"],
          write: false,
          state: "pending",
          attempts: 0,
          resultFormat: "structured",
          attemptReportIds: [],
          contextArchiveIds: [],
        },
      ];
      plannedTasks = await this.addSynthesis(
        run,
        plannedTasks,
        toolsRequired,
        signal,
      );
    } else {
      if (this.config.limits.maxTasks < 2)
        throw new AgentError(
          "TASK_LIMIT",
          "Assisted mode requires a worker and synthesis task",
        );
      const maxPlannerTasks = this.config.limits.maxTasks - 1;
      const lead = await this.router.select(
          run,
          "lead",
          true,
          signal,
          run.model,
        ),
        task: Task = {
          id: "plan",
          role: "lead",
          objective: planningInstruction(
            run.objective,
            maxPlannerTasks,
            JSON.stringify(this.config.models),
            run.access === "read-only",
          ),
          model: lead,
          dependsOn: [],
          write: false,
          state: "pending",
          attempts: 0,
        };
      let reason = "";
      while (run.planAttempts < 3) {
        run.planAttempts++;
        this.store.save(run, "planning_attempt", { attempt: run.planAttempts });
        let raw: string | undefined;
        try {
          raw = await this.executor.invoke(run, task, signal, mcp, reason);
          plannedTasks = validatePlan(jsonObject(raw), maxPlannerTasks, {
            readOnlyPlan: run.access === "read-only",
          });
        } catch (error) {
          const allowed =
            error instanceof AgentError &&
            ["INVALID_PLAN", "WRITER_CONFLICT", "INVALID_RESULT"].includes(
              error.code,
            );
          await saveAttemptReport(
            this.store,
            run,
            undefined,
            "planning",
            lead,
            run.planAttempts,
            { rawFailure: raw, hostError: errorMessage(error) },
          );
          if (!allowed) throw error;
          reason = "Correct this rejected plan: " + error.message;
          continue;
        }
        await saveAttemptReport(
          this.store,
          run,
          undefined,
          "planning",
          lead,
          run.planAttempts,
          { result: raw },
        );
        break;
      }
      if (!plannedTasks.length)
        throw new AgentError("INVALID_PLAN", "Planning retry limit reached");

      for (const task of plannedTasks) {
        task.resultFormat = "structured";
        task.attemptReportIds = [];
        task.contextArchiveIds = [];
        if (task.role === "reviewer") continue;
        task.model = await this.router.select(
          run,
          "worker",
          toolsRequired,
          signal,
          task.model,
        );
      }
      for (const task of plannedTasks.filter(
        (candidate) => candidate.role === "reviewer",
      )) {
        const ancestors = this.ancestors(plannedTasks, task),
          producerModels = plannedTasks
            .filter(
              (candidate) =>
                ancestors.has(candidate.id) &&
                candidate.role !== "reviewer" &&
                candidate.model,
            )
            .map((candidate) => candidate.model!);
        task.model = await this.router.select(
          run,
          "reviewer",
          true,
          signal,
          task.model,
          producerModels,
        );
      }
      if (
        run.access !== "read-only" &&
        !plannedTasks.some((candidate) => candidate.write)
      )
        throw new AgentError(
          "INVALID_PLAN",
          "Plan has no artifact-producing writer",
        );
      plannedTasks = await this.addSynthesis(
        run,
        plannedTasks,
        toolsRequired,
        signal,
      );
    }
    this.assertReviewerIndependence(plannedTasks);

    if (collaborative)
      for (const task of plannedTasks) {
        task.attemptReportIds ??= [];
        task.contextArchiveIds ??= [];
      }
    if (run.mode === "single")
      for (const task of plannedTasks) {
        const previous = run.previousSessions?.[task.id];
        if (previous && previous.model === task.model)
          task.sessionFile = previous.file;
      }
    this.requireRequestBudget(run, plannedTasks.length);
    run.tasks = plannedTasks;
    this.store.save(run, "plan_accepted", {
      tasks: run.tasks.map((task) => ({
        id: task.id,
        role: task.role,
        purpose: task.purpose,
        model: task.model,
        dependsOn: task.dependsOn,
        write: task.write,
      })),
    });
  }

  async admitDelegations(
    run: Run,
    requests: Task[],
    signal: AbortSignal,
  ): Promise<void> {
    const stagedTasks = structuredClone(run.tasks),
      admissions: Array<{ parentId: string; childIds: string[] }> = [];
    const requestedChildren = requests
      .filter((task) => task.result?.outcome === "needs_replan")
      .reduce(
        (count, task) => count + (task.result?.delegations?.length ?? 0),
        0,
      );
    this.assertDelegationBudget(run, requestedChildren);
    for (const parent of requests) {
      if (parent.result?.outcome !== "needs_replan") continue;
      const delegations = parent.result.delegations;
      if (
        run.mode !== "assisted" ||
        parent.role !== "worker" ||
        parent.delegatedBy ||
        parent.purpose ||
        !delegations?.length
      )
        throw new AgentError(
          "INVALID_RESULT",
          "This task is not authorized to request delegation",
        );
      if (run.elapsedMs >= this.config.limits.maxSeconds * 1000)
        throw new AgentError("BUDGET", "Run time budget exhausted");
      const priorDependencies = [...parent.dependsOn],
        pendingChildren: Task[] = [];
      for (const request of delegations) {
        if (request.sourceIds.length > 50)
          throw new AgentError(
            "SOURCE_LIMIT",
            "A delegated task cannot be assigned more than 50 sources",
          );
        for (const sourceId of request.sourceIds)
          requireAuthorizedSource(this.store, run, parent, sourceId);
        const reviewerModels = run.tasks
            .filter(
              (task) =>
                task.role === "reviewer" &&
                this.ancestors(run.tasks, task).has(parent.id),
            )
            .map((task) => this.config.models[task.model!]?.id)
            .filter((modelId): modelId is string => !!modelId),
          excludedAliases = Object.entries(this.config.models)
            .filter(([, model]) => reviewerModels.includes(model.id))
            .map(([alias]) => alias);
        const childModel = await this.router.select(
          run,
          "worker",
          this.taskNeedsTools(run, request.sourceIds.length > 0),
          signal,
          request.model,
          excludedAliases,
        );
        const childId = this.uniqueTaskId(stagedTasks, pendingChildren);
        pendingChildren.push({
          id: childId,
          role: "worker",
          objective: request.objective,
          model: childModel,
          dependsOn: [...priorDependencies],
          write: false,
          state: "pending",
          attempts: 0,
          resultFormat: "structured",
          delegatedBy: parent.id,
          assignment: structuredClone(request),
          attemptReportIds: [],
          contextArchiveIds: [],
        });
      }
      signal.throwIfAborted();
      const nextParent = stagedTasks.find((task) => task.id === parent.id)!;
      stagedTasks.push(...pendingChildren);
      nextParent.dependsOn = [
        ...new Set([
          ...priorDependencies,
          ...pendingChildren.map((task) => task.id),
        ]),
      ];
      nextParent.delegationRounds = (nextParent.delegationRounds ?? 0) + 1;
      nextParent.state = "pending";
      nextParent.result = undefined;
      nextParent.sessionFile = undefined;
      admissions.push({
        parentId: parent.id,
        childIds: pendingChildren.map((task) => task.id),
      });
    }
    signal.throwIfAborted();
    if (!admissions.length) return;
    if (stagedTasks.length > this.config.limits.maxTasks)
      throw new AgentError("TASK_LIMIT", "Delegation exceeds maxTasks");
    this.assertDelegationBudget(run, 0, stagedTasks);
    this.assertReviewerIndependence(stagedTasks);
    this.store.assertLease(run.id, run.generation);
    this.store.save(run, "delegations_admitted", { admissions }, () => {
      run.tasks = stagedTasks;
    });
  }

  private assertDelegationBudget(
    run: Run,
    childCount: number,
    tasks = run.tasks,
  ): void {
    if (tasks.length + childCount > this.config.limits.maxTasks)
      throw new AgentError("TASK_LIMIT", "Delegation exceeds maxTasks");
    const unfinished = tasks.filter(
      (task) => task.state !== "succeeded",
    ).length;
    if (
      this.store.usage(run.id).requests + unfinished + childCount >
      this.config.limits.maxRequests
    )
      throw new AgentError(
        "BUDGET",
        "Insufficient request budget for the delegated tasks",
      );
  }

  private async addSynthesis(
    run: Run,
    tasks: Task[],
    toolsRequired: boolean,
    signal: AbortSignal,
  ): Promise<Task[]> {
    const producer = tasks.find((task) => task.role !== "reviewer");
    if (!producer?.model)
      throw new AgentError("INVALID_PLAN", "A synthesis producer is required");
    const model = await this.router.select(
        run,
        "worker",
        toolsRequired,
        signal,
        producer.model,
      ),
      dependedOn = new Set(tasks.flatMap((task) => task.dependsOn)),
      terminalTasks = tasks.filter((task) => !dependedOn.has(task.id)),
      id = this.uniqueTaskId(tasks, [], "synthesis");
    return [
      ...tasks,
      {
        id,
        role: "worker",
        purpose: "synthesis",
        objective: run.objective,
        model,
        dependsOn: terminalTasks.map((task) => task.id),
        write: false,
        state: "pending",
        attempts: 0,
        resultFormat: "structured",
        attemptReportIds: [],
        contextArchiveIds: [],
      },
    ];
  }

  private ancestors(tasks: Task[], task: Task): Set<string> {
    const ids = new Set<string>();
    const visit = (current: Task) => {
      for (const dependencyId of current.dependsOn) {
        if (ids.has(dependencyId)) continue;
        ids.add(dependencyId);
        const dependency = tasks.find(
          (candidate) => candidate.id === dependencyId,
        );
        if (dependency) visit(dependency);
      }
    };
    visit(task);
    return ids;
  }

  private assertReviewerIndependence(tasks: Task[]): void {
    for (const reviewer of tasks.filter((task) => task.role === "reviewer")) {
      const reviewerModel = this.config.models[reviewer.model!]?.id;
      if (!reviewerModel) continue;
      for (const taskId of this.ancestors(tasks, reviewer)) {
        const producer = tasks.find((task) => task.id === taskId);
        if (
          producer?.role !== "reviewer" &&
          producer?.model &&
          this.config.models[producer.model]?.id === reviewerModel
        )
          throw new AgentError(
            "INVALID_PLAN",
            "A reviewer must use a model distinct from every producer",
          );
      }
    }
  }

  private uniqueTaskId(
    tasks: Task[],
    additional: Task[],
    stem = "delegated",
  ): string {
    const existing = new Set([...tasks, ...additional].map((task) => task.id));
    for (;;) {
      const candidate = `${stem}-${id().replaceAll("-", "").slice(0, 16)}`;
      if (!existing.has(candidate)) return candidate;
    }
  }

  private requireRequestBudget(run: Run, additional: number): void {
    if (
      this.store.usage(run.id).requests + additional >
      this.config.limits.maxRequests
    )
      throw new AgentError(
        "BUDGET",
        "Insufficient request budget for the proposed plan",
      );
  }

  private taskNeedsTools(run: Run, hasAssignedSources: boolean): boolean {
    return (
      hasAssignedSources ||
      !!run.workspace ||
      run.inputs.length > 0 ||
      !!run.preparedInputs?.length ||
      !!run.compactions?.length ||
      !!run.contextState?.compactions?.length ||
      (run.kind === "research" &&
        !run.localOnly &&
        run.dataClass !== "restricted") ||
      !!run.contextState?.researchCheckpoint ||
      run.kind !== "chat"
    );
  }
}
