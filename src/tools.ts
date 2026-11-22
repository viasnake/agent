import { z } from "zod";
import { questionInput, questionTool } from "./choices.js";
import type { LongCommand } from "./long-command.js";
import { AppError, hash } from "./security.js";
import type { McpConfig } from "./settings.js";
import {
  defineExtension,
  hook,
  ToolTask,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import type { ToolInfo } from "./execution/protocol.js";
import type { AgentService } from "./service.js";

const startInput = z
  .object({
    command: z.string().min(1).max(64000),
    timeout: z.number().int().min(1).max(3600).optional(),
  })
  .strict();
const commandInput = z.object({ commandId: z.string().uuid() }).strict();
const statusInput = commandInput.extend({
  waitSeconds: z.number().min(0).max(60).optional(),
});

function commandResult(command: ReturnType<LongCommand["snapshot"]>) {
  return {
    output: [
      {
        type: "text" as const,
        text: `Command ID: ${command.id}\nState: ${command.state}${command.exitCode === undefined ? "" : `\nExit code: ${command.exitCode}`}\n${command.output}`,
      },
    ],
    isError:
      command.state === "failed" ||
      command.state === "timed_out" ||
      (command.exitCode !== undefined && command.exitCode !== 0),
  };
}

export function agentTools(service: AgentService) {
  return defineExtension({
    name: "workspace",
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call, api, context) => {
          if (
            !call.parent &&
            (await service.mixedQuestionRound(api.conversationId, context))
          )
            return {
              block:
                "Call request_user_input on its own, with no other tool calls in the same response.",
            };
        },
      }),
    ],
    tools: [
      ...createCodingTools().tools!.map(
        (tool): ToolRegistration => ({
          ...tool,
          replay: "unsafe" as const,
          execute: async (args, api, context) => {
            return service.callTool(
              api.conversationId,
              tool.name,
              args,
              context.abortSignal,
            );
          },
        }),
      ),
      {
        name: "bash_start",
        description:
          "Start a long Bash command in the session directory. Returns a command ID, state, and available output after a short wait. Use bash_status to check it or bash_stop to cancel it. Only one command at a time, with the conversation's execution deadline. While it runs, do not call other workspace or stdio MCP operations. Check the final state before reporting success. The command is stopped when this response ends. No stdin or PTY.",
        parameters: z.toJSONSchema(startInput),
        replay: "unsafe",
        execute: async (value, api, context) => {
          const args = startInput.parse(value);
          return commandResult(
            await service.startCommand(
              api.conversationId,
              args,
              context.abortSignal,
            ),
          );
        },
      },
      {
        name: "bash_status",
        description:
          "Check a command started by bash_start in this response. While running, shows a bounded preview of recent output; after exit, shows the retained tail and exit code. Waits up to waitSeconds (default 10, max 60) if still running.",
        parameters: z.toJSONSchema(statusInput),
        replay: "unsafe",
        execute: async (value, api, context) => {
          const { commandId, waitSeconds } = statusInput.parse(value);
          return commandResult(
            await service.checkCommand(
              api.conversationId,
              commandId,
              (waitSeconds ?? 10) * 1000,
              context.abortSignal,
            ),
          );
        },
      },
      {
        name: "bash_stop",
        description:
          "Stop a command started by bash_start in this response and wait for cleanup. Does not undo side effects. Returns the final state if it already exited.",
        parameters: z.toJSONSchema(commandInput),
        replay: "unsafe",
        execute: async (value, api, context) => {
          const { commandId } = commandInput.parse(value);
          return commandResult(
            await service.stopCommand(
              api.conversationId,
              commandId,
              context.abortSignal,
            ),
          );
        },
      },
      {
        name: questionTool,
        description:
          "Ask a single focused question with 2–5 short, distinct options when user input is necessary before continuing. Call this tool alone. It ends the current response; the user can choose an option or reply in the composer. A displayed option is not authorization until the user responds.",
        parameters: z.toJSONSchema(questionInput),
        replay: "unsafe",
        execute: async (value, api) => {
          await service.toolConversation(api.conversationId);
          const question = questionInput.safeParse(
            service.sanitize(questionInput.parse(value)),
          );
          if (!question.success)
            throw new AppError(400, "質問と重複しない選択肢を指定してください");
          const details = question.data;
          return {
            details,
            output: [
              {
                type: "text" as const,
                text: [
                  details.question,
                  ...details.options.map((option, i) => `${i + 1}. ${option}`),
                ].join("\n"),
              },
            ],
            control: { terminate: true },
          };
        },
      },
    ],
  });
}
export function mcpToolName(server: string, tool: string): string {
  return `mcp_${server.replaceAll("-", "")}_${hash(tool).slice(0, 12)}`;
}
export function mcpToolLabel(server: McpConfig, tool: string): string {
  return `${server.name}/${tool}`.slice(0, 300);
}
export function mcpTools(
  service: AgentService,
  tools: ToolInfo[],
  server: McpConfig,
  sessionId: string,
) {
  return defineExtension({
    name: `mcp-${server.id}-${sessionId}`,
    tools: tools.map((tool) => ({
      name: mcpToolName(server.id, tool.name),
      description: service
        .redact(`[${server.name}/${tool.name}] ${tool.description}`)
        .slice(0, 8000),
      parameters: service.sanitize(tool.parameters),
      replay: "unsafe" as const,
      execute: async (args, api, context) => {
        const id = await service.toolConversation(api.conversationId);
        const result = await service.callMcp(
          server,
          id,
          tool.name,
          args as Record<string, unknown>,
          context.abortSignal,
        );
        return {
          ...result,
          details: {
            agentMcpToolLabel: service.redact(mcpToolLabel(server, tool.name)),
          },
        };
      },
    })),
  });
}
