import express from "express";
import http from "http";

jest.mock("../api/core/agent/index", () => ({
  createCodingAgent: jest.fn(),
  createAgentRequestContext: jest.fn((enabledSkills?: string[]) => ({ enabledSkills })),
  getSkillsList: jest.fn(() => []),
}));

const { createCodingAgent } = require("../api/core/agent/index") as {
  createCodingAgent: jest.Mock;
};

// Load router after mocks are registered.
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
  headers: Record<string, string>,
): Promise<{ status: number; body: unknown }> => {
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
        let responseText = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          responseText += chunk;
        });
        res.on("end", () => {
          let parsed: unknown = responseText;
          try {
            parsed = responseText ? JSON.parse(responseText) : {};
          } catch {
            // Leave raw text when response is not JSON.
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

describe("desktop auth for mutable agent endpoints", () => {
  const originalTauriBundled = process.env.TAURI_BUNDLED;
  const originalDesktopToken = process.env.IRIS_DESKTOP_TOKEN;
  const originalOpenrouterKey = process.env.OPENROUTER_API_KEY;

  beforeEach(() => {
    createCodingAgent.mockReset();
    process.env.TAURI_BUNDLED = "1";
    process.env.IRIS_DESKTOP_TOKEN = "desktop-secret";
    delete process.env.OPENROUTER_API_KEY;
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

    if (originalOpenrouterKey === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = originalOpenrouterKey;
    }
  });

  it("returns 403 when token is missing for write-file and delete-file", async () => {
    const { server, baseUrl } = await startServer();

    try {
      const writeRes = await postJson(
        baseUrl,
        "/api/agent/write-file",
        { filePath: "src/a.ts", content: "x" },
        {},
      );

      const deleteRes = await postJson(
        baseUrl,
        "/api/agent/delete-file",
        { filePath: "src/a.ts" },
        {},
      );

      expect(writeRes.status).toBe(403);
      expect(deleteRes.status).toBe(403);
    } finally {
      await stopServer(server);
    }
  });

  it("returns 403 when token is invalid for write-file and delete-file", async () => {
    const { server, baseUrl } = await startServer();

    try {
      const badHeaders = {
        "X-Desktop-Token": "wrong-secret",
      };

      const writeRes = await postJson(
        baseUrl,
        "/api/agent/write-file",
        { filePath: "src/a.ts", content: "x" },
        badHeaders,
      );

      const deleteRes = await postJson(
        baseUrl,
        "/api/agent/delete-file",
        { filePath: "src/a.ts" },
        badHeaders,
      );

      expect(writeRes.status).toBe(403);
      expect(deleteRes.status).toBe(403);
    } finally {
      await stopServer(server);
    }
  });

  it("syncs OpenRouter key via /api/agent/keys", async () => {
    const { server, baseUrl } = await startServer();

    try {
      const headers = {
        "X-Desktop-Token": "desktop-secret",
      };

      const res = await postJson(
        baseUrl,
        "/api/agent/keys",
        {
          keys: {
            OPENROUTER_API_KEY: "or-key-123",
          },
        },
        headers,
      );

      expect(res.status).toBe(200);
      expect(process.env.OPENROUTER_API_KEY).toBe("or-key-123");
    } finally {
      await stopServer(server);
    }
  });

  it("trims OpenRouter key values before storing them in process.env", async () => {
    const { server, baseUrl } = await startServer();

    try {
      const headers = {
        "X-Desktop-Token": "desktop-secret",
      };

      const res = await postJson(
        baseUrl,
        "/api/agent/keys",
        {
          keys: {
            OPENROUTER_API_KEY: "  or-key-123\n",
          },
        },
        headers,
      );

      expect(res.status).toBe(200);
      expect(process.env.OPENROUTER_API_KEY).toBe("or-key-123");
    } finally {
      await stopServer(server);
    }
  });

  it("syncs HuggingFace token via /api/agent/keys", async () => {
    const { server, baseUrl } = await startServer();

    try {
      const headers = {
        "X-Desktop-Token": "desktop-secret",
      };

      const res = await postJson(
        baseUrl,
        "/api/agent/keys",
        {
          keys: {
            HF_TOKEN: "hf_test_token_abc123",
          },
        },
        headers,
      );

      expect(res.status).toBe(200);
      expect(process.env.HF_TOKEN).toBe("hf_test_token_abc123");
    } finally {
      await stopServer(server);
      delete process.env.HF_TOKEN;
    }
  });

  it("rejects unknown keys and does not set HF_TOKEN when not in allowlist", async () => {
    const { server, baseUrl } = await startServer();

    try {
      const headers = {
        "X-Desktop-Token": "desktop-secret",
      };

      const originalHfToken = process.env.HF_TOKEN;
      delete process.env.HF_TOKEN;

      const res = await postJson(
        baseUrl,
        "/api/agent/keys",
        {
          keys: {
            UNKNOWN_SECRET_KEY: "should-be-ignored",
          },
        },
        headers,
      );

      expect(res.status).toBe(200);
      expect(process.env.UNKNOWN_SECRET_KEY).toBeUndefined();

      if (originalHfToken !== undefined) {
        process.env.HF_TOKEN = originalHfToken;
      }
    } finally {
      await stopServer(server);
    }
  });

  it("surfaces OpenRouter provider auth failures as actionable key errors", async () => {
    const { server, baseUrl } = await startServer();

    createCodingAgent.mockResolvedValueOnce({
      generate: jest.fn(async () => {
        const error = new Error("User not found.");
        (error as Error & { data?: unknown }).data = {
          error: { code: "401", message: "User not found." },
        };
        throw error;
      }),
    });

    try {
      const response = await postJson(
        baseUrl,
        "/api/agent/chat",
        {
          message: "Reply with exactly: ok",
          conversationHistory: [],
          modelId: "openrouter/openai/gpt-5.3-codex",
          filesInContext: [],
          workspaceRoot: process.cwd(),
          workspaceStructure: null,
          isTauri: true,
          stream: false,
          enableSlashCommands: true,
          preferredAgentId: "iris",
          mcpServers: [],
        },
        {},
      );

      expect(response.status).toBe(500);
      expect(response.body).toEqual(
        expect.objectContaining({
          success: false,
          error:
            "OpenRouter rejected the configured API key. Replace OPENROUTER_API_KEY in Settings and click Save & Activate Keys.",
        }),
      );
    } finally {
      createCodingAgent.mockReset();
      await stopServer(server);
    }
  });

});
