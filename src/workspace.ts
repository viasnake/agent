import type { ConversationId, Harness } from "@earendil-works/pi-durable";
import {
  readPosts,
  timelinePageSize,
  type ProjectPost,
} from "./project-timeline.js";
import type { ProjectRow } from "./projects.js";

export type WorkspaceNotice = Pick<
  ProjectPost,
  "id" | "at" | "kind" | "actor" | "name" | "model" | "text"
>;
export type FiledPost = WorkspaceNotice & { file?: string; written: boolean };
export type WorkspaceDocument = FiledPost & {
  session: string;
  title: string;
  archived: boolean;
};
export type WorkspaceThread = ProjectRow & {
  notice?: WorkspaceNotice;
};
export type WorkspaceOverview = {
  threads: WorkspaceThread[];
  documents: WorkspaceDocument[];
};

type Index = {
  through: number;
  notice?: WorkspaceNotice;
  documents: FiledPost[];
};
// Timeline pages are append-only. Keep only list metadata. Full deliverables and
// evidence are read from the original post on demand. A reopened Harness owns a fresh cache.
const indexes = new WeakMap<Harness, Map<ConversationId, Index>>();
const incoming = new Set<ProjectPost["kind"]>([
  "reply",
  "question",
  "report",
  "progress",
  "delivery",
  "revision",
  "artifact",
  "interrupted",
  "failed",
  "review_error",
]);

export async function indexThread(
  harness: Harness,
  owner: ConversationId,
  count: number,
): Promise<Index> {
  let threads = indexes.get(harness);
  if (!threads) {
    threads = new Map();
    indexes.set(harness, threads);
  }
  const previous = threads.get(owner);
  if (previous?.through === count) return previous;
  const index: Index =
    previous && previous.through < count
      ? { ...previous, documents: [...previous.documents] }
      : { through: 0, documents: [] };
  while (index.through < count) {
    const end = Math.min(count, index.through + timelinePageSize);
    const page = await readPosts(
      harness,
      owner,
      count,
      end + 1,
      end - index.through,
    );
    for (const post of page.posts) {
      if (!incoming.has(post.kind)) continue;
      const { id, at, kind, actor, name, model } = post;
      const notice = {
        id,
        at,
        kind,
        actor,
        name,
        model,
        text: post.text.slice(0, 400),
      };
      index.notice = notice;
      if (kind === "delivery" || (kind === "artifact" && post.file)) {
        index.documents.push({
          ...notice,
          file: post.file,
          written: !!post.deliverable,
        });
      }
    }
    index.through = end;
  }
  if ((threads.get(owner)?.through ?? 0) <= count) threads.set(owner, index);
  return index;
}
