import type { SkillVersions } from "./skills.js";
import { defineDoc } from "@earendil-works/pi-durable";
import type { ConversationId } from "@earendil-works/pi-durable";

export type Conversation = {
  id: string;
  piId: ConversationId;
  title: string;
  status: "idle" | "running" | "stopping" | "interrupted";
  detail: string;
  updatedAt: number;
  deletedAt?: number;
  purgedAt?: number;
  parentId?: string;
  forkEntry?: number;
  branchSource?: { entryId: number; mode: "fork" | "edit" | "regenerate" };
  pinned?: boolean;
  archived?: boolean;
  workspaceCreated?: boolean;
  // Existing bindings are retained only to recover deletion of their worktrees.
  project?: { repositories: { key: string }[] };
  modelConfigId?: string;
  model?: string;
  skills?: SkillVersions;
  skillNotice?: string;
  requests: number;
  deadlineAt: number | null;
};
export type State = {
  schemaVersion: 1;
  conversations: Conversation[];
  receipts: Record<string, { hash: string; id: string }>;
  recentModels?: ModelSelection[];
};
export type ModelSelection = { modelId: string; model: string };

export function promoteRecentModel(state: State, selection: ModelSelection) {
  // Copy older selections so no Pi transaction drafts escape the commit.
  const previous = (state.recentModels ?? [])
    .filter(
      (item) =>
        item.modelId !== selection.modelId || item.model !== selection.model,
    )
    .slice(0, 2)
    .map(({ modelId, model }) => ({ modelId, model }));
  const recent = [selection, ...previous];
  state.recentModels = recent;
  return recent;
}
// A new database and document kind deliberately leave the former job store untouched.
export const ConversationsDoc = defineDoc<State>({
  kind: "agent.conversations",
  version: 1,
  scope: "session",
  initial: () => ({ schemaVersion: 1, conversations: [], receipts: {} }),
  checkpointWhen: () => true,
});
export const DEFAULT_LIMITS = {
  modelRequests: 60,
  runSeconds: 3600,
  commandSeconds: 300,
  commandBytes: 10485760,
  fileBytes: 20971520,
};
