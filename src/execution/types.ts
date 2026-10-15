import type { ProcessResult } from "../process.js";

export type EnvironmentState = "stopped" | "starting" | "ready" | "failed";

export interface EnvironmentInfo {
  id: string;
  backend: "firecracker";
  state: EnvironmentState;
  workspace: "/workspace";
}

export interface EnvironmentDiagnosis {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}

export interface EnvironmentCommand {
  argv: string[];
  timeoutMs: number;
  maxOutputBytes: number;
}

// Deliberately independent of Pi, model credentials, runs and host workspaces.
// File operations and persistent processes join this contract in PR 2/3;
// callers must not substitute host tools for unsupported guest capabilities.
export interface ExecutionEnvironment {
  diagnose(signal?: AbortSignal): Promise<EnvironmentDiagnosis>;
  create(signal?: AbortSignal): Promise<EnvironmentInfo>;
  start(id: string, signal?: AbortSignal): Promise<EnvironmentInfo>;
  status(id: string, signal?: AbortSignal): Promise<EnvironmentInfo>;
  execute(
    id: string,
    command: EnvironmentCommand,
    signal?: AbortSignal,
  ): Promise<ProcessResult>;
  stop(id: string, signal?: AbortSignal): Promise<EnvironmentInfo>;
  destroy(id: string, signal?: AbortSignal): Promise<void>;
}
