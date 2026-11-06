import { defineDoc } from "@earendil-works/pi-durable";
import type { ConversationId, SubmissionId } from "@earendil-works/pi-durable";

export type Status =
  | "queued"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "cancelled";
export type WaitReason =
  | "user"
  | "approval"
  | "network"
  | "credentials"
  | "budget"
  | "reconciliation"
  | "environment"
  | "schema";
export type Limits = {
  modelRequests: number;
  deadlineSeconds: number;
  repairs: number;
  commandSeconds: number;
  logBytes: number;
  uploadBytes: number;
  uploadTotalBytes: number;
  artifactBytes: number;
  artifactTotalBytes: number;
};
export const DEFAULT_LIMITS: Limits = {
  modelRequests: 60,
  deadlineSeconds: 3600,
  repairs: 3,
  commandSeconds: 300,
  logBytes: 10485760,
  uploadBytes: 20971520,
  uploadTotalBytes: 52428800,
  artifactBytes: 52428800,
  artifactTotalBytes: 209715200,
};
export type Artifact = {
  id: string;
  jobId: string;
  name: string;
  version: number;
  mediaType: string;
  size: number;
  sha256: string;
  createdAt: string;
  workspaceRevision: number;
};
export type Validation = {
  id: string;
  kind: "command" | "render" | "review";
  command: string;
  exitCode: number;
  logArtifactId: string;
  workspaceRevision: number;
  createdAt: string;
};
export type Source = {
  id: string;
  url: string;
  title: string;
  fetchedAt: string;
  quote: string;
  truncated: boolean;
  sha256: string;
  artifactId: string;
};
export type Input = {
  requestId: string;
  text: string;
  submissionId?: SubmissionId;
  applied: boolean;
};
export type Operation = {
  id: string;
  jobId: string;
  kind: "shell" | "github";
  target: string;
  argumentHash: string;
  policyRevision: number;
  status: "prepared" | "dispatched" | "completed" | "failed" | "unknown";
  approvalId?: string;
  resultId?: string;
  evidence?: string;
  payload?: GithubPayload;
};
export type GithubPayload = {
  repository: string;
  branch: string;
  base: string;
  baseSha: string;
  title: string;
  body: string;
  files: { path: string; content: string }[];
};
export type Approval = {
  id: string;
  operationId: string;
  argumentHash: string;
  policyRevision: number;
  approved: boolean;
};
export type Job = {
  schemaVersion: 1;
  id: string;
  conversationId: ConversationId;
  status: Status;
  waitReason?: WaitReason;
  detail: string;
  title: string;
  objective: string;
  kind: "code" | "research";
  acceptance: string[];
  parentId?: string;
  parentArtifactIds: string[];
  project: string;
  repoUrl?: string;
  attachmentIds: string[];
  createdAt: string;
  updatedAt: string;
  revision: number;
  policyRevision: number;
  modelId: string | null;
  instructions: string;
  limits: Limits;
  deadlineAt?: number;
  counters: { modelRequests: number; repairs: number };
  inputs: Input[];
  artifacts: Artifact[];
  validations: Validation[];
  sources: Source[];
  operations: Operation[];
  approvals: Approval[];
  workspaceRevision: number;
  started: boolean;
  completion?: {
    summary: string;
    limitations: string[];
    criteria: string[];
    workspaceRevision: number;
  };
  externalAllowed: boolean;
  allowedRepositories: string[];
  cleanupConfirmed: boolean;
  workspaceReady: boolean;
  recoveryRequired: boolean;
  renderPages: {
    path: string;
    artifactId: string;
    inspected: boolean;
    workspaceRevision: number;
  }[];
};
export type Receipt = { hash: string; result: { id: string } };
export type Upload = { id: string; name: string; size: number; sha256: string };
export type AppState = {
  schemaVersion: 1;
  jobs: Job[];
  activeJobId: string | null;
  receipts: Record<string, Receipt>;
  uploads: Upload[];
  settings: {
    revision: number;
    commonInstructions: string;
    projectNotes: Record<string, string>;
  };
  cleanShutdown: boolean;
  recoveryHold: boolean;
};
export const AppDoc = defineDoc<AppState>({
  kind: "agent.app",
  version: 1,
  scope: "session",
  initial: () => ({
    schemaVersion: 1,
    jobs: [],
    activeJobId: null,
    receipts: {},
    uploads: [],
    settings: { revision: 1, commonInstructions: "", projectNotes: {} },
    cleanShutdown: true,
    recoveryHold: false,
  }),
  checkpointWhen: () => true,
});
export const terminal = (job: Job) =>
  ["succeeded", "failed", "cancelled"].includes(job.status);
export function touch(job: Job): void {
  job.revision++;
  job.updatedAt = new Date().toISOString();
}
