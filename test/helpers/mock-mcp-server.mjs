// Minimal MCP stdio server used by the integration test. Exposes one read-only
// "echo" tool. Run with: node test/helpers/mock-mcp-server.mjs
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "mock", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo",
      description: "Echo back the provided text",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string", description: "text to echo" } },
        required: ["text"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => ({
  content: [{ type: "text", text: `echo: ${req.params.arguments?.text ?? ""}` }],
}));

await server.connect(new StdioServerTransport());
