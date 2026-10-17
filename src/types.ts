export type DataClass = "public" | "private" | "restricted";
export type RequestAccess = "read-only" | "change";
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
export interface DelegationRequest {
  objective: string;
  constraints: string[];
  sourceIds: string[];
  expectedResult: string;
  acceptance: string[];
  model?: string;
}
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
  resultFormat?: "text" | "structured";
  purpose?: "synthesis";
  delegatedBy?: string;
  assignment?: DelegationRequest;
  delegationRounds?: number;
  attemptReportIds?: string[];
  contextArchiveIds?: string[];
  reworkLinks?: Array<{
    priorReportIds: string[];
    reason: string;
    repairAttempt: number;
    status?: "pending" | "resolved";
    resolvedByReportIds?: string[];
  }>;
}
export interface TaskResult {
  outcome: "completed" | "needs_replan" | "blocked" | "failed";
  summary: string;
  artifacts: string[];
  unresolved: string[];
  delegations?: DelegationRequest[];
}
export interface ImageReference {
  id: string;
  name: string;
  mimeType: string;
  width: number;
  height: number;
  editWidth?: number;
  editHeight?: number;
  bytes: number;
  sha256: string;
  dataClass: DataClass;
  localOnly: boolean;
  sourceId?: string;
  documentId?: string;
  transformation?: string;
  comparisonOrder?: number;
}
export interface DocumentReference {
  id: string;
  originalName: string;
  format: string;
  selector: string;
  rawSha256: string;
  selectedSha256: string;
  rawBytes: number;
  selectedBytes: number;
  locator: string;
  partial: boolean;
  imageIds?: string[];
}
export interface PreparedInput {
  reference: DocumentReference;
  text: string;
  images?: ImageReference[];
}
export interface RuntimeImage {
  reference: ImageReference;
  data: Buffer;
}
export interface ContextNote {
  id: string;
  text: string;
  kind: "pin" | "decision" | "question";
  author: "user" | "host" | "model";
  trusted: boolean;
  updatedAt: number;
}
export interface ContextCompaction {
  id: string;
  archiveId: string;
  at: number;
  beforeBytes: number;
  afterBytes: number;
  trigger: "automatic" | "manual";
  heuristic: "bytes/3+images*8192";
}
export interface ConversationContext {
  pins: ContextNote[];
  decisions: ContextNote[];
  openQuestions: ContextNote[];
  constraints: string[];
  instructions: Array<{
    seq: number;
    role: string;
    text: string;
    runId?: string;
  }>;
  sourceIds: string[];
  imageIds: string[];
  redactedImageIds?: string[];
  researchCheckpoint?: ResearchCheckpoint;
  excludedSourceIds?: string[];
  excludedSourceHashes?: string[];
  excludedSourceUrls?: string[];
  originalRunIds: string[];
  workingState: {
    runId?: string;
    status?: string;
    checks: string[];
    hashes: Record<string, string>;
    artifacts: string[];
    operations: Array<{
      id: string;
      taskId: string;
      name: string;
      status: string;
      argsHash: string;
    }>;
    history: Array<{
      runId: string;
      status: string;
      checks: string[];
      hashes: Record<string, string>;
      artifacts: string[];
      operations: Array<{
        id: string;
        taskId: string;
        name: string;
        status: string;
        argsHash: string;
      }>;
      results: Array<{
        role: string;
        model?: string;
        summary?: string;
        unresolved?: string[];
        author: "model";
        trusted: false;
      }>;
    }>;
  };
  compactions: ContextCompaction[];
}
export interface ResearchCheckpoint {
  summary: string;
  searchedScopes: string[];
  openQuestions: string[];
  decisions: Array<{ text: string; sourceIds: string[] }>;
  unavailableSourceIds?: string[];
  author: "model";
  trusted: false;
  updatedAt: number;
}
export interface Run {
  parentRunId?: string;
  conversationId?: string;
  context?: string;
  contextState?: ConversationContext;
  constraints?: string[];
  access?: RequestAccess;
  compactions?: ContextCompaction[];
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
  images?: ImageReference[];
  preparedInputs?: DocumentReference[];
  checks: string[];
  mustKeep: string[];
  planAttempts: number;
  repairAttempts: number;
  lastFailureFingerprint?: string;
  forkCheckpointId?: string;
}
export interface Artifact {
  id: string;
  runId: string;
  name: string;
  kind: "document" | "patch" | "check" | "source" | "source-raw" | "report";
  sha256: string;
  bytes: number;
  dataClass: DataClass;
  metadata: Record<string, unknown>;
}
export interface ArtifactHistoryEntry {
  artifact: Artifact;
  run: {
    id: string;
    state: RunState;
  };
  provenanceId?: string;
}
export interface ArtifactValidationCheck {
  id: string;
  passed: boolean;
  detail: string;
}
export interface ArtifactProvenanceSourceRange {
  sourceId: string;
  startLine: number | null;
  endLine: number | null;
  rawCitation?: string;
}
export type ArtifactProvenance =
  | {
      status: "unknown";
      legacy: true;
      artifactId: string;
      artifactSha256: string;
    }
  | {
      status: "available";
      legacy: false;
      version: 1;
      type: "provenance";
      documentId: string;
      artifactId: string;
      artifactSha256: string;
      producingRunId: string;
      parentRunId?: string;
      availableInputSourceIds: string[];
      citedSourceRanges: ArtifactProvenanceSourceRange[];
      unavailableCitedSourceIds: string[];
      validation: {
        artifactId: string;
        sha256: string;
        checks: ArtifactValidationCheck[];
      };
      semanticCorrectness: "not-established";
    };
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
  access?: RequestAccess;
  constraints?: string[];
  images?: RuntimeImage[];
  system: string;
  sessionDir: string;
  sessionFile?: string;
  tools: ToolSpec[];
  signal: AbortSignal;
  transformContext?: (
    context: unknown,
    signal: AbortSignal,
  ) => Promise<unknown>;
  onSession(file: string): void;
  beforeRequest(
    inputBytes: number,
    imageCount?: number,
    estimatedImageTokens?: number,
  ): string;
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
