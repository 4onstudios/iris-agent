import express from "express";
import http from "http";

const mockCreateCodingAgent = jest.fn();
const mockExecuteMcpToolByKey = jest.fn();
const mockListMcpServerTools = jest.fn();

jest.mock("../api/core/agent/index", () => ({
  createCodingAgent: (...args: unknown[]) => mockCreateCodingAgent(...args),
  createAgentRequestContext: jest.fn((enabledSkills?: string[]) => ({ enabledSkills })),
  getSkillsList: jest.fn(async () => []),
}));

jest.mock("../api/core/agent/tools/mcpTools", () => ({
  executeMcpToolByKey: (...args: unknown[]) => mockExecuteMcpToolByKey(...args),
  listMcpServerTools: (...args: unknown[]) => mockListMcpServerTools(...args),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const agentRouter = require("../api/agent").default;

type RunningServer = {
  server: http.Server;
  baseUrl: string;
};

const postJson = async (
  baseUrl: string,
  apiPath: string,
  payload: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> => {
  const url = new URL(`${baseUrl}${apiPath}`);
  const body = JSON.stringify(payload);

  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body).toString(),
          ...headers,
        },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => {
          let parsed: unknown = {};
          try {
            parsed = text ? JSON.parse(text) : {};
          } catch {
            parsed = {};
          }

          resolve({ status: res.statusCode || 0, body: parsed });
        });
      },
    );

    req.on("error", reject);
    req.write(body);
    req.end();
  });
};

const startServer = async (): Promise<RunningServer> => {
  const app = express();
  app.use(express.json());
  app.use("/api/agent", agentRouter);

  const server = await new Promise<http.Server>((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to start test server");
  }

  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
};

const stopServer = async (server: http.Server): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
};

