import { z } from "zod";
import { AgentError, type Task, type TaskResult } from "./types.js";
import { jsonObject } from "./util.js";

const taskSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,40}$/),
  objective: z.string().min(1).max(12000),
  role: z.enum(["worker", "reviewer"]),
  dependsOn: z.array(z.string()).max(20),
  model: z.string().optional(),
  write: z.boolean(),
});
const resultSchema = z.strictObject({
  outcome: z.enum(["completed", "needs_replan", "blocked", "failed"]),
  summary: z.string().min(1).max(20000),
  artifacts: z.array(z.string().min(1)).max(100),
  unresolved: z.array(z.string().min(1)).max(50),
});
export function validatePlan(input: unknown, maxTasks: number): Task[] {
  const parsed = z
    .strictObject({ tasks: z.array(taskSchema).min(1).max(maxTasks) })
    .safeParse(input);
  if (!parsed.success)
    throw new AgentError(
      "INVALID_PLAN",
      parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
    );
  const tasks: Task[] = parsed.data.tasks.map((t) => ({
    ...t,
    state: "pending",
    attempts: 0,
  }));
  const byId = new Map(tasks.map((t) => [t.id, t]));
  if (byId.size !== tasks.length)
    throw new AgentError("INVALID_PLAN", "Duplicate task IDs");
  for (const task of tasks) {
    if (task.role === "reviewer" && task.write)
      throw new AgentError("INVALID_PLAN", "Reviewers cannot write");
    if (new Set(task.dependsOn).size !== task.dependsOn.length)
      throw new AgentError("INVALID_PLAN", "Duplicate dependencies");
    for (const dep of task.dependsOn)
      if (!byId.has(dep))
        throw new AgentError("INVALID_PLAN", `Unknown dependency ${dep}`);
  }
  const visited = new Set<string>(),
    active = new Set<string>();
  function visit(task: Task): void {
    if (active.has(task.id))
      throw new AgentError("INVALID_PLAN", "Cyclic task dependencies");
    if (visited.has(task.id)) return;
    active.add(task.id);
    for (const dependency of task.dependsOn) visit(byId.get(dependency)!);
    active.delete(task.id);
    visited.add(task.id);
  }
  tasks.forEach(visit);
  const precedes = (a: string, b: string): boolean =>
    byId.get(b)!.dependsOn.some((dep) => dep === a || precedes(a, dep));
  const writers = tasks.filter((t) => t.write);
  for (const task of tasks)
    if (
      task.role === "reviewer" &&
      !writers.some((writer) => precedes(writer.id, task.id))
    )
      throw new AgentError(
        "INVALID_PLAN",
        "A reviewer must depend on an artifact-producing worker",
      );
  for (let i = 0; i < writers.length; i++)
    for (let j = i + 1; j < writers.length; j++) {
      if (
        !precedes(writers[i]!.id, writers[j]!.id) &&
        !precedes(writers[j]!.id, writers[i]!.id)
      )
        throw new AgentError(
          "WRITER_CONFLICT",
          `Writers ${writers[i]!.id} and ${writers[j]!.id} must be ordered by dependencies`,
        );
    }
  return tasks;
}
export function parseResult(text: string): TaskResult {
  const result = resultSchema.safeParse(jsonObject(text));
  if (!result.success)
    throw new AgentError(
      "INVALID_RESULT",
      result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
    );
  if (result.data.outcome === "completed" && result.data.unresolved.length)
    throw new AgentError(
      "INVALID_RESULT",
      "A completed task cannot contain unresolved work",
    );
  return result.data;
}
export const resultInstruction =
  'Return ONLY a JSON object: {"outcome":"completed|needs_replan|blocked|failed","summary":"what you verified","artifacts":["relative/file.md"],"unresolved":[]}. completed is a report, not proof. Never claim an unexecuted check passed. If requirements cannot be met, report blocked or failed.';
