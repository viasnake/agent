import { type Config } from "./config.js";
import { McpTools } from "./mcp.js";
import { validatePlan } from "./plan.js";
import { Router } from "./routing.js";
import { Store } from "./storage.js";
import { TaskExecutor } from "./task-executor.js";
import { AgentError, type Run, type Task } from "./types.js";
import { jsonObject } from "./util.js";
export class Planner {
  constructor(
    readonly config: Config,
    readonly store: Store,
    readonly router: Router,
    readonly executor: TaskExecutor,
  ) {}
  async plan(run: Run, signal: AbortSignal, mcp: McpTools): Promise<void> {
    this.store.transition(run, "planning");
    let plannedTasks: Task[] = [];
    if (
      run.kind === "chat" ||
      run.mode === "single" ||
      run.mode === "reviewed"
    ) {
      const writer = await this.router.select(
        run,
        "worker",
        run.kind !== "chat" || run.inputs.length > 0,
        signal,
        run.model,
      );
      plannedTasks = [
        {
          id: "work",
          role: "worker",
          objective: run.objective,
          model: writer,
          dependsOn: [],
          write: run.kind !== "chat",
          state: "pending",
          attempts: 0,
        },
      ];
      if (run.mode === "reviewed" && run.kind !== "chat") {
        const reviewer = await this.router.select(
          run,
          "reviewer",
          true,
          signal,
          run.reviewer,
          writer,
        );
        plannedTasks.push({
          id: "review",
          role: "reviewer",
          objective:
            "Independently review the complete result against the user objective and required checks. Inspect the actual files. Report failed with concrete findings if requirements are unmet; completed only when no blocking defect remains.",
          model: reviewer,
          dependsOn: ["work"],
          write: false,
          state: "pending",
          attempts: 0,
        });
      }
    } else {
      const lead = await this.router.select(
        run,
        "lead",
        true,
        signal,
        run.model,
      );
      const task: Task = {
        id: "plan",
        role: "lead",
        objective: `Propose a bounded task DAG for this user objective:\n${run.objective}\nReturn only {"tasks":[{"id":"work","objective":"concrete instructions","role":"worker","dependsOn":[],"write":true,"model":"configured alias"}]}. Include independent review when useful. At most ${this.config.limits.maxTasks} tasks. Order all writers by dependencies. Workers cannot delegate. Available model aliases and capabilities: ${JSON.stringify(this.config.models)}. Do not change the user's fixed checks or policy.`,
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
        try {
          const text = await this.executor.invoke(
            run,
            task,
            signal,
            mcp,
            reason,
          );
          plannedTasks = validatePlan(
            jsonObject(text),
            this.config.limits.maxTasks,
          );
          break;
        } catch (error) {
          if (
            !(error instanceof AgentError) ||
            !["INVALID_PLAN", "WRITER_CONFLICT", "INVALID_RESULT"].includes(
              error.code,
            )
          )
            throw error;
          reason = "Correct this rejected plan: " + error.message;
        }
      }
      if (!plannedTasks.length)
        throw new AgentError("INVALID_PLAN", "Planning retry limit reached");
      for (const planned of plannedTasks.filter((t) => t.role === "worker"))
        planned.model = await this.router.select(
          run,
          planned.role,
          true,
          signal,
          planned.model,
        );
      for (const planned of plannedTasks.filter((t) => t.role === "reviewer")) {
        const ancestors = new Set<string>();
        const visit = (task: Task): void => {
          for (const id of task.dependsOn) {
            if (ancestors.has(id)) continue;
            ancestors.add(id);
            visit(plannedTasks.find((t) => t.id === id)!);
          }
        };
        visit(planned);
        const producerModels = plannedTasks
          .filter((t) => ancestors.has(t.id) && t.write)
          .map((t) => t.model!);
        planned.model = await this.router.select(
          run,
          "reviewer",
          true,
          signal,
          planned.model,
          producerModels,
        );
      }
      if (!plannedTasks.some((t) => t.write))
        throw new AgentError(
          "INVALID_PLAN",
          "Plan has no artifact-producing writer",
        );
    }
    // Publish a complete, authorized plan atomically; a missing reviewer must never
    // leave a resumable worker-only plan in a reviewed run.
    for (const task of plannedTasks) {
      const previous = run.previousSessions?.[task.id];
      if (previous && previous.model === task.model)
        task.sessionFile = previous.file;
    }
    run.tasks = plannedTasks;
    if (
      this.store.usage(run.id).requests + plannedTasks.length >
      this.config.limits.maxRequests
    )
      throw new AgentError(
        "BUDGET",
        "Insufficient request budget for the proposed plan",
      );
    this.store.save(run, "plan_accepted", {
      tasks: run.tasks.map((t) => ({
        id: t.id,
        role: t.role,
        model: t.model,
        dependsOn: t.dependsOn,
        write: t.write,
      })),
    });
  }
}
