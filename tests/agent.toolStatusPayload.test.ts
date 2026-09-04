import express from "express";
import http from "http";

const mockCreateCodingAgent = jest.fn();

jest.mock("../api/core/agent/index", () => ({
  createCodingAgent: (...args: unknown[]) => mockCreateCodingAgent(...args),
  createAgentRequestContext: jest.fn((enabledSkills?: string[]) => ({ enabledSkills })),
  getSkillsList: jest.fn(async () => []),
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

describe("agent tool status payload", () => {
  beforeEach(() => {
    mockCreateCodingAgent.mockReset();
    mockCreateCodingAgent.mockResolvedValue({
      generate: jest.fn(async () => ({
        text: "done",
        steps: [
          {
            content: [
              {
                type: "tool-call",
                toolName: "readFile",
                toolCallId: "call-1",
                args: { filePath: "src/a.ts" },
              },
              {
                type: "tool-result",
                toolName: "readFile",
                toolCallId: "call-1",
                result: { success: true, content: "ok" },
              },
              {
                type: "tool-call",
                toolName: "grepSearch",
                toolCallId: "call-2",
                args: { searchText: "foo" },
              },
            ],
            toolCalls: [],
          },
        ],
        toolCalls: [],
      })),
    });
  });

  it("returns explicit status fields for toolCalls and executedToolResults", async () => {
    const { server, baseUrl } = await startServer();

    try {
      const response = await postJson(baseUrl, "/api/agent/chat", {
        message: "hello",
        modelId: "gpt-4o",
        workspaceRoot: "/tmp/status-payload",
        isTauri: false,
      });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);

      expect(response.body.toolCalls).toHaveLength(1);
      expect(response.body.toolCalls[0]).toMatchObject({
        name: "grepSearch",
        status: "pending",
      });

      expect(response.body.executedToolResults).toHaveLength(1);
      expect(response.body.executedToolResults[0]).toMatchObject({
        name: "readFile",
        status: "completed",
      });
    } finally {
      await stopServer(server);
    }
  });
});
