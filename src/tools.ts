import { defineExtension } from "@earendil-works/pi-durable";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import type { ToolInfo } from "./execution/protocol.js";
import type { AgentService } from "./service.js";

export function agentTools(service: AgentService) {
  return defineExtension({
    name: "workspace",
    tools: createCodingTools().tools!.map((tool) => ({
      ...tool,
      replay: "unsafe" as const,
      execute: async (args, api, context) => {
        const id = await service.toolConversation(api.conversationId);
        const result = await service.runner.call(
          id,
          "tool",
          {
            name: tool.name,
            args,
            commandSeconds: service.config.limits.commandSeconds,
            commandBytes: service.config.limits.commandBytes,
          },
          context.abortSignal,
        );
        if (!result.result) throw new Error("Missing worker result");
        return result.result;
      },
    })),
  });
}
export function mcpTools(
  service: AgentService,
  tools: ToolInfo[],
  server: number,
) {
  return defineExtension({
    name: `mcp-${server}`,
    tools: tools.map((tool, index) => ({
      name: `mcp_${server}_${index}`,
      description: `[${service.config.mcp[server]!.name}/${tool.name}] ${tool.description}`,
      parameters: tool.parameters,
      replay: "unsafe" as const,
      execute: async (args, api, context) => {
        const id = await service.toolConversation(api.conversationId);
        const result = await service.runner.call(
          id,
          "mcp_call",
          {
            server: service.config.mcp[server],
            name: tool.name,
            args,
            commandSeconds: service.config.limits.commandSeconds,
          },
          context.abortSignal,
        );
        if (!result.result) throw new Error("Missing MCP result");
        return result.result;
      },
    })),
  });
}
