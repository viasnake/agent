import { z } from "zod";
import type { ConversationId, EntryRecord } from "@earendil-works/pi-durable";

export const questionTool = "request_user_input";
export const questionInput = z
  .object({
    question: z.string().trim().min(1).max(1000),
    options: z.array(z.string().trim().min(1).max(200)).min(2).max(5),
  })
  .strict()
  .refine(({ options }) => new Set(options).size === options.length);
const entryId = z.number().int().positive();
export const choiceInput = z.union([
  z.object({ entryId, option: z.number().int().min(0).max(4) }).strict(),
  z.object({ entryId, answer: z.string().trim().min(1).max(2000) }).strict(),
]);
export type Choice = z.infer<typeof choiceInput>;
export type PendingQuestion = z.infer<typeof questionInput> & {
  entryId: number;
};

export function pendingQuestion(
  entries: readonly EntryRecord[],
  conversationId: ConversationId,
): PendingQuestion | undefined {
  for (const entry of entries) {
    for (const message of [...(entry.model ?? [])].reverse()) {
      if (
        message.role === "toolResult" &&
        message.toolName === questionTool &&
        !message.isError &&
        entry.conversationId === conversationId
      ) {
        const detail = questionInput.safeParse(message.details);
        if (detail.success) return { entryId: entry.id, ...detail.data };
      }
      // Any subsequent input or model activity supersedes the card.
      if (
        message.role === "user" ||
        message.role === "assistant" ||
        message.role === "toolResult"
      )
        return;
    }
  }
}
