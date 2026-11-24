import type { Usage } from "@earendil-works/pi-ai";
import { z } from "zod";
import { defineDoc } from "@earendil-works/pi-durable";

const path = z
  .string()
  .min(1)
  .max(220)
  .refine((value) =>
    value
      .split("/")
      .every(
        (part) =>
          /^[^\x00-\x1f\x7f\\/]+$/u.test(part) &&
          ![".", "..", ".git", ".ssh", ".aws", ".gnupg"].includes(
            part.toLowerCase(),
          ),
      ),
  );
export const objectId = z.string().regex(/^[0-9a-f]{40}$/);
export const assignmentInput = z
  .object({
    path,
    instruction: z.string().trim().min(1).max(4000),
  })
  .strict();
export const planInput = z
  .object({
    repo: z.union([path, z.literal(".")]),
    base: objectId,
    goal: z.string().trim().min(1).max(2000),
    assignments: z.array(assignmentInput).length(2),
    check: z.string().trim().min(1).max(2000),
  })
  .strict()
  .refine(({ assignments }) => {
    if (assignments.length !== 2) return false;
    const first = assignments[0]!.path + "/";
    const second = assignments[1]!.path + "/";
    return !first.startsWith(second) && !second.startsWith(first);
  }, "Assignments must own distinct files");
export const fileText = z
  .string()
  .max(32000)
  .refine(
    (v) =>
      !v.includes("\0") &&
      Buffer.byteLength(v) <= 64000 &&
      Buffer.from(v).toString("utf8") === v,
  );
export const replacement = z.object({ content: fileText.nullable() }).strict();
export const edit = replacement.extend({ path });
export type Plan = z.infer<typeof planInput>;
export type WorkStatus =
  | "running"
  | "pausing"
  | "paused"
  | "cancelling"
  | "cancelled"
  | "failed"
  | "passed";
export type Attempt = {
  number: number;
  state: "queued" | "running" | "ready" | "failed" | "interrupted";
  detail?: string;
  content?: string | null;
  guidance?: string;
  usage?: {
    time: number;
    model: string;
    tokens: Pick<Usage, keyof Usage>;
    error: boolean;
  };
};
export type Candidate = {
  id: string;
  tree: string;
  patch: string;
  attempts: number[];
  checks: {
    status: "running" | "passed" | "failed" | "interrupted";
    output: string;
  }[];
};
export type Work = {
  id: string;
  plan: Plan;
  connection?: string;
  model: string;
  status: WorkStatus;
  detail: string;
  assignments: { attempts: Attempt[] }[];
  candidates: Candidate[];
  selected?: string;
  calls: number;
  maxCalls: number;
  remainingMs: number;
  startedAt?: number;
  checkSeconds: number;
};
export const WorkDoc = defineDoc<{ items: Work[] }>({
  kind: "agent.parallel-work",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ items: [] }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 32,
});
export function workView(work: Work) {
  const candidate = work.candidates.find((c) => c.id === work.selected);
  return {
    id: work.id,
    goal: work.plan.goal,
    base: work.plan.base,
    status: work.status,
    detail: work.detail,
    check: work.plan.check,
    calls: work.calls,
    maxCalls: work.maxCalls,
    assignments: work.assignments.map((a, i) => ({
      path: work.plan.assignments[i]!.path,
      attempts: a.attempts.map(({ number, state, detail }) => ({
        number,
        state,
        detail,
      })),
    })),
    candidate: candidate && {
      id: candidate.id,
      tree: candidate.tree,
      checks: candidate.checks.map((c) => ({ ...c })),
    },
  };
}
export type WorkView = ReturnType<typeof workView>;
export const gitWorkInput = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("sources"),
      repo: planInput.shape.repo,
      base: objectId,
      paths: z.array(path).length(2),
    })
    .strict(),
  z
    .object({
      kind: z.literal("candidate"),
      repo: planInput.shape.repo,
      base: objectId,
      edits: z.array(edit).length(2),
    })
    .strict(),
  z
    .object({
      kind: z.literal("check"),
      repo: planInput.shape.repo,
      base: objectId,
      tree: objectId,
      patch: z.string().min(1).max(400000),
      command: planInput.shape.check,
      seconds: z.number().int().min(1).max(300),
    })
    .strict(),
]);
export const gitWorkResult = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("sources"),
    files: z.array(fileText.nullable()).length(2),
  }),
  z.object({
    kind: z.literal("candidate"),
    tree: objectId,
    patch: z.string().min(1).max(400000),
  }),
  z.object({
    kind: z.literal("check"),
    passed: z.boolean(),
    output: z.string().max(4000),
  }),
]);

export function assignmentUsage(items: readonly Work[]) {
  return items.flatMap((w) =>
    w.assignments.flatMap((a) =>
      a.attempts.flatMap((t) => (t.usage ? [t.usage] : [])),
    ),
  );
}
