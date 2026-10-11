import { createServer, type Server as HttpServer } from "node:http";
import { Server as LegacyMcpServer } from "@modelcontextprotocol/sdk-legacy/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk-legacy/server/sse.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk-legacy/types.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk-legacy/client/sse.js";
import type { McpServerConfig } from "../api/core/library/mcpSettings";
import { listMcpServerTools } from "../api/core/agent/tools/mcpTools";
import {
  createMcpRemoteTransport,
  LegacySseTransportAdapter,
} from "../api/core/agent/tools/mcpTransport";

const server: McpServerConfig = {
  id: "remote",
  name: "Remote MCP",
  command: "",
  args: [],
  env: {},
  url: "https://example.com/mcp",
  headers: { Authorization: "Bearer test-token" },
  enabled: true,
};

describe("MCP remote transport selection", () => {
  it("uses Streamable HTTP by default", () => {
    expect(createMcpRemoteTransport(server)).toBeInstanceOf(
      StreamableHTTPClientTransport,
    );
  });

  it("uses the legacy SSE client for explicitly configured SSE servers", () => {
    const transport = createMcpRemoteTransport({ ...server, transport: "sse" });
    expect(transport).toBeInstanceOf(LegacySseTransportAdapter);
    if (transport instanceof LegacySseTransportAdapter) {
      expect(transport.legacyTransport).toBeInstanceOf(SSEClientTransport);
    }
  });

  it("rejects remote transport creation without a URL", () => {
    expect(() =>
      createMcpRemoteTransport({ ...server, url: undefined }),
    ).toThrow("MCP server 'Remote MCP' has no remote URL");
  });

  it("discovers tools from a legacy SSE endpoint and sends configured headers", async () => {
    const legacyServer = new LegacyMcpServer(
      { name: "legacy-test", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    legacyServer.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: "hello", description: "Test tool", inputSchema: { type: "object" } }],
    }));

    const transports = new Map<string, SSEServerTransport>();
    let httpServer: HttpServer | undefined;
    try {
      httpServer = createServer(async (request, response) => {
        const url = new URL(request.url || "/", "http://localhost");
        if (request.headers.authorization !== "Bearer test-token") {
          response.writeHead(401).end();
          return;
        }

        if (request.method === "GET" && url.pathname === "/sse") {
          const transport = new SSEServerTransport("/messages", response);
          transports.set(transport.sessionId, transport);
          await legacyServer.connect(transport);
          return;
        }

        if (request.method === "POST" && url.pathname === "/messages") {
          const sessionId = url.searchParams.get("sessionId");
          const transport = sessionId ? transports.get(sessionId) : undefined;
          if (!transport) {
            response.writeHead(404).end();
            return;
          }
          await transport.handlePostMessage(request, response);
          return;
        }

        response.writeHead(404).end();
      });

      await new Promise<void>((resolve, reject) => {
        httpServer!.once("error", reject);
        httpServer!.listen(0, "127.0.0.1", () => resolve());
      });
      const address = httpServer.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to start test SSE server");
      }

      const tools = await listMcpServerTools(
        {
          ...server,
          url: `http://127.0.0.1:${address.port}/sse`,
          transport: "sse",
        },
        process.cwd(),
      );

      expect(tools).toEqual([
        { name: "hello", description: "Test tool", inputSchema: { type: "object" } },
      ]);
    } finally {
      await legacyServer.close();
      if (httpServer?.listening) {
        await new Promise<void>((resolve, reject) => {
          httpServer!.close((error) => (error ? reject(error) : resolve()));
        });
      }
    }
  });
});
