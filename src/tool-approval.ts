import { AgentError } from "./types.js";

export interface ToolApprovalRequest {
  readonly runId: string;
  readonly taskId: string;
  readonly operationId: string;
  readonly server: string;
  readonly tool: string;
  readonly effect: "change" | "publish" | "delete" | "dangerous";
  readonly destination: string;
  readonly schemaSha256: string;
  readonly bindingSha256: string;
  readonly argumentsJson: string;
  readonly argumentsSha256: string;
  readonly previousCompletions: number;
}
export type ToolApprovalHandler = (
  request: ToolApprovalRequest,
  signal: AbortSignal,
) => Promise<boolean>;

export async function requestToolApproval(
  handler: ToolApprovalHandler | undefined,
  request: ToolApprovalRequest,
  signal: AbortSignal,
): Promise<boolean> {
  signal.throwIfAborted();
  if (!handler)
    throw new AgentError(
      "TOOL_APPROVAL_REQUIRED",
      "This external operation requires an interactive per-call approval; no approval handler is available",
    );
  return new Promise<boolean>((resolve, reject) => {
    let settled = false;
    const finish = (accepted: boolean) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      resolve(accepted && !signal.aborted);
    };
    const abort = () => finish(false);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    Promise.resolve()
      .then(() =>
        signal.aborted ? false : handler(Object.freeze(request), signal),
      )
      .then(
        (accepted) => finish(accepted === true),
        () => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", abort);
          reject(
            new AgentError(
              "TOOL_APPROVAL_REQUIRED",
              "The approval interaction could not complete; the operation was not sent",
            ),
          );
        },
      );
  });
}
