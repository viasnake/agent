import { z } from "zod";
export const requestSchema = z
  .object({
    id: z.string().uuid(),
    jobId: z.string().uuid(),
    op: z.enum([
      "init",
      "read",
      "write",
      "shell",
      "patch",
      "source",
      "browse",
      "render",
      "export",
      "import",
      "cleanup",
      "health",
    ]),
    args: z.record(z.string(), z.unknown()),
  })
  .strict();
export type WorkerRequest = z.infer<typeof requestSchema>;
export const replySchema = z
  .object({
    id: z.string().uuid(),
    ok: z.boolean(),
    result: z
      .object({
        text: z.string().optional(),
        data: z.string().optional(),
        path: z.string().optional(),
        exitCode: z.number().int().optional(),
        truncated: z.boolean().optional(),
        log: z.string().optional(),
        uid: z.number().int().optional(),
        cleanup: z.boolean().optional(),
        title: z.string().optional(),
        url: z.string().optional(),
        fetchedAt: z.string().optional(),
        pages: z.number().int().optional(),
        screenshots: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    error: z.string().optional(),
  })
  .strict();
export type WorkerResult = NonNullable<z.infer<typeof replySchema>["result"]>;
export interface Runner {
  ready(): Promise<void>;
  call(
    jobId: string,
    op: WorkerRequest["op"],
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<WorkerResult>;
  close(): Promise<void>;
}
export const PROTOCOL_BYTES = 75 * 1024 * 1024;
