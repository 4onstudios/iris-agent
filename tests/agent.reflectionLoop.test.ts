import express from "express";
import http from "http";

const mockCreateCodingAgent = jest.fn();
const mockGenerate = jest.fn();
const mockSetObjective = jest.fn();
const mockCreateAgentRequestContext = jest.fn(
  (enabledSkills?: string[], requestValues?: Record<string, unknown>) => ({
    enabledSkills,
    ...requestValues,
  }),
);

jest.mock("../api/core/agent/index", () => ({
  createCodingAgent: (...args: unknown[]) => mockCreateCodingAgent(...args),
  createAgentRequestContext: (...args: Parameters<typeof mockCreateAgentRequestContext>) =>
    mockCreateAgentRequestContext(...args),
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

describe("agent bounded reflection loop", () => {
  const prevReflectionMax = process.env.IRIS_AGENT_REFLECTION_MAX;

  beforeEach(() => {
    process.env.IRIS_AGENT_REFLECTION_MAX = "2";
    mockGenerate.mockReset();
    mockSetObjective.mockReset();
    mockCreateCodingAgent.mockReset();
    mockCreateAgentRequestContext.mockClear();

    mockGenerate
      .mockResolvedValueOnce({
        text: "initial response",
        steps: [
          {
            content: [
              {
                type: "tool-result",
                toolName: "writeFile",
                result: {
                  success: true,
                  validation: {
                    lint: {
                      enabled: true,
                      success: false,
                      error: "lint failed",
                    },
                  },
                },
              },
            ],
            toolCalls: [],
          },
        ],
        toolCalls: [],
      })
      .mockResolvedValueOnce({
        text: "repair response",
        steps: [],
        toolCalls: [],
      });

    mockCreateCodingAgent.mockResolvedValue({
      generate: mockGenerate,
      setObjective: mockSetObjective,
    });
  });

  afterAll(() => {
    if (prevReflectionMax === undefined) {
      delete process.env.IRIS_AGENT_REFLECTION_MAX;
    } else {
      process.env.IRIS_AGENT_REFLECTION_MAX = prevReflectionMax;
    }
  });

  it("runs a targeted repair pass after validation failure", async () => {
    const { server, baseUrl } = await startServer();

    try {
      const response = await postJson(baseUrl, "/api/agent/chat", {
        message: "please update file",
        modelId: "gpt-4o",
        workspaceRoot: "/tmp/reflection-loop",
        isTauri: false,
      });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.response).toBe("repair response");
      expect(typeof response.body.runId).toBe("string");
      expect(response.body.lifecycleState).toBe("succeeded");
      expect(response.body.stopReason).toBe("completed");
      expect(response.body.autoFixAttempted).toBe(true);
      expect(response.body.autoFixFailureCount).toBe(1);
      expect(mockGenerate).toHaveBeenCalledTimes(2);
      const initialOptions = mockGenerate.mock.calls[0][1];
      const reflectionOptions = mockGenerate.mock.calls[1][1];
      expect(reflectionOptions.requestContext).toBe(initialOptions.requestContext);
      expect(reflectionOptions.stopWhen).toBe(initialOptions.stopWhen);
      expect(mockSetObjective).toHaveBeenCalledWith(
        "please update file",
        expect.objectContaining({ maxRuns: 12 }),
      );
    } finally {
      await stopServer(server);
    }
  });

  it("redacts secret-bearing mutation args from auto-fix results", async () => {
    const oldSecret = "sk-abcdefghijklmnopqrstuvwxyz123456";
    const newSecret = "sk-zyxwvutsrqponmlkjihgfedcba654321";
    mockGenerate.mockReset();
    mockGenerate
      .mockResolvedValueOnce({
        text: "initial response",
        steps: [
          {
            content: [
              {
                type: "tool-result",
                toolName: "writeFile",
                result: {
                  success: true,
                  validation: {
                    lint: { enabled: true, success: false, error: "lint failed" },
                  },
                },
              },
            ],
            toolCalls: [],
          },
        ],
        toolCalls: [],
      })
      .mockResolvedValueOnce({
        text: "repair response",
        steps: [
          {
            content: [
              {
                type: "tool-call",
                toolName: "editFile",
                toolCallId: "repair_edit",
                args: {
                  filePath: "src/config.ts",
                  oldContent: oldSecret,
                  newContent: newSecret,
                },
              },
              {
                type: "tool-result",
                toolName: "editFile",
                toolCallId: "repair_edit",
                result: { success: true },
              },
            ],
            toolCalls: [{ toolName: "editFile" }],
          },
        ],
        toolCalls: [],
      });

    const { server, baseUrl } = await startServer();

    try {
      const response = await postJson(baseUrl, "/api/agent/chat", {
        message: "please update file",
        modelId: "gpt-4o",
        workspaceRoot: "/tmp/reflection-redaction",
        isTauri: false,
      });

      expect(response.status).toBe(200);
      const serialized = JSON.stringify(response.body);
      expect(serialized).not.toContain(oldSecret);
      expect(serialized).not.toContain(newSecret);
      expect(serialized).toContain("[REDACTED:openai_key]");
      expect(response.body.executedToolResults).toEqual([
        expect.objectContaining({
          name: "editFile",
          args: expect.objectContaining({ filePath: "src/config.ts" }),
          result: { success: true },
        }),
      ]);
    } finally {
      await stopServer(server);
    }
  });

  it("preserves equal anonymous terminal auto-fix results from different steps", async () => {
    mockGenerate.mockReset();
    const repairResult = { status: "completed", content: "same" };
    mockGenerate
      .mockResolvedValueOnce({
        text: "initial response",
        steps: [
          {
            content: [
              {
                type: "tool-result",
                toolName: "writeFile",
                result: {
                  success: true,
                  validation: {
                    lint: { enabled: true, success: false, error: "lint failed" },
                  },
                },
              },
            ],
            toolCalls: [],
          },
        ],
        toolCalls: [],
      })
      .mockResolvedValueOnce({
        text: "repair response",
        steps: [
          {
            content: [
              {
                type: "tool-call",
                toolName: "readFile",
                args: { filePath: "src/index.ts" },
              },
              {
                type: "tool-result",
                toolName: "readFile",
                args: { filePath: "src/index.ts" },
                result: repairResult,
              },
            ],
            toolCalls: [],
          },
          {
            content: [
              {
                type: "tool-call",
                toolName: "readFile",
                args: { filePath: "src/index.ts" },
              },
              {
                type: "tool-result",
                toolName: "readFile",
                args: { filePath: "src/index.ts" },
                result: repairResult,
              },
            ],
            toolCalls: [],
          },
        ],
        toolCalls: [],
      });

    const { server, baseUrl } = await startServer();

    try {
      const response = await postJson(baseUrl, "/api/agent/chat", {
        message: "please update file",
        modelId: "gpt-4o",
        workspaceRoot: "/tmp/reflection-equal-results",
        isTauri: false,
      });

      expect(response.status).toBe(200);
      expect(response.body.response).toBe("repair response");
      expect(response.body.autoFixAttempted).toBe(true);
      expect(response.body.executedToolResults).toEqual([
        expect.objectContaining({
          name: "readFile",
          args: { filePath: "src/index.ts" },
          result: repairResult,
        }),
        expect.objectContaining({
          name: "readFile",
          args: { filePath: "src/index.ts" },
          result: repairResult,
        }),
      ]);
    } finally {
      await stopServer(server);
    }
  });

  it("does not start reflection after the shared tool budget is exhausted", async () => {
    mockGenerate.mockReset();
    mockGenerate.mockImplementationOnce(async (_prompt, options) => {
      options.requestContext.toolCallBudget.admitted = 1;
      return {
        text: "initial failed mutation",
        steps: [
          {
            toolCalls: [{ toolName: "writeFile" }],
            content: [
              {
                type: "tool-result",
                toolName: "writeFile",
                result: {
                  success: true,
                  validation: {
                    lint: { enabled: true, success: false, error: "lint failed" },
                  },
                },
              },
            ],
          },
        ],
        toolCalls: [],
      };
    });

    const { server, baseUrl } = await startServer();

    try {
      const response = await postJson(baseUrl, "/api/agent/chat", {
        message: "please update file",
        modelId: "gpt-4o",
        workspaceRoot: "/tmp/reflection-budget-exhausted",
        isTauri: false,
        maxSteps: 1,
      });

      expect(response.status).toBe(200);
      expect(mockGenerate).toHaveBeenCalledTimes(1);
      expect(response.body.autoFixAttempted).toBe(false);
      expect(response.body.toolCallsUsed).toBe(1);
      expect(response.body.maxStepsReached).toBe(true);
    } finally {
      await stopServer(server);
    }
  });

  it("counts same-signature calls from step content separately by tool call ID", async () => {
    mockGenerate.mockReset();
    mockGenerate.mockResolvedValueOnce({
      text: "read both snapshots",
      steps: [
        {
          content: [
            {
              type: "tool-call",
              toolName: "readFile",
              toolCallId: "read-1",
              input: { filePath: "src/index.ts" },
            },
            {
              type: "tool-result",
              toolName: "readFile",
              toolCallId: "read-1",
              result: { status: "completed", content: "first" },
            },
          ],
        },
        {
          content: [
            {
              type: "tool-call",
              toolName: "readFile",
              toolCallId: "read-2",
              input: { filePath: "src/index.ts" },
            },
            {
              type: "tool-result",
              toolName: "readFile",
              toolCallId: "read-2",
              result: { status: "completed", content: "second" },
            },
          ],
        },
      ],
      toolCalls: [],
    });

    const { server, baseUrl } = await startServer();

    try {
      const response = await postJson(baseUrl, "/api/agent/chat", {
        message: "read the file twice",
        modelId: "gpt-4o",
        workspaceRoot: "/tmp/repeated-tool-budget",
        isTauri: false,
        maxSteps: 2,
      });

      expect(response.status).toBe(200);
      expect(response.body.toolCallsUsed).toBe(2);
      expect(response.body.maxStepsReached).toBe(true);
      expect(response.body.executedToolResults).toEqual([
        expect.objectContaining({ toolCallId: "read-1" }),
        expect.objectContaining({ toolCallId: "read-2" }),
      ]);
    } finally {
      await stopServer(server);
    }
  });

  it("does not attempt reflection when a step-content-only tool result already consumes the entire tool budget", async () => {
    mockGenerate.mockReset();
    mockGenerate.mockResolvedValueOnce({
      text: "initial response",
      steps: [
        {
          content: [
            {
              type: "tool-call",
              toolName: "writeFile",
              toolCallId: "write-1",
              input: { filePath: "src/index.ts", content: "hello" },
            },
            {
              type: "tool-result",
              toolName: "writeFile",
              toolCallId: "write-1",
              result: {
                success: true,
                validation: {
                  lint: { enabled: true, success: false, error: "lint failed" },
                },
              },
            },
          ],
        },
      ],
      toolCalls: [],
    });

    const { server, baseUrl } = await startServer();

    try {
      const response = await postJson(baseUrl, "/api/agent/chat", {
        message: "please update file",
        modelId: "gpt-4o",
        workspaceRoot: "/tmp/reflection-budget-step-content",
        isTauri: false,
        maxSteps: 1,
      });

      expect(response.status).toBe(200);
      expect(mockGenerate).toHaveBeenCalledTimes(1);
      expect(response.body.autoFixAttempted).toBe(false);
      expect(response.body.toolCallsUsed).toBe(1);
      expect(response.body.maxStepsReached).toBe(true);
    } finally {
      await stopServer(server);
    }
  });

  it("accepts structured toolResults continuation without requiring message text", async () => {
    mockGenerate.mockReset();
    mockGenerate.mockResolvedValueOnce({
      text: "continued from tool results",
      steps: [],
      toolCalls: [],
    });

    const { server, baseUrl } = await startServer();

    try {
      const response = await postJson(baseUrl, "/api/agent/chat", {
        message: "",
        conversationHistory: [],
        toolResults: [
          {
            tool: "runTerminalCommand",
            args: { command: "echo approved" },
            result: { success: true, output: "approved", exitCode: 0 },
            status: "completed",
          },
        ],
        modelId: "gpt-4o",
        workspaceRoot: "/tmp/reflection-loop",
        isTauri: false,
      });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.response).toBe("continued from tool results");
      expect(mockGenerate).toHaveBeenCalledTimes(1);

      const [promptArg] = mockGenerate.mock.calls[0] as [string, Record<string, unknown>];
      expect(promptArg).toContain("Tool execution results:");
      expect(promptArg).toContain("runTerminalCommand");
      expect(promptArg).toContain("approved");
    } finally {
      await stopServer(server);
    }
  });

  it("stops reflection early when failure signature repeats", async () => {
    process.env.IRIS_AGENT_REFLECTION_MAX = "3";
    delete process.env.IRIS_AGENT_REFLECTION_NO_PROGRESS_REPEATS;

    mockGenerate.mockReset();
    mockGenerate
      .mockResolvedValueOnce({
        text: "initial response",
        steps: [
          {
            content: [
              {
                type: "tool-result",
                toolName: "writeFile",
                result: {
                  success: true,
                  validation: {
                    lint: {
                      enabled: true,
                      success: false,
                      error: "lint failed",
                    },
                  },
                },
              },
            ],
            toolCalls: [],
          },
        ],
        toolCalls: [],
      })
      .mockResolvedValueOnce({
        text: "repair response",
        steps: [
          {
            content: [
              {
                type: "tool-result",
                toolName: "writeFile",
                result: {
                  success: true,
                  validation: {
                    lint: {
                      enabled: true,
                      success: false,
                      error: "lint failed",
                    },
                  },
                },
              },
            ],
            toolCalls: [],
          },
        ],
        toolCalls: [],
      });

    const { server, baseUrl } = await startServer();

    try {
      const response = await postJson(baseUrl, "/api/agent/chat", {
        message: "please update file",
        modelId: "gpt-4o",
        workspaceRoot: "/tmp/reflection-loop",
        isTauri: false,
      });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.autoFixAttempted).toBe(true);
      expect(response.body.reflectionStopReason).toBe("no_progress");
      expect(response.body.stopReason).toBe("no_progress");
      expect(mockGenerate).toHaveBeenCalledTimes(2);
    } finally {
      await stopServer(server);
    }
  });
});
