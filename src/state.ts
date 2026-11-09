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
  parentId?: string;
  forkEntry?: number;
  pinned?: boolean;
  archived?: boolean;
  workspaceCreated?: boolean;
  modelConfigId?: string;
  model?: string;
  requests: number;
  deadlineAt: number | null;
};
export type State = {
  schemaVersion: 1;
  conversations: Conversation[];
  receipts: Record<string, { hash: string; id: string }>;
};
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
