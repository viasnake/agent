import { awaitWithContext } from "@earendil-works/chord/context";
import { z } from "zod";
import { defineExtension } from "@earendil-works/pi-durable";
import type { AgentService } from "./service.js";
import { candidateKey, planInput } from "./parallel-work.js";
import { retryInput } from "./work-anchor.js";

const statusInput = z.object({ id: z.uuid().optional() }).strict();

const exportInput = z
  .object({ id: z.uuid(), candidate: candidateKey })
  .strict();

export function workTools(service: AgentService) {
  return defineExtension({
    name: "parallel-work",
    tools: [
      {
        name: "parallel_work",
        description:
          "For an authorized change to 2–6 independent UTF-8 files in one session-local Git clone, split the goal into one precise assignment per file and supply the full base commit and a meaningful local acceptance test command. Each producer sees the pinned file, your instructions and up to two named read-only reference files from the same base. Specify relevant interfaces and constraints. Up to two producers use the selected model concurrently. Integrate and test the exact patch in a fresh checkout. Wait for results; inspect failures and repair only the affected assignment. Do not run external updates in the check.",
        parameters: z.toJSONSchema(planInput),
        replay: "unsafe",
        execute: async (value, api, ctx) => {
          const result = await awaitWithContext(
            service.startWork(
              api.conversationId,
              planInput.parse(value),
              ctx.abortSignal,
            ),
            ctx,
          );
          return { output: [{ type: "text", text: JSON.stringify(result) }] };
        },
      },
      {
        name: "parallel_work_status",
        description:
          "Read progress, assignment attempts and the latest candidate check for parallel work in this conversation. Defaults to the most recent work. Use after a stopped response or before a repair. Does not dispatch work.",
        parameters: z.toJSONSchema(statusInput),
        replay: "safe",
        execute: async (value, api) => {
          const { id } = statusInput.parse(value);
          const owner = await service.toolConversation(api.conversationId);
          const items = await service.work.view({
            id: owner,
            piId: api.conversationId,
          });
          const work = id ? items.find((w) => w.id === id) : items.at(-1);
          return {
            output: [
              {
                type: "text",
                text: work ? JSON.stringify(work) : "該当する作業はありません",
              },
            ],
          };
        },
      },
      {
        name: "parallel_work_export",
        description:
          "Materialize the exact passed candidate patch in the current session outputs. Returns a workspace-relative path and SHA-256. Use with ordinary Git when integration, commit or PR delivery was requested. Inspect the checkout and respect existing edits and publication permissions.",
        parameters: z.toJSONSchema(exportInput),
        replay: "unsafe",
        execute: async (value, api, context) => {
          const { id, candidate } = exportInput.parse(value);
          const owner = await service.toolConversation(api.conversationId);
          const result = await awaitWithContext(
            service.exportWorkPatch(owner, id, candidate, context.abortSignal),
            context,
          );
          return { output: [{ type: "text", text: JSON.stringify(result) }] };
        },
      },
      {
        name: "parallel_work_retry",
        description:
          "Retry an existing failed parallel work. Omit path to retry only unfinished assignments or to rerun the frozen candidate check when the cause was environmental. For code or documentation corrections, specify the affected path and guidance based on the failed check. The successful sibling's contribution is retained. Interrupted checks can have side effects; reconcile first. A user-paused work requires a user resume.",
        parameters: z.toJSONSchema(retryInput),
        replay: "unsafe",
        execute: async (value, api, ctx) => {
          const result = await awaitWithContext(
            service.retryWork(
              api.conversationId,
              retryInput.parse(value),
              ctx.abortSignal,
            ),
            ctx,
          );
          return { output: [{ type: "text", text: JSON.stringify(result) }] };
        },
      },
    ],
  });
}
