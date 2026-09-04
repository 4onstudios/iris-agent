import express from "express";
import http from "http";

const mockCreateCodingAgent = jest.fn();
const mockExecuteCommand = jest.fn();

jest.mock("../api/core/agent/index", () => ({
  createCodingAgent: (...args: unknown[]) => mockCreateCodingAgent(...args),
  createAgentRequestContext: jest.fn((enabledSkills?: string[]) => ({ enabledSkills })),
  getSkillsList: jest.fn(async () => []),
}));

jest.mock("../api/core/agent/tools/executeCommand", () => ({
  executeCommand: (...args: unknown[]) => mockExecuteCommand(...args),
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
  extraHeaders: Record<string, string> = {},
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
          ...extraHeaders,
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

const getJson = async (
  baseUrl: string,
  apiPath: string,
): Promise<{ status: number; body: any }> => {
  const url = new URL(`${baseUrl}${apiPath}`);

  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: "GET",
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

describe("agent slash command execution", () => {
  const originalEnv = { ...process.env };

  afterAll(() => {
    process.env = originalEnv;
  });

  beforeEach(() => {
    mockCreateCodingAgent.mockReset();
    mockExecuteCommand.mockReset();
    process.env.IRIS_ENABLE_SLASH_COMMANDS = "true";
    process.env.TAURI_BUNDLED = "1";
    process.env.IRIS_DESKTOP_TOKEN = "test-token";
  });

  it("returns command confirmation payload for /command input without invoking LLM agent", async () => {
    mockExecuteCommand.mockResolvedValue({
      status: "pending_confirmation",
      confirmationId: "confirm-123",
      command: "pwd",
    });

    const { server, baseUrl } = await startServer();

    try {
      const response = await postJson(baseUrl, "/api/agent/chat", {
        message: "/pwd",
        modelId: "gpt-4o",
        workspaceRoot: process.cwd(),
        isTauri: true,
      }, {
        "x-desktop-token": "test-token",
      });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.requiresConfirmation).toBe(true);
      expect(response.body.pendingConfirmations).toHaveLength(1);
      expect(response.body.pendingConfirmations[0]).toMatchObject({
        toolName: "executeCommand",
      });
      expect(response.body.pendingConfirmations[0].toolArgs).toMatchObject({
        command: "pwd",
      });
      expect(response.body.pendingConfirmations[0].toolArgs).not.toHaveProperty(
        "workspaceRoot",
      );
      expect(mockExecuteCommand).toHaveBeenCalled();
      expect(mockCreateCodingAgent).not.toHaveBeenCalled();
    } finally {
      await stopServer(server);
    }
  });

  it("returns slash command descriptors for client discovery", async () => {
    const { server, baseUrl } = await startServer();

    try {
      const response = await getJson(
        baseUrl,
        "/api/agent/slash-commands?enableSlashCommands=true",
      );

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.enabled).toBe(true);
      expect(response.body.commands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "help",
            kind: "builtin",
          }),
          expect.objectContaining({
            name: "compact",
            kind: "builtin",
          }),
          expect.objectContaining({
            name: "run",
            kind: "shell",
            aliases: ["sh", "shell"],
          }),
        ]),
      );
    } finally {
      await stopServer(server);
    }
  });

  it("returns no slash command descriptors when env feature flag disables them", async () => {
    process.env.IRIS_ENABLE_SLASH_COMMANDS = "false";

    const { server, baseUrl } = await startServer();

    try {
      const response = await getJson(
        baseUrl,
        "/api/agent/slash-commands?enableSlashCommands=true",
      );

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.enabled).toBe(false);
      expect(response.body.commands).toEqual([]);
    } finally {
      await stopServer(server);
    }
  });

  it("returns a successful slash-command response when executeCommand succeeds", async () => {
    mockExecuteCommand.mockResolvedValue({
      success: true,
      status: "completed",
      stdout: "ok-output",
      stderr: "",
    });

    const { server, baseUrl } = await startServer();

    try {
      const response = await postJson(baseUrl, "/api/agent/chat", {
        message: "/echo hi",
        modelId: "gpt-4o",
        workspaceRoot: process.cwd(),
        isTauri: true,
      }, {
        "x-desktop-token": "test-token",
      });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.response).toBe("ok-output");
      expect(response.body.error).toBeUndefined();
      expect(mockCreateCodingAgent).not.toHaveBeenCalled();
    } finally {
      await stopServer(server);
    }
  });

  it("returns slash command help without invoking shell execution", async () => {
    const { server, baseUrl } = await startServer();

    try {
      const response = await postJson(baseUrl, "/api/agent/chat", {
        message: "/help",
        modelId: "gpt-4o",
        workspaceRoot: process.cwd(),
        isTauri: true,
      }, {
        "x-desktop-token": "test-token",
      });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.response).toContain("Available slash commands:");
      expect(response.body.response).toContain("/compact");
      expect(response.body.toolCalls).toEqual([]);
      expect(response.body.executedToolResults).toEqual([]);
      expect(mockExecuteCommand).not.toHaveBeenCalled();
      expect(mockCreateCodingAgent).not.toHaveBeenCalled();
    } finally {
      await stopServer(server);
    }
  });

  it("returns compact digest for /compact without invoking shell execution", async () => {
    const { server, baseUrl } = await startServer();

    try {
      const response = await postJson(baseUrl, "/api/agent/chat", {
        message: "/compact",
        modelId: "gpt-4o",
        workspaceRoot: process.cwd(),
        isTauri: true,
        conversationHistory: [
          { role: "user", content: "Please inspect slash command behavior" },
          { role: "assistant", content: "I checked parser and execution path" },
          { role: "user", content: "Summarize key differences" },
        ],
        contextSummary: [
          { id: "ctx-1", preview: "api/agent.ts slash routing block" },
        ],
      }, {
        "x-desktop-token": "test-token",
      });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.response).toContain("Conversation compact digest:");
      expect(response.body.response).toContain("Recent user intents");
      expect(response.body.toolCalls).toEqual([]);
      expect(response.body.executedToolResults).toEqual([]);
      expect(mockExecuteCommand).not.toHaveBeenCalled();
      expect(mockCreateCodingAgent).not.toHaveBeenCalled();
    } finally {
      await stopServer(server);
    }
  });

  it("supports /run alias and executes only the provided shell payload", async () => {
    mockExecuteCommand.mockResolvedValue({
      success: true,
      status: "completed",
      stdout: "alias-ok",
      stderr: "",
    });

    const { server, baseUrl } = await startServer();

    try {
      const response = await postJson(baseUrl, "/api/agent/chat", {
        message: "/run echo hello",
        modelId: "gpt-4o",
        workspaceRoot: process.cwd(),
        isTauri: true,
      }, {
        "x-desktop-token": "test-token",
      });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.response).toBe("alias-ok");
      expect(mockExecuteCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "echo hello",
        }),
      );
      expect(mockCreateCodingAgent).not.toHaveBeenCalled();
    } finally {
      await stopServer(server);
    }
  });

  it("returns success=false and error for a failed slash command", async () => {
    mockExecuteCommand.mockResolvedValue({
      success: false,
      status: "failed",
      error: "blocked for safety reasons",
      stderr: "blocked for safety reasons",
    });

    const { server, baseUrl } = await startServer();

    try {
      const response = await postJson(baseUrl, "/api/agent/chat", {
        message: "/rm -rf /",
        modelId: "gpt-4o",
        workspaceRoot: process.cwd(),
        isTauri: true,
      }, {
        "x-desktop-token": "test-token",
      });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(false);
      expect(response.body.requiresConfirmation).not.toBe(true);
      expect(typeof response.body.error).toBe("string");
      expect(response.body.error).toContain("blocked for safety reasons");
      expect(mockCreateCodingAgent).not.toHaveBeenCalled();
    } finally {
      await stopServer(server);
    }
  });

  it("fails fast when pending confirmation result misses confirmationId", async () => {
    mockExecuteCommand.mockResolvedValue({
      status: "pending_confirmation",
      command: "pwd",
    });

    const { server, baseUrl } = await startServer();

    try {
      const response = await postJson(baseUrl, "/api/agent/chat", {
        message: "/pwd",
        modelId: "gpt-4o",
        workspaceRoot: process.cwd(),
        isTauri: true,
      }, {
        "x-desktop-token": "test-token",
      });

      expect(response.status).toBe(500);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain("confirmationId");
      expect(mockCreateCodingAgent).not.toHaveBeenCalled();
    } finally {
      await stopServer(server);
    }
  });

  it("returns explicit in-progress response with taskId for background slash command results", async () => {
    mockExecuteCommand.mockResolvedValue({
      status: "in_progress",
      taskId: "task-123",
      message: "Started background task task-123",
    });

    const { server, baseUrl } = await startServer();

    try {
      const response = await postJson(baseUrl, "/api/agent/chat", {
        message: "/npm run dev",
        modelId: "gpt-4o",
        workspaceRoot: process.cwd(),
        isTauri: true,
      }, {
        "x-desktop-token": "test-token",
      });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(false);
      expect(response.body.status).toBe("in_progress");
      expect(response.body.taskId).toBe("task-123");
      expect(response.body.response).toContain("still running");
      expect(mockCreateCodingAgent).not.toHaveBeenCalled();
    } finally {
      await stopServer(server);
    }
  });

  it("blocks slash command execution when trusted gating is not satisfied", async () => {
    const { server, baseUrl } = await startServer();

    try {
      const response = await postJson(baseUrl, "/api/agent/chat", {
        message: "/pwd",
        modelId: "gpt-4o",
        workspaceRoot: process.cwd(),
        isTauri: false,
      });

      expect(response.status).toBe(403);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain("disabled or not allowed");
      expect(mockExecuteCommand).not.toHaveBeenCalled();
      expect(mockCreateCodingAgent).not.toHaveBeenCalled();
    } finally {
      await stopServer(server);
    }
  });

  it("rejects non-default approval mode hints in Tauri mode", async () => {
    const { server, baseUrl } = await startServer();

    try {
      const response = await postJson(baseUrl, "/api/agent/chat", {
        message: "hello",
        modelId: "gpt-4o",
        workspaceRoot: process.cwd(),
        isTauri: true,
        approvalMode: "Bypass Approvals",
      }, {
        "x-desktop-token": "test-token",
      });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain("Invalid approval mode for Tauri");
      expect(response.body.toolCalls).toEqual([]);
      expect(response.body.executedToolResults).toEqual([]);
      expect(mockExecuteCommand).not.toHaveBeenCalled();
      expect(mockCreateCodingAgent).not.toHaveBeenCalled();
    } finally {
      await stopServer(server);
    }
  });
});
