import { AgentError, type Run, type Task } from "./types.js";

const resumableTaskErrors = new Set([
  "AUTH",
  "QUOTA",
  "BLOCKED",
  "CONTEXT_LIMIT",
  "NO_MODEL",
  "PROVIDER",
  "REQUEST_TIMEOUT",
  "RUNTIME_SESSION",
]);
const inputErrors = new Set([
  ...resumableTaskErrors,
  "MCP_AUTH",
  "CHECK_CONFIG",
  "SANDBOX",
]);

export function taskFailureState(error: unknown): Task["state"] {
  return error instanceof AgentError && resumableTaskErrors.has(error.code)
    ? "pending"
    : "failed";
}

export function runFailureState(
  error: unknown,
  options: { timedOut: boolean; cancelled: boolean; uncertain: boolean },
): Run["state"] {
  const code = error instanceof AgentError ? error.code : "";
  if (options.timedOut) return "failed";
  if (options.cancelled || code === "CANCELLED") return "cancelled";
  if (options.uncertain || code === "UNKNOWN_OPERATION")
    return "waiting_approval";
  if (code === "QUOTA") return "waiting_quota";
  if (inputErrors.has(code)) return "waiting_input";
  return "failed";
}
