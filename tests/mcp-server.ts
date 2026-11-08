import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
const server = new McpServer({ name: "fixture", version: "1.0.0" });
server.registerTool(
  "greet",
  {
    description: "Return a fixture greeting",
    inputSchema: { name: z.string() },
  },
  async ({ name }) => ({ content: [{ type: "text", text: `Hello ${name}` }] }),
);
await server.connect(new StdioServerTransport());
