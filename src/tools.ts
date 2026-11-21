import { hash } from "./security.js";
import type { McpConfig } from "./settings.js";
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
        return service.callTool(
          api.conversationId,
          tool.name,
          args,
          context.abortSignal,
        );
      },
    })),
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