describe("MCP chat gating", () => {
  const originalTauriBundled = process.env.TAURI_BUNDLED;
  const originalDesktopToken = process.env.IRIS_DESKTOP_TOKEN;

  beforeEach(() => {
    mockCreateCodingAgent.mockReset();
    mockExecuteMcpToolByKey.mockReset();
    mockListMcpServerTools.mockReset();
    mockCreateCodingAgent.mockResolvedValue({
      generate: jest.fn(async () => ({ text: "ok", steps: [], toolCalls: [] })),
    });
    mockListMcpServerTools.mockResolvedValue([]);
  });

  afterAll(() => {
    if (originalTauriBundled === undefined) {
      delete process.env.TAURI_BUNDLED;
    } else {
      process.env.TAURI_BUNDLED = originalTauriBundled;
    }

    if (originalDesktopToken === undefined) {
      delete process.env.IRIS_DESKTOP_TOKEN;
    } else {
      process.env.IRIS_DESKTOP_TOKEN = originalDesktopToken;
    }
  });

  it("does not forward mcpServers when request is not desktop", async () => {
    process.env.TAURI_BUNDLED = "1";
    const { server, baseUrl } = await startServer();

    try {
      const response = await postJson(baseUrl, "/api/agent/chat", {
        message: "hello",
        modelId: "gpt-4o",
        workspaceRoot: "/tmp/non-desktop-workspace",
        isTauri: false,
        mcpServers: [
          {
            id: "server-a",
            name: "A",
            command: "npx",
            args: ["-y", "server-a"],
            enabled: true,
          },
        ],
      });

      expect(response.status).toBe(200);
      expect(mockCreateCodingAgent).toHaveBeenCalled();
      expect(mockCreateCodingAgent.mock.calls[0][2]).toMatchObject({
        mcpServers: [],
      });
    } finally {
      await stopServer(server);
    }
  });

  it("does not forward mcpServers when desktop sidecar flag is missing", async () => {
    delete process.env.TAURI_BUNDLED;
    const { server, baseUrl } = await startServer();

    try {
      const response = await postJson(baseUrl, "/api/agent/chat", {
        message: "hello",
        modelId: "gpt-4o",
        workspaceRoot: "/tmp/desktop-no-sidecar",
        isTauri: true,
        mcpServers: [
          {
            id: "server-b",
            name: "B",
            command: "npx",
            args: ["-y", "server-b"],
            enabled: true,
          },
        ],
      });

      expect(response.status).toBe(200);
      expect(mockCreateCodingAgent).toHaveBeenCalled();
      expect(mockCreateCodingAgent.mock.calls[0][2]).toMatchObject({
        mcpServers: [],
      });
    } finally {
      await stopServer(server);
    }
  });

  it("does not forward mcpServers when desktop auth header is missing", async () => {
    process.env.TAURI_BUNDLED = "1";
    process.env.IRIS_DESKTOP_TOKEN = "desktop-secret";
    const { server, baseUrl } = await startServer();

    try {
      const response = await postJson(baseUrl, "/api/agent/chat", {
        message: "hello",
        modelId: "gpt-4o",
        workspaceRoot: "/tmp/desktop-spoofed",
        isTauri: true,
        mcpServers: [
          {
            id: "server-c",
            name: "C",
            command: "npx",
            args: ["-y", "server-c"],
            enabled: true,
          },
        ],
      });

      expect(response.status).toBe(200);
      expect(mockCreateCodingAgent).toHaveBeenCalled();
      expect(mockCreateCodingAgent.mock.calls[0][2]).toMatchObject({
        mcpServers: [],
      });
    } finally {
      await stopServer(server);
    }
  });

  it("forwards mcpServers only when desktop auth is valid", async () => {
    process.env.TAURI_BUNDLED = "1";
    process.env.IRIS_DESKTOP_TOKEN = "desktop-secret";
    const { server, baseUrl } = await startServer();

    try {
      const response = await postJson(
        baseUrl,
        "/api/agent/chat",
        {
          message: "hello",
          modelId: "gpt-4o",
          workspaceRoot: "/tmp/desktop-authorized",
          isTauri: true,
          mcpServers: [
            {
              id: "server-d",
              name: "D",
              command: "npx",
              args: ["-y", "server-d"],
              enabled: true,
            },
          ],
        },
        { "x-desktop-token": "desktop-secret" },
      );

      expect(response.status).toBe(200);
      expect(mockCreateCodingAgent).toHaveBeenCalled();
      expect(mockCreateCodingAgent.mock.calls[0][2]).toMatchObject({
        mcpServers: [
          {
            id: "server-d",
            name: "D",
            command: "npx",
            args: ["-y", "server-d"],
            enabled: true,
          },
        ],
      });
    } finally {
      await stopServer(server);
    }
  });

  it("reuses the cached agent for identical authenticated MCP chat requests", async () => {
    process.env.TAURI_BUNDLED = "1";
    process.env.IRIS_DESKTOP_TOKEN = "desktop-secret";
    const { server, baseUrl } = await startServer();

    try {
      const payload = {
        message: "hello",
        modelId: "gpt-4o",
        workspaceRoot: "/tmp/desktop-authorized",
        isTauri: true,
        mcpServers: [
          {
            id: "server-d",
            name: "Blender",
            command: "npx",
            args: ["-y", "blender-mcp"],
            enabled: true,
          },
        ],
      };

      const first = await postJson(
        baseUrl,
        "/api/agent/chat",
        payload,
        { "x-desktop-token": "desktop-secret" },
      );
      const second = await postJson(
        baseUrl,
        "/api/agent/chat",
        payload,
        { "x-desktop-token": "desktop-secret" },
      );

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(mockCreateCodingAgent).toHaveBeenCalledTimes(1);
    } finally {
      await stopServer(server);
    }
  });

  it("inspects authenticated MCP servers during chat requests", async () => {
    process.env.TAURI_BUNDLED = "1";
    process.env.IRIS_DESKTOP_TOKEN = "desktop-secret";
    mockListMcpServerTools.mockResolvedValue([
      { name: "create_tree", description: "Create a tree" },
      { name: "create_scene", description: "Create a scene" },
    ]);
    const { server, baseUrl } = await startServer();

    try {
      const response = await postJson(
        baseUrl,
        "/api/agent/chat",
        {
          message: "what tools are available on blender",
          modelId: "gpt-4o",
          workspaceRoot: "/tmp/desktop-authorized",
          isTauri: true,
          mcpServers: [
            {
              id: "server-d",
              name: "Blender",
              command: "npx",
              args: ["-y", "blender-mcp"],
              enabled: true,
            },
          ],
        },
        { "x-desktop-token": "desktop-secret" },
      );

      expect(response.status).toBe(200);
      expect(mockListMcpServerTools).toHaveBeenCalledWith(
        {
          id: "server-d",
          name: "Blender",
          command: "npx",
          args: ["-y", "blender-mcp"],
          env: {},
          enabled: true,
        },
        "/tmp/desktop-authorized",
      );
    } finally {
      await stopServer(server);
    }
  });

  it("executes mcp tool calls through the desktop-authenticated backend endpoint", async () => {
    process.env.TAURI_BUNDLED = "1";
    process.env.IRIS_DESKTOP_TOKEN = "desktop-secret";
    mockExecuteMcpToolByKey.mockResolvedValue({
      success: true,
      server: "Blender",
      tool: "create_tree",
      content: [{ type: "text", text: "ok" }],
    });
    const { server, baseUrl } = await startServer();

    try {
      const response = await postJson(
        baseUrl,
        "/api/agent/mcp/call",
        {
          toolName: "mcp_Blender_create_tree",
          args: { command_type: "create_tree" },
          workspaceRoot: "/tmp/desktop-authorized",
          mcpServers: [
            {
              id: "server-d",
              name: "Blender",
              command: "npx",
              args: ["-y", "blender-mcp"],
              enabled: true,
            },
          ],
        },
        { "x-desktop-token": "desktop-secret" },
      );

      expect(response.status).toBe(200);
      expect(mockExecuteMcpToolByKey).toHaveBeenCalledWith(
        [
          {
            id: "server-d",
            name: "Blender",
            command: "npx",
            args: ["-y", "blender-mcp"],
            env: {},
            enabled: true,
          },
        ],
        "/tmp/desktop-authorized",
        "mcp_Blender_create_tree",
        { command_type: "create_tree" },
      );
      expect(response.body).toMatchObject({
        success: true,
        server: "Blender",
        tool: "create_tree",
      });
    } finally {
      await stopServer(server);
    }
  });
});
