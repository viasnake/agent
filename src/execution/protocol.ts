import { z } from "zod";
import type { ToolExecutionResult } from "@earendil-works/pi-durable";
export const requestSchema = z
  .object({
    id: z.string().uuid(),
    conversationId: z.string().uuid(),
    op: z.enum([
      "health",
      "init",
      "tool",
      "mcp_list",
      "mcp_call",
      "list",
      "download",
      "upload",
      "cleanup",
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
  cleanup?: boolean;
  data?: string;
  path?: string;
  files?: WorkFile[];
  truncated?: boolean;
  tools?: ToolInfo[];
  result?: ToolExecutionResult;
};
export const replySchema = z
  .object({
    id: z.string().uuid(),
    ok: z.boolean(),
    result: z
      .object({
        uid: z.number().int().optional(),
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
      })
      .strict()
      .optional(),
    error: z.string().optional(),
  })
  .strict();
export interface Runner {
  ready(): Promise<void>;
  call(
    conversationId: string,
    op: WorkerRequest["op"],
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<WorkerResult>;
  close(): Promise<void>;
}
export const PROTOCOL_BYTES = 32 * 1024 * 1024;
