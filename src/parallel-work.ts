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
export const maxAssignments = 6;
const maxSourcePaths = maxAssignments * 3;
export const assignmentInput = z
  .object({
    path,
    instruction: z.string().trim().min(1).max(4000),
    references: z.array(path).max(2).optional(),
  })
  .strict();
export const planInput = z
  .object({
    repo: z.union([path, z.literal(".")]),
    base: objectId,
    goal: z.string().trim().min(1).max(2000),
    assignments: z.array(assignmentInput).min(2).max(maxAssignments),
    check: z.string().trim().min(1).max(2000),
  })
  .strict()
  .refine(({ assignments }) => {
    const paths = assignments.map((a) => a.path + "/");
    return paths.every((path, i) =>
      paths.every((other, j) => i === j || !other.startsWith(path)),
    );
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
  revision?: number;
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
    revision: work.revision ?? 0,
    repo: work.plan.repo,
    candidates: work.candidates.map((c) => ({
      id: c.id,
      tree: c.tree,
      status: c.checks.at(-1)?.status,
      attempts: c.attempts,
    })),
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
      paths: z.array(path).min(1).max(maxSourcePaths),
    })
    .strict(),
  z
    .object({
      kind: z.literal("candidate"),
      repo: planInput.shape.repo,
      base: objectId,
      edits: z.array(edit).min(2).max(maxAssignments),
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
    files: z.array(fileText.nullable()).min(1).max(maxSourcePaths),
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

export const candidateKey = z.string().regex(/^[a-f0-9]{64}$/);
export const workControlInput = z.discriminatedUnion("action", [
  z.object({ action: z.enum(["pause", "resume", "cancel"]) }).strict(),
  z
    .object({
      action: z.literal("repair"),
      revision: z.number().int().nonnegative(),
      path: assignmentInput.shape.path,
      guidance: z.string().trim().min(1).max(2000),
    })
    .strict(),
]);
