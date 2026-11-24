import { z } from "zod";
import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import type { TerminalIO } from "./terminal.js";
import { gitIdentityView } from "./git-identity.js";
import { gitReviewResult, type GitReviewResult } from "../git-review.js";
import { gitWorkResult } from "../parallel-work.js";
export const requestSchema = z
  .object({
    id: z.string().uuid(),
    conversationId: z.string().uuid(),
    op: z.enum([
      "health",
      "init",
      "tool",
      "long_command",
      "mcp_list",
      "mcp_call",
      "list",
      "download",
      "upload",
      "read_attachment",
      "cleanup",
      "delete_workspace",
      "worktrees",
      "git_identity",
      "git_review",
      "parallel_work",
    ]),
    args: z.record(z.string(), z.unknown()),
  })
  .strict();
export type WorkerRequest = z.infer<typeof requestSchema>;
export type ToolInfo = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};
export type WorkFile = { path: string; size: number };
export type WorkerResult = {
  uid?: number;
  cgroup?: string;
  cleanup?: boolean;
  data?: string;
  path?: string;
  files?: WorkFile[];
  truncated?: boolean;
  tools?: ToolInfo[];
  result?: ToolExecutionResult;
  gitReview?: GitReviewResult;
  parallelWork?: z.infer<typeof gitWorkResult>;
  gitIdentity?: z.infer<typeof gitIdentityView> | { conflict: true };
};
export const executableOperations = new Set<WorkerRequest["op"]>([
  "tool",
  "long_command",
  "mcp_call",
  "mcp_list",
  "worktrees",
  "git_identity",
  "git_review",
  "parallel_work",
]);
export const replySchema = z
  .object({
    id: z.string().uuid(),
    ok: z.boolean(),
    result: z
      .object({
        uid: z.number().int().optional(),
        cgroup: z.string().max(4096).optional(),
        cleanup: z.boolean().optional(),
        data: z.string().optional(),
        path: z.string().optional(),
        files: z
          .array(
            z
              .object({ path: z.string(), size: z.number().nonnegative() })
              .strict(),
          )
          .max(200)
          .optional(),
        truncated: z.boolean().optional(),
        tools: z
          .array(
            z
              .object({
                name: z.string(),
                description: z.string(),
                parameters: z.record(z.string(), z.unknown()),
              })
              .strict(),
          )
          .max(100)
          .optional(),
        result: z
          .custom<ToolExecutionResult>(
            (v) => v !== null && typeof v === "object",
          )
          .optional(),
        gitReview: gitReviewResult.optional(),
        parallelWork: gitWorkResult.optional(),
        gitIdentity: z
          .union([
            gitIdentityView,
            z.object({ conflict: z.literal(true) }).strict(),
          ])
          .optional(),
      })
      .strict()
      .optional(),
    error: z.string().optional(),
  })
  .strict();
export const maxLongCommandSeconds = 3600;
export const commandPreviewWindow = 64 * 1024;
export const commandProgressSchema = z
  .object({
    id: z.string().uuid(),
    progress: z
      .object({
        text: z.string().max(commandPreviewWindow),
        truncated: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type CommandPreview = z.infer<typeof commandProgressSchema>["progress"];
export type CommandProgress = (preview: CommandPreview) => void;
export interface Runner {
  ready(): Promise<void>;
  terminal?(io: TerminalIO, signal: AbortSignal): Promise<void>;
  call(
    conversationId: string,
    op: WorkerRequest["op"],
    args: Record<string, unknown>,
    signal?: AbortSignal,
    onProgress?: CommandProgress,
  ): Promise<WorkerResult>;
  close(): Promise<void>;
}
export const PROTOCOL_BYTES = 32 * 1024 * 1024;
