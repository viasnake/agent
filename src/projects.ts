import { defineDoc } from "@earendil-works/pi-durable";
import type { Usage } from "@earendil-works/pi-ai";
import { z } from "zod";
import { edit, planInput, objectId } from "./parallel-work.js";
import type { PendingQuestion } from "./choices.js";
import type { Conversation } from "./state.js";

const revision = z.number().int().positive();
export const teamInput = z
  .object({
    revision,
    context: z.string().max(18000).optional(),
    repository: z
      .object({
        repo: planInput.shape.repo,
        base: objectId,
        check: planInput.shape.check.optional(),
      })
      .strict()
      .optional(),
    assignments: z
      .array(
        z
          .object({
            role: z.string().trim().min(1).max(80),
            task: z.string().trim().min(1).max(1800),
          })
          .strict(),
      )
      .min(1)
      .max(4),
  })
  .strict();
export type TeamInput = z.infer<typeof teamInput>;
export const projectReportInput = z
  .object({
    revision,
    stage: z.enum(["working", "delivered"]),
    summary: z.string().trim().min(1).max(1200),
    nextStep: z.string().trim().min(1).max(500).optional(),
    deliverable: z.string().trim().min(1).max(12000).optional(),
    evidence: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();
export const adoptInput = z
  .object({ revision, member: z.uuid(), tree: objectId })
  .strict();
export const memberAction = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("progress"),
      summary: z.string().trim().min(1).max(1500),
    })
    .strict(),
  z
    .object({
      action: z.literal("list"),
      directory: edit.shape.path.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("read"),
      paths: z.array(edit.shape.path).min(1).max(4),
    })
    .strict(),
  z
    .object({ action: z.literal("check"), edits: z.array(edit).min(1).max(6) })
    .strict()
    .refine(({ edits }) =>
      edits.every((a, i) =>
        edits.every(
          (b, j) => i === j || !(b.path + "/").startsWith(a.path + "/"),
        ),
      ),
    ),
  z
    .object({
      action: z.literal("report"),
      summary: z.string().trim().min(1).max(3000),
    })
    .strict(),
]);
export type Member = {
  id: string;
  role: string;
  task: string;
  status: "queued" | "running" | "reported" | "failed" | "interrupted";
  activity: string;
  report?: string;
  check?: { tree: string; passed: boolean; output: string; command?: string };
  file?: string;
};
export type Project = {
  revision: number;
  lastPost?: { id: number; at: number };
  brief: string;
  instruction: string;
  summary: string;
  nextStep?: string;
  deliveryPost?: number;
  evidence?: string;
  delivered: boolean;
  updatedAt: number;
  members: Member[];
  question?: PendingQuestion;
  assessment?: {
    verdict: "checking" | "revise" | "accept" | "unavailable";
    reason: string;
    sources?: { label: string; quote: string }[];
  };
};
export const ProjectDoc = defineDoc<Project>({
  kind: "agent.project-thread",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({
    revision: 0,
    brief: "",
    instruction: "",
    summary: "",
    delivered: false,
    updatedAt: 0,
    members: [],
  }),
  checkpointWhen: (_v, _ops, info) => info.deltasSinceBase >= 32,
});
export type MemberUsage = {
  time: number;
  model: string;
  tokens: Pick<Usage, keyof Usage>;
  error: boolean;
};
export type DeliveryDecision = {
  verdict: "accept" | "revise";
  reason: string;
  sources?: { label: string; quote: string }[];
};
export const ProjectEvidenceDoc = defineDoc<{
  reviews?: (DeliveryDecision & { key: string })[];
  patches: Record<
    string,
    {
      revision: number;
      tree: string;
      patch: string;
      base: string;
      repo: string;
    }
  >;
  usage: MemberUsage[];
}>({
  kind: "agent.project-evidence",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ patches: {}, usage: [] }),
  checkpointWhen: (_v, _ops, info) => info.deltasSinceBase >= 32,
});
export function projectRow(c: Conversation, p: Readonly<Project>) {
  const status =
    c.status === "interrupted"
      ? "interrupted"
      : p.question && c.status === "idle"
        ? "decision"
        : c.status === "running" || c.status === "stopping"
          ? "working"
          : p.delivered
            ? "delivered"
            : p.revision
              ? "waiting"
              : "draft";
  return {
    id: c.id,
    title: c.title,
    detail: c.detail,
    archived: !!c.archived,
    status,
    revision: p.revision,
    postCount: p.lastPost?.id ?? 0,
    lastPostedAt: p.lastPost?.at,
    instruction: p.instruction.slice(0, 400),
    summary: p.summary,
    nextStep: p.nextStep,
    deliveryPost: p.delivered ? p.deliveryPost : undefined,
    evidence: p.evidence,
    updatedAt: Math.max(c.updatedAt, p.updatedAt),
    question: p.question,
    assessment:
      c.status === "interrupted" && p.assessment?.verdict === "checking"
        ? { verdict: "unavailable" as const, reason: "検証が中断しました" }
        : p.assessment,
    members: p.members.map((m) => ({ ...m })),
  } as const;
}
export type ProjectRow = ReturnType<typeof projectRow>;
