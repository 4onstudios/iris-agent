import { createServer, type Server as HttpServer } from "node:http";
import { Server as LegacyMcpServer } from "@modelcontextprotocol/sdk-legacy/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk-legacy/server/sse.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk-legacy/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk-legacy/client/sse.js";
import type { McpServerConfig } from "../api/core/library/mcpSettings";
import { buildMcpTools, executeMcpToolByKey, listMcpServerTools } from "../api/core/agent/tools/mcpTools";
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

  it("discovers and invokes 2020-12 tools over legacy SSE with configured headers", async () => {
    const inputSchema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object" as const,
      properties: { name: { type: "string" } },
      required: ["name"],
      unevaluatedProperties: false,
    };
    const outputSchema = {
      ...inputSchema,
      properties: { greeting: { type: "string" } },
      required: ["greeting"],
    };
    let callCount = 0;
    let invalidOutput = false;
    const legacyServers = new Set<LegacyMcpServer>();
    const createLegacyServer = () => {
      const legacyServer = new LegacyMcpServer(
        { name: "legacy-test", version: "1.0.0" },
        { capabilities: { tools: {} } },
      );
      legacyServer.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [{ name: "hello", description: "Test tool", inputSchema, outputSchema }],
      }));
      legacyServer.setRequestHandler(CallToolRequestSchema, async (request) => {
        callCount += 1;
        const structuredContent = invalidOutput
          ? { greeting: 42 }
          : { greeting: `Hello ${request.params.arguments?.name}` };
        return { content: [{ type: "text", text: "hello" }], structuredContent };
      });
      legacyServers.add(legacyServer);
      return legacyServer;
    };

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
          await createLegacyServer().connect(transport);
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

      const config: McpServerConfig = {
        ...server,
        url: `http://127.0.0.1:${address.port}/sse`,
        transport: "sse",
      };
      const tools = await listMcpServerTools(config, process.cwd());

      expect(tools).toEqual([
        { name: "hello", description: "Test tool", inputSchema },
      ]);
      const key = "mcp_Remote_MCP_hello";
      await expect(executeMcpToolByKey([config], process.cwd(), key, { name: "REA" }))
        .resolves.toMatchObject({ success: true, structuredContent: { greeting: "Hello REA" } });
      await expect(executeMcpToolByKey([config], process.cwd(), key, { name: 42 }))
        .resolves.toMatchObject({ success: false, error: expect.stringContaining("/name") });
      expect(callCount).toBe(1);

      const registered = await buildMcpTools([config], process.cwd());
      const tool = registered[key];
      if (!tool || typeof tool !== "object" || !("execute" in tool) || typeof tool.execute !== "function") {
        throw new Error("Expected an executable MCP tool");
      }
      await expect(tool.execute({ name: "agent" })).resolves.toMatchObject({
        success: true,
        structuredContent: { greeting: "Hello agent" },
      });
      await expect(tool.execute({ name: 42 })).resolves.toMatchObject({
        error: true,
        message: expect.stringContaining("name: must be string"),
      });
      expect(callCount).toBe(2);

      invalidOutput = true;
      await expect(executeMcpToolByKey([config], process.cwd(), key, { name: "REA" }))
        .resolves.toMatchObject({ success: false, error: expect.stringContaining("greeting") });
    } finally {
      await Promise.all(Array.from(legacyServers, (server) => server.close()));
      if (httpServer?.listening) {
        await new Promise<void>((resolve, reject) => {
          httpServer!.close((error) => (error ? reject(error) : resolve()));
        });
      }
    }
  });

  it("uses current OAuth tokens for both legacy SSE requests", async () => {
    const legacyServer = new LegacyMcpServer(
      { name: "legacy-oauth-test", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    legacyServer.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: "hello", inputSchema: { type: "object" } }],
    }));

    class StatefulOAuthProvider implements OAuthClientProvider {
      private accessToken = "initial-token";
      clientMetadataReads = 0;
      redirectUrl = "http://127.0.0.1/callback";
      clientId = "legacy-oauth-test";

      get clientMetadata() {
        this.clientMetadataReads += 1;
        return { redirect_uris: [this.redirectUrl] };
      }

      clientInformation() {
        return { client_id: this.clientId };
      }

      tokens() {
        return {
          access_token: this.accessToken,
          token_type: "Bearer",
        };
      }

      saveTokens(tokens: Awaited<ReturnType<OAuthClientProvider["tokens"]>>) {
        if (!tokens) throw new Error("Expected OAuth tokens");
        this.accessToken = tokens.access_token;
      }

      redirectToAuthorization() {}
      saveCodeVerifier() {}
      codeVerifier() {
        return "test-verifier";
      }

      rotateAccessToken(accessToken: string) {
        this.accessToken = accessToken;
      }
    }

    const authProvider = new StatefulOAuthProvider();
    const transports = new Map<string, SSEServerTransport>();
    const authorizationHeaders: string[] = [];
    let httpServer: HttpServer | undefined;
    let client: Client | undefined;

    try {
      httpServer = createServer(async (request, response) => {
        authorizationHeaders.push(`${request.method}:${request.headers.authorization}`);
        if (
          request.headers.authorization !== "Bearer initial-token" &&
          request.headers.authorization !== "Bearer rotated-token"
        ) {
          response.writeHead(401).end();
          return;
        }

        const url = new URL(request.url || "/", "http://localhost");
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

      const transport = createMcpRemoteTransport(
        {
          ...server,
          url: `http://127.0.0.1:${address.port}/sse`,
          transport: "sse",
        },
        authProvider,
      );
      expect(authProvider.clientMetadataReads).toBe(0);
      client = new Client({ name: "legacy-oauth-test", version: "1.0.0" });
      await client.connect(transport);

      authProvider.rotateAccessToken("rotated-token");
      await expect(client.listTools()).resolves.toMatchObject({
        tools: [{ name: "hello" }],
      });
      expect(authorizationHeaders[0]).toBe("GET:Bearer initial-token");
      const postHeaders = authorizationHeaders.slice(1);
      expect(postHeaders).toContain("POST:Bearer initial-token");
      expect(postHeaders).toContain("POST:Bearer rotated-token");
      expect(
        postHeaders.every(
          (header) =>
            header === "POST:Bearer initial-token" ||
            header === "POST:Bearer rotated-token",
        ),
      ).toBe(true);
    } finally {
      if (client) await client.close();
      await legacyServer.close();
      if (httpServer?.listening) {
        await new Promise<void>((resolve, reject) => {
          httpServer!.close((error) => (error ? reject(error) : resolve()));
        });
      }
    }
  });
});
