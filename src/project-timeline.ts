import {
  defineDocFamily,
  type Tx,
  type ConversationId,
  type Harness,
} from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { Project } from "./projects.js";

export type PostKind =
  | "directive"
  | "assignment"
  | "start"
  | "progress"
  | "report"
  | "passed"
  | "failed"
  | "artifact"
  | "review"
  | "revision"
  | "question"
  | "decision"
  | "delivery"
  | "interrupted"
  | "resume";
export type PostContent = {
  kind: PostKind;
  actor: "user" | "lead" | "member" | "reviewer" | "system";
  text: string;
  name?: string;
  memberId?: string;
  detail?: string;
  file?: string;
  questionId?: number;
};
export type ProjectPost = PostContent & {
  id: number;
  at: number;
  revision: number;
};
export type TimelinePage = { posts: ProjectPost[]; before: number | null };
export type PortfolioPost = {
  session: string;
  title: string;
  post: ProjectPost;
};
const pageSize = 24;
const TimelineDoc = defineDocFamily<{ posts: ProjectPost[] }, null>({
  kind: "agent.project-timeline",
  version: 1,
  family: true,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ posts: [] }),
  checkpointWhen: (_v, _ops, info) => info.deltasSinceBase >= pageSize,
});
const pageKey = (id: number) => String(Math.floor((id - 1) / pageSize));

// Append on the same transaction as the transition. Each project's sequence spans directive revisions.
export async function appendPost(
  tx: Tx,
  piId: ConversationId,
  p: Project,
  content: PostContent,
) {
  const id = (p.lastPost?.id ?? 0) + 1,
    at = Math.max(Date.now(), p.lastPost?.at ?? 0);
  const page = await tx.doc(TimelineDoc, piId, pageKey(id), null);
  page.posts.push({ ...content, id, at, revision: p.revision });
  p.lastPost = { id, at };
}
export async function readPosts(
  harness: Harness,
  piId: ConversationId,
  count: number,
  before = count + 1,
  limit = pageSize,
): Promise<TimelinePage> {
  const end = Math.min(count, before - 1);
  if (end < 1) return { posts: [], before: null };
  const start = Math.max(1, end - limit + 1);
  const keys = [...new Set([pageKey(start), pageKey(end)])];
  const pages = await Promise.all(
    keys.map((key) => harness.snapshot(TimelineDoc, piId, key, ctx)),
  );
  if (pages.some((p) => !p)) throw new Error("Missing project timeline page");
  return {
    posts: pages.flatMap((p) =>
      p!.posts.filter((row) => row.id >= start && row.id <= end),
    ),
    before: start > 1 ? start : null,
  };
}
