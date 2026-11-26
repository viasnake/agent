import {
  defineExtension,
  type ConversationId,
} from "@earendil-works/pi-durable";
import { awaitWithContext } from "@earendil-works/chord/context";
import { z } from "zod";
import { adoptInput, projectReportInput, teamInput } from "./projects.js";
import type { AgentService } from "./service.js";

export function projectTools(service: AgentService) {
  function tool<T extends z.ZodType>(
    name: string,
    description: string,
    schema: T,
    run: (
      id: ConversationId,
      input: z.infer<T>,
      signal: AbortSignal,
    ) => Promise<unknown>,
  ) {
    return {
      name,
      description,
      parameters: z.toJSONSchema(schema),
      replay:
        name === "project_status" || name === "project_review"
          ? ("safe" as const)
          : ("unsafe" as const),
      execute: async (
        value: unknown,
        api: { conversationId: ConversationId },
        context: Parameters<typeof awaitWithContext>[1],
      ) => {
        const data = await awaitWithContext(
          run(
            api.conversationId,
            schema.parse(value),
            context.abortSignal ?? new AbortController().signal,
          ),
          context,
        );
        return {
          output: [{ type: "text" as const, text: JSON.stringify(data) }],
        };
      },
    };
  }
  return defineExtension({
    name: "project-supervision",
    tools: [
      tool(
        "project_status",
        "Get the current directive revision, brief, progress and team results. Read at the start of a project response and after steering.",
        z.object({}).strict(),
        async (id) => service.team.read(await service.projectOwner(id)),
      ),
      tool(
        "project_team",
        "Delegate independent responsibilities to concurrent specialists. Give each a role and an outcome. They can investigate the same repository and test competing multi-file proposals against a pinned commit. Omit repository for document, analysis, or review tasks and supply necessary source material in context. Returns reports and actual check results for synthesis. Retry a failed role alone when useful.",
        teamInput,
        (id, input, signal) => service.delegateProject(id, input, signal),
      ),
      tool(
        "project_report",
        "Post a concise progress update or deliver the requested outcome with evidence. The dashboard displays this to the manager. For working include nextStep when the next action is known. For delivered put the actual requested text, analysis or document in deliverable (Markdown), and describe what you verified in evidence; export the selected patch if relevant. A reviewer checks the proposed delivery before publishing. Correct revision_requested feedback and resubmit.",
        projectReportInput,
        (id, input, signal) => service.reportProject(id, input, signal),
      ),
      tool(
        "project_review",
        "Read a specialist's exact diff, pinned base, and actual check before selecting an implementation. Compare competing proposals against the requested behavior. Continue at nextOffset when present.",
        adoptInput.extend({
          offset: z.number().int().nonnegative().optional(),
        }),
        async (id, input) => {
          const proposal = await service.team.review(
            await service.projectOwner(id),
            input,
          );
          const offset = input.offset ?? 0,
            end = offset + 16000;
          return {
            ...proposal,
            patch: proposal.patch.slice(offset, end),
            ...(end < proposal.patch.length ? { nextOffset: end } : {}),
          };
        },
      ),
      tool(
        "project_adopt",
        "Select one independently checked proposal for the current instruction and export its exact bytes for use with ordinary Git. Use the returned path, base and tree for authorized integration.",
        adoptInput,
        (id, input, signal) => service.adoptProject(id, input, signal),
      ),
    ],
  });
}
