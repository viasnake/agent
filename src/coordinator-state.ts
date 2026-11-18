import { defineDoc } from "@earendil-works/pi-durable";
import type { Conversation } from "./state.js";
import { AppError } from "./security.js";

export type RequestBudget = {
  id: string;
  sourceSessionId: string;
  sourceSubmissionId?: number;
  deadline: number;
  maxCalls: number;
  calls: number;
  tokens: number;
  reservedTokens: number;
  maxTokens: number;
  cost: number | null;
  children: number;
  corrections: number;
  paused: boolean;
  objective: string;
  criteria: string[];
  state: "open" | "checking" | "needs_user" | "done" | "paused";
  resultRefs: string[];
  revision: number;
  sessionIds: string[];
  directives: Record<string, number>;
};
export type CoordinatorCommand = {
  sequence: number;
  sessionId: string;
  budgetId: string;
  text: string;
  directiveVersion: number;
  controlEpoch: number;
};
export type CoordinatorEvent = {
  sequence: number;
  sessionId: string;
  budgetId: string;
  kind: "result" | "direct_input" | "interrupted" | "stopped" | "conflict";
  directiveVersion: number;
  controlEpoch: number;
  submissionId?: number;
};
export type CoordinatorState = {
  id?: string;
  sequence: number;
  inputVersion: number;
  paused: boolean;
  epoch: number;
  commands: CoordinatorCommand[];
  events: CoordinatorEvent[];
  budgets: RequestBudget[];
  sources?: string[];
  activeEvent?: CoordinatorEvent;
  checkpoint?: { text: string; inputVersion: number };
};
export const CoordinatorDoc = defineDoc<CoordinatorState>({
  kind: "agent.coordinator",
  version: 1,
  scope: "session",
  initial: () => ({
    sequence: 0,
    inputVersion: 0,
    paused: false,
    epoch: 0,
    commands: [],
    events: [],
    budgets: [],
  }),
  checkpointWhen: () => true,
});

export function budgetFor(state: CoordinatorState, id: string) {
  const budget = state.budgets.find((item) => item.id === id);
  if (!budget) throw new AppError(410, "依頼の受付期限が切れています");
  return budget;
}
export function checkBudget(budget: RequestBudget) {
  if (
    budget.paused ||
    budget.deadline <= Date.now() ||
    budget.calls >= budget.maxCalls ||
    budget.tokens + budget.reservedTokens >= budget.maxTokens
  )
    throw new AppError(
      409,
      "依頼を停止しています。期限・使用量を確認してください",
    );
}
export function newBudget(
  id: string,
  sourceSessionId: string,
  limits: { modelRequests: number; runSeconds: number },
): RequestBudget {
  return {
    id,
    sourceSessionId,
    deadline: Date.now() + limits.runSeconds * 1000,
    maxCalls: limits.modelRequests,
    calls: 0,
    tokens: 0,
    reservedTokens: 0,
    maxTokens: Math.min(1_000_000, limits.modelRequests * 16_384),
    cost: 0,
    children: 0,
    corrections: 0,
    paused: false,
    objective: "",
    criteria: [],
    state: "open",
    resultRefs: [],
    revision: 1,
    sessionIds: [],
    directives: {},
  };
}
export function queueEvent(
  state: CoordinatorState,
  conversation: Conversation,
  kind: CoordinatorEvent["kind"],
) {
  if (!conversation.coordinatorId || !conversation.budgetId) return;
  if (state.events.length >= 256)
    throw new AppError(413, "管理通知の保存上限に達しました");
  state.events.push({
    sequence: ++state.sequence,
    sessionId: conversation.id,
    budgetId: conversation.budgetId,
    kind,
    directiveVersion: conversation.directiveVersion ?? 0,
    controlEpoch: conversation.controlEpoch ?? 0,
  });
}

/** Deletion removes derived state as well as prose, including superseded copies. */
export function withoutSession(
  state: CoordinatorState,
  purged: Set<string>,
): CoordinatorState {
  const next = {
    ...state,
    budgets: state.budgets.filter(
      (b) =>
        !purged.has(b.sourceSessionId) &&
        !b.sessionIds.some((id) => purged.has(id)),
    ),
    commands: state.commands.filter((c) => !purged.has(c.sessionId)),
    events: state.events.filter((e) => !purged.has(e.sessionId)),
  };
  delete next.checkpoint;
  if (next.activeEvent && purged.has(next.activeEvent.sessionId))
    delete next.activeEvent;
  next.sources = next.sources?.filter((id) => !purged.has(id)) ?? [];
  const budgets = new Set(next.budgets.map((b) => b.id));
  if (next.activeEvent && !budgets.has(next.activeEvent.budgetId))
    delete next.activeEvent;
  next.commands = next.commands.filter((c) => budgets.has(c.budgetId));
  next.events = next.events.filter((e) => budgets.has(e.budgetId));
  return next;
}
