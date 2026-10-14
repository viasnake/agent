export type DataClass = "public" | "private" | "restricted";
export type WorkKind = "coding" | "research" | "writing" | "chat";
export type Role = "lead" | "worker" | "reviewer";
export type RunState =
  | "created"
  | "planning"
  | "running"
  | "validating"
  | "repairing"
  | "waiting_input"
  | "waiting_quota"
  | "waiting_approval"
  | "succeeded"
  | "failed"
  | "cancelled";
export type TaskState = "pending" | "running" | "succeeded" | "failed";
export interface Task {
  id: string;
  objective: string;
  role: Role;
  dependsOn: string[];
  model?: string;
  write: boolean;
  state: TaskState;
  attempts: number;
  result?: TaskResult;
  sessionFile?: string;
}
export interface TaskResult {
  outcome: "completed" | "needs_replan" | "blocked" | "failed";
  summary: string;
  artifacts: string[];
  unresolved: string[];
}
export interface Run {
  parentRunId?: string;
  context?: string;
  previousSessions?: Record<string, { model: string; file: string }>;
  prepared: boolean;
  id: string;
  objective: string;
  kind: WorkKind;
  mode: "single" | "assisted" | "reviewed";
  dataClass: DataClass;
  localOnly: boolean;
  workspace?: string;
  model?: string;
  reviewer?: string;
  state: RunState;
  reason?: string;
  createdAt: number;
  updatedAt: number;
  elapsedMs: number;
  generation: number;
  configHash: string;
  tasks: Task[];
  inputs: string[];
  checks: string[];
  mustKeep: string[];
  planAttempts: number;
  repairAttempts: number;
  lastFailureFingerprint?: string;
}
export interface Artifact {
  id: string;
  runId: string;
  name: string;
  kind: "document" | "patch" | "check" | "source" | "report";
  sha256: string;
  bytes: number;
  dataClass: DataClass;
  metadata: Record<string, unknown>;
}
export interface ModelUsage {
  input: number | null;
  output: number | null;
  costUsd: number | null;
}
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>, signal: AbortSignal): Promise<string>;
}
export interface RuntimeRequest {
  model: string;
  role: Role;
  objective: string;
  system: string;
  sessionDir: string;
  sessionFile?: string;
  tools: ToolSpec[];
  signal: AbortSignal;
  onSession(file: string): void;
  beforeRequest(inputBytes: number): string;
  afterRequest(reservationId: string, usage: ModelUsage): void;
  onEvent(type: string, detail: Record<string, unknown>): void;
}
export interface Runtime {
  run(request: RuntimeRequest): Promise<string>;
  close(): Promise<void>;
}
export class AgentError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AgentError";
  }
}
export const terminalStates: RunState[] = ["succeeded", "failed", "cancelled"];
