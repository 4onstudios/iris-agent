import express from "express";
import http from "http";

const mockCreateCodingAgent = jest.fn();
const mockAgentStream = jest.fn();
const mockCreateAgentRequestContext = jest.fn(
  (enabledSkills?: string[], requestValues?: Record<string, unknown>) => ({
    enabledSkills,
    ...requestValues,
  }),
);

jest.mock("../api/core/agent/index", () => ({
  createCodingAgent: (...args: unknown[]) => mockCreateCodingAgent(...args),
  createAgentRequestContext: (
    ...args: Parameters<typeof mockCreateAgentRequestContext>
  ) => mockCreateAgentRequestContext(...args),
  getSkillsList: jest.fn(async () => []),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const agentRouter = require("../api/agent").default;

type RunningServer = {
  server: http.Server;
  baseUrl: string;
};

type StreamingResponse = {
  status: number;
  contentType: string;
  body: string;
};

type JsonResponse = {
  status: number;
  contentType: string;
  body: Record<string, unknown>;
};

const postStreaming = async (
  baseUrl: string,
  apiPath: string,
  payload: Record<string, unknown>,
): Promise<StreamingResponse> => {
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
          resolve({
            status: res.statusCode || 0,
            contentType: String(res.headers["content-type"] || ""),
            body: text,
          });
        });
      },
    );

    req.on("error", reject);
    req.write(body);
    req.end();
  });
};

const postJson = async (
  baseUrl: string,
  apiPath: string,
  payload: Record<string, unknown>,
): Promise<JsonResponse> => {
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
          let parsed: Record<string, unknown> = {};
          try {
            parsed = JSON.parse(text || "{}");
          } catch {
            parsed = {};
          }

          resolve({
            status: res.statusCode || 0,
            contentType: String(res.headers["content-type"] || ""),
            body: parsed,
          });
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

const createMockFullStream = (chunks: Array<Record<string, unknown>>) => {
  let index = 0;

  return {
    getReader() {
      return {
        async read() {
          if (index >= chunks.length) {
            return { value: undefined, done: true };
          }

          const value = chunks[index];
          index += 1;
          return { value, done: false };
        },
      };
    },
  };
};

describe("agent chat streaming", () => {
  beforeEach(() => {
    mockCreateCodingAgent.mockReset();
    mockAgentStream.mockReset();
    mockCreateAgentRequestContext.mockClear();

    mockAgentStream.mockResolvedValue({
      fullStream: createMockFullStream([
        {
          type: "reasoning-delta",
          payload: { text: "Plan first." },
        },
        {
          type: "text-delta",
          payload: { text: "Final answer part 1." },
        },
        {
          type: "text-delta",
          payload: { text: " Final answer part 2." },
        },
      ]),
      text: Promise.resolve("Final answer part 1. Final answer part 2."),
      toolCalls: Promise.resolve([]),
    });

    mockCreateCodingAgent.mockResolvedValue({
      generate: jest.fn(async () => ({
        text: "fallback",
        steps: [],
        toolCalls: [],
      })),
      stream: mockAgentStream,
    });
  });

  it("scopes writable Mastra task memory to the chat thread", async () => {
    const { server, baseUrl } = await startServer();

    try {
      const response = await postStreaming(baseUrl, "/api/agent/chat", {
        message: "hello",
        chatSessionId: "chat-session-memory",
        modelId: "gpt-4o-mini",
        workspaceRoot: "/tmp/stream-test-memory-scope",
        isTauri: false,
        useMastraObservationalMemory: true,
        stream: true,
      });

      expect(response.status).toBe(200);
      expect(mockAgentStream).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          memory: {
            thread: "chat-session-memory",
            resource: "iris-chat:chat-session-memory",
          },
        }),
      );
    } finally {
      await stopServer(server);
    }
  });

  it("streams thought and text deltas before done", async () => {
    const { server, baseUrl } = await startServer();

    try {
      const response = await postStreaming(baseUrl, "/api/agent/chat", {
        message: "hello",
        modelId: "gpt-4o-mini",
        workspaceRoot: "/tmp/stream-test-suspension",
        isTauri: false,
        stream: true,
      });

      expect(response.status).toBe(200);
      expect(response.contentType).toContain("text/event-stream");

      const thoughtIndex = response.body.indexOf("event: thought_delta");
      const textIndex = response.body.indexOf("event: text_delta");
      const doneIndex = response.body.indexOf("event: done");

      expect(thoughtIndex).toBeGreaterThanOrEqual(0);
      expect(textIndex).toBeGreaterThanOrEqual(0);
      expect(doneIndex).toBeGreaterThanOrEqual(0);
      expect(thoughtIndex).toBeLessThan(textIndex);
      expect(textIndex).toBeLessThan(doneIndex);

      expect(response.body).toContain("Plan first.");
      expect(response.body).toContain("Final answer part 1.");
      expect(response.body).toContain("Final answer part 2.");
    } finally {
      await stopServer(server);
    }
  }, 30000);

  it("disables tools for final synthesis continuations", async () => {
    const stream = jest.fn(async () => ({
      fullStream: createMockFullStream([
        {
          type: "text-delta",
          payload: { text: "Synthesized answer." },
        },
      ]),
      text: Promise.resolve("Synthesized answer."),
      toolCalls: Promise.resolve([]),
    }));
    mockCreateCodingAgent.mockResolvedValueOnce({
      generate: jest.fn(async () => ({
        text: "fallback",
        steps: [],
        toolCalls: [],
      })),
      stream,
    });

    const { server, baseUrl } = await startServer();

    try {
      const response = await postStreaming(baseUrl, "/api/agent/chat", {
        message: "Produce the final answer now using only the evidence above.",
        modelId: "gpt-4o-mini",
        workspaceRoot: "/tmp/stream-final-synthesis",
        isTauri: false,
        stream: true,
        maxSteps: 12,
        conversationHistory: [
          {
            role: "user",
            content:
              "Produce the final answer now using only the evidence above.",
            continuationType: "final_synthesis",
          },
        ],
      });

      expect(response.status).toBe(200);
      expect(stream).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          maxSteps: 1,
          toolChoice: "none",
        }),
      );
    } finally {
      await stopServer(server);
    }
  }, 30000);

  it("marks the budget reached when stopWhen halts after the last allowed tool", async () => {
    mockCreateCodingAgent.mockResolvedValueOnce({
      generate: jest.fn(async () => ({
        text: "fallback",
        steps: [],
        toolCalls: [],
      })),
      stream: jest.fn(async () => ({
        fullStream: createMockFullStream([
          {
            type: "tool-call",
            payload: {
              toolName: "read_file",
              args: { filePath: "src/containers/ChatBot.tsx" },
              toolCallId: "call_1",
            },
          },
          {
            type: "tool-result",
            payload: {
              toolName: "read_file",
              args: { filePath: "src/containers/ChatBot.tsx" },
              toolCallId: "call_1",
              result: { success: true, linesAdded: 0, linesRemoved: 0 },
            },
          },
          {
            type: "text-delta",
            payload: { text: "Done." },
          },
        ]),
        text: Promise.resolve("Done."),
        toolCalls: Promise.resolve([]),
        steps: Promise.resolve([
          {
            toolCalls: [{ toolName: "read_file" }],
          },
        ]),
      })),
    });

    const { server, baseUrl } = await startServer();

    try {
      const response = await postStreaming(baseUrl, "/api/agent/chat", {
        message: "run tool",
        modelId: "gpt-4o-mini",
        workspaceRoot: "/tmp/stream-tools",
        isTauri: false,
        stream: true,
        maxSteps: 1,
      });

      expect(response.status).toBe(200);
      expect(response.contentType).toContain("text/event-stream");

      const toolCallIndex = response.body.indexOf("event: tool_call");
      const toolResultIndex = response.body.indexOf("event: tool_result");
      const doneIndex = response.body.indexOf("event: done");

      expect(toolCallIndex).toBeGreaterThanOrEqual(0);
      expect(toolResultIndex).toBeGreaterThanOrEqual(0);
      expect(doneIndex).toBeGreaterThanOrEqual(0);
      expect(toolCallIndex).toBeLessThan(toolResultIndex);
      expect(toolResultIndex).toBeLessThan(doneIndex);

      expect(response.body).toContain("read_file");
      expect(response.body).toContain("call_1");
      expect(response.body).toContain('"maxStepsReached":true');
      expect(response.body).toContain('"stepsUsed":1');
      expect(response.body).toContain('"toolCallsUsed":1');

      expect(mockCreateAgentRequestContext).toHaveBeenCalledWith(
        [],
        expect.objectContaining({
          toolCallBudget: { limit: 1, admitted: 0 },
        }),
      );

      const doneChunk = response.body
        .split("\n\n")
        .find((chunk) => chunk.includes("event: done"));
      expect(doneChunk).toBeDefined();

      const doneDataLine = (doneChunk || "")
        .split("\n")
        .find((line) => line.startsWith("data:"));
      expect(doneDataLine).toBeDefined();

      const donePayload = JSON.parse(
        String(doneDataLine).replace(/^data:\s*/, ""),
      );
      expect(donePayload.toolCalls).toEqual([]);
      expect(donePayload.executedToolResults).toEqual([
        {
          name: "read_file",
          args: { filePath: "src/containers/ChatBot.tsx" },
          result: { success: true, linesAdded: 0, linesRemoved: 0 },
          toolCallId: "call_1",
          status: "completed",
        },
      ]);
    } finally {
      await stopServer(server);
    }
  }, 30000);

  it("synthesizes server-side when a stream exceeds the budget even with earlier result snapshots", async () => {
    const generate = jest.fn(async () => ({
      text: "Final answer from completed evidence.",
      steps: [],
      toolCalls: [],
    }));
    mockCreateCodingAgent.mockResolvedValueOnce({
      generate,
      stream: jest.fn(async () => ({
        fullStream: createMockFullStream([
          {
            type: "tool-call",
            payload: {
              toolName: "read_file",
              args: { filePath: "README.md", encoding: "utf-8" },
              toolCallId: "tool_1",
            },
          },
          {
            type: "tool-result",
            payload: {
              toolName: "read_file",
              args: { filePath: "README.md", encoding: "utf-8" },
              toolCallId: "tool_1",
              result: { status: "ok", content: "README contents" },
            },
          },
          {
            type: "tool-call",
            payload: {
              toolName: "grep",
              args: { query: "TODO" },
              toolCallId: "tool_2",
            },
          },
          {
            type: "tool-call",
            payload: {
              toolName: "grep",
              args: { query: "FIXME" },
              toolCallId: "tool_3",
            },
          },
        ]),
        text: Promise.resolve("I need to inspect the README."),
        toolCalls: Promise.resolve([
          {
            toolName: "grep",
            args: { query: "TODO" },
            toolCallId: "tool_2",
          },
          {
            toolName: "grep",
            args: { query: "FIXME" },
            toolCallId: "tool_3",
          },
        ]),
        steps: Promise.resolve([
          {
            toolCalls: [
              { toolName: "read_file" },
              { toolName: "grep" },
              { toolName: "grep" },
            ],
          },
        ]),
      })),
    });

    const { server, baseUrl } = await startServer();

    try {
      const response = await postStreaming(baseUrl, "/api/agent/chat", {
        message: "Inspect the README",
        modelId: "gpt-4o-mini",
        workspaceRoot: "/tmp/stream-over-budget-with-snapshots",
        isTauri: false,
        stream: true,
        maxSteps: 2,
      });

      expect(response.status).toBe(200);
      expect(generate).toHaveBeenCalledWith(
        expect.stringContaining(
          "The server-side tool-action budget is exhausted.",
        ),
        expect.objectContaining({
          maxSteps: 1,
          toolChoice: "none",
        }),
      );

      const doneChunk = response.body
        .split("\n\n")
        .find((chunk) => chunk.includes("event: done"));
      const doneDataLine = (doneChunk || "")
        .split("\n")
        .find((line) => line.startsWith("data:"));
      const donePayload = JSON.parse(
        String(doneDataLine).replace(/^data:\s*/, ""),
      );

      expect(donePayload.response).toBe(
        "Final answer from completed evidence.",
      );
      expect(donePayload.toolCalls).toEqual([]);
      expect(donePayload.maxStepsReached).toBe(false);
    } finally {
      await stopServer(server);
    }
  }, 30000);

  it("synthesizes server-side when a stream ends with pending tool calls", async () => {
    const generate = jest.fn(async () => ({
      text: "Final answer from completed evidence.",
      steps: [],
      toolCalls: [],
    }));
    mockCreateCodingAgent.mockResolvedValueOnce({
      generate,
      stream: jest.fn(async () => ({
        fullStream: createMockFullStream([
          {
            type: "tool-call",
            payload: {
              toolName: "read_file",
              args: { filePath: "README.md", encoding: "utf-8" },
              toolCallId: "pending_1",
            },
          },
        ]),
        text: Promise.resolve("I need to inspect the README."),
        toolCalls: Promise.resolve([
          {
            toolName: "read_file",
            args: { filePath: "README.md", encoding: "utf-8" },
            toolCallId: "pending_1",
          },
        ]),
        steps: Promise.resolve([
          {
            toolCalls: [{ toolName: "read_file" }],
          },
        ]),
      })),
    });

    const { server, baseUrl } = await startServer();

    try {
      const response = await postStreaming(baseUrl, "/api/agent/chat", {
        message: "Inspect the README",
        modelId: "gpt-4o-mini",
        workspaceRoot: "/tmp/stream-pending-tool",
        isTauri: false,
        stream: true,
        maxSteps: 1,
      });

      expect(response.status).toBe(200);
      expect(generate).toHaveBeenCalledWith(
        expect.stringContaining(
          "The server-side tool-action budget is exhausted.",
        ),
        expect.objectContaining({
          maxSteps: 1,
          toolChoice: "none",
        }),
      );

      const doneChunk = response.body
        .split("\n\n")
        .find((chunk) => chunk.includes("event: done"));
      const doneDataLine = (doneChunk || "")
        .split("\n")
        .find((line) => line.startsWith("data:"));
      const donePayload = JSON.parse(
        String(doneDataLine).replace(/^data:\s*/, ""),
      );

      expect(donePayload.response).toBe(
        "Final answer from completed evidence.",
      );
      expect(donePayload.toolCalls).toEqual([]);
      expect(donePayload.maxStepsReached).toBe(false);
    } finally {
      await stopServer(server);
    }
  }, 30000);

  it("keeps the existing final text when the budget synthesis result is blank", async () => {
    const generate = jest.fn(async () => ({
      text: "   ",
      steps: [],
      toolCalls: [],
    }));
    mockCreateCodingAgent.mockResolvedValueOnce({
      generate,
      stream: jest.fn(async () => ({
        fullStream: createMockFullStream([
          {
            type: "tool-call",
            payload: {
              toolName: "read_file",
              args: { filePath: "README.md" },
              toolCallId: "pending_1",
            },
          },
        ]),
        text: Promise.resolve("I need to inspect the README."),
        toolCalls: Promise.resolve([
          {
            toolName: "read_file",
            args: { filePath: "README.md" },
            toolCallId: "pending_1",
          },
        ]),
        steps: Promise.resolve([
          {
            toolCalls: [{ toolName: "read_file" }],
          },
        ]),
      })),
    });

    const { server, baseUrl } = await startServer();

    try {
      const response = await postStreaming(baseUrl, "/api/agent/chat", {
        message: "Inspect the README",
        modelId: "gpt-4o-mini",
        workspaceRoot: "/tmp/stream-budget-synthesis-blank",
        isTauri: false,
        stream: true,
        maxSteps: 1,
      });

      expect(response.status).toBe(200);
      const doneChunk = response.body
        .split("\n\n")
        .find((chunk) => chunk.includes("event: done"));
      const doneDataLine = (doneChunk || "")
        .split("\n")
        .find((line) => line.startsWith("data:"));
      const donePayload = JSON.parse(
        String(doneDataLine).replace(/^data:\s*/, ""),
      );

      expect(donePayload.response).toBe("I need to inspect the README.");
      expect(donePayload.toolCalls).toEqual([
        expect.objectContaining({
          name: "read_file",
          toolCallId: "pending_1",
          status: "pending",
        }),
      ]);
      expect(donePayload.lifecycleState).toBe("waiting_tool");
    } finally {
      await stopServer(server);
    }
  }, 30000);

  it("synthesizes a final answer when a stream completes with empty text after a string tool result", async () => {
    const generate = jest.fn(async () => ({
      text: "Final answer from completed evidence.",
      steps: [],
      toolCalls: [],
    }));
    mockCreateCodingAgent.mockResolvedValueOnce({
      generate,
      stream: jest.fn(async () => ({
        fullStream: createMockFullStream([
          {
            type: "tool-call",
            payload: {
              toolName: "read_file",
              args: { filePath: "README.md" },
              toolCallId: "tool_1",
            },
          },
          {
            type: "tool-result",
            payload: {
              toolName: "read_file",
              toolCallId: "tool_1",
              args: { filePath: "README.md" },
              result: "README contents",
            },
          },
        ]),
        text: Promise.resolve(""),
        toolCalls: Promise.resolve([]),
        steps: Promise.resolve([
          {
            toolCalls: [{ toolName: "read_file" }],
          },
        ]),
      })),
    });

    const { server, baseUrl } = await startServer();

    try {
      const response = await postStreaming(baseUrl, "/api/agent/chat", {
        message: "Inspect the README",
        modelId: "gpt-4o-mini",
        workspaceRoot: "/tmp/stream-empty-final",
        isTauri: false,
        stream: true,
        maxSteps: 2,
      });

      expect(response.status).toBe(200);
      expect(generate).toHaveBeenCalledWith(
        expect.stringContaining(
          "Tool execution finished, but the model returned no final response.",
        ),
        expect.objectContaining({
          maxSteps: 1,
          toolChoice: "none",
        }),
      );

      const doneChunk = response.body
        .split("\n\n")
        .find((chunk) => chunk.includes("event: done"));
      const doneDataLine = (doneChunk || "")
        .split("\n")
        .find((line) => line.startsWith("data:"));
      const donePayload = JSON.parse(
        String(doneDataLine).replace(/^data:\s*/, ""),
      );

      expect(donePayload.response).toBe(
        "Final answer from completed evidence.",
      );
      expect(donePayload.toolCalls).toEqual([]);
      expect(donePayload.maxStepsReached).toBe(false);
    } finally {
      await stopServer(server);
    }
  }, 30000);

  it("synthesizes a final answer when a non-stream generation has a string tool result and empty text", async () => {
    const generate = jest
      .fn()
      .mockResolvedValueOnce({
        text: "",
        steps: [
          {
            content: [
              {
                type: "tool-call",
                toolName: "read_file",
                toolCallId: "tool_1",
                args: { filePath: "README.md" },
              },
              {
                type: "tool-result",
                toolName: "read_file",
                toolCallId: "tool_1",
                result: "README contents",
              },
            ],
          },
        ],
        toolCalls: [],
      })
      .mockResolvedValueOnce({
        text: "Final answer from completed evidence.",
        steps: [],
        toolCalls: [],
      });
    mockCreateCodingAgent.mockResolvedValueOnce({
      generate,
      stream: mockAgentStream,
    });

    const { server, baseUrl } = await startServer();

    try {
      const response = await postJson(baseUrl, "/api/agent/chat", {
        message: "Inspect the README",
        modelId: "gpt-4o-mini",
        workspaceRoot: "/tmp/non-stream-empty-final",
        isTauri: false,
        maxSteps: 2,
      });

      expect(response.status).toBe(200);
      expect(generate).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining(
          "Tool execution finished, but the model returned no final response.",
        ),
        expect.objectContaining({
          maxSteps: 1,
          toolChoice: "none",
        }),
      );
      expect(response.body.response).toBe(
        "Final answer from completed evidence.",
      );
      expect(response.body.toolCalls).toEqual([]);
      expect(response.body.maxStepsReached).toBe(false);
    } finally {
      await stopServer(server);
    }
  }, 30000);

  it("does not synthesize a budget-exhausted non-stream response with a pending result", async () => {
    const generate = jest.fn().mockResolvedValueOnce({
      text: "The read is still pending.",
      steps: [
        {
          content: [
            {
              type: "tool-call",
              toolName: "read_file",
              toolCallId: "pending_1",
              args: { filePath: "README.md" },
            },
            {
              type: "tool-result",
              toolName: "read_file",
              toolCallId: "pending_1",
              args: { filePath: "README.md" },
              result: { status: "pending" },
            },
          ],
          toolCalls: [
            {
              toolName: "read_file",
              toolCallId: "pending_1",
              args: { filePath: "README.md" },
            },
          ],
        },
      ],
      toolCalls: [],
    });
    mockCreateCodingAgent.mockResolvedValueOnce({
      generate,
      stream: mockAgentStream,
    });

    const { server, baseUrl } = await startServer();

    try {
      const response = await postJson(baseUrl, "/api/agent/chat", {
        message: "Inspect the README",
        modelId: "gpt-4o-mini",
        workspaceRoot: "/tmp/non-stream-pending-at-budget",
        isTauri: false,
        maxSteps: 1,
      });

      expect(response.status).toBe(200);
      expect(generate).toHaveBeenCalledTimes(1);
      expect(response.body.lifecycleState).toBe("waiting_tool");
      expect(response.body.toolCalls).toEqual([
        expect.objectContaining({
          name: "read_file",
          toolCallId: "pending_1",
          status: "pending",
        }),
      ]);
      expect(response.body.executedToolResults).toEqual([
        expect.objectContaining({
          name: "read_file",
          toolCallId: "pending_1",
          status: "pending",
        }),
      ]);
      expect(response.body.maxStepsReached).toBe(true);
    } finally {
      await stopServer(server);
    }
  }, 30000);

  it("prioritizes the tool budget reason when an empty final response arrives after the budget is reached", async () => {
    const generate = jest.fn(async () => ({
      text: "Final answer from completed evidence.",
      steps: [],
      toolCalls: [],
    }));
    mockCreateCodingAgent.mockResolvedValueOnce({
      generate,
      stream: jest.fn(async () => ({
        fullStream: createMockFullStream([
          {
            type: "tool-call",
            payload: {
              toolName: "read_file",
              args: { filePath: "README.md" },
              toolCallId: "tool_1",
            },
          },
          {
            type: "tool-result",
            payload: {
              toolName: "read_file",
              toolCallId: "tool_1",
              args: { filePath: "README.md" },
              result: { status: "ok", content: "README contents" },
            },
          },
        ]),
        text: Promise.resolve(""),
        toolCalls: Promise.resolve([
          {
            toolName: "read_file",
            args: { filePath: "README.md" },
            toolCallId: "tool_1",
          },
        ]),
        steps: Promise.resolve([
          {
            toolCalls: [{ toolName: "read_file" }],
          },
        ]),
      })),
    });

    const { server, baseUrl } = await startServer();

    try {
      const response = await postStreaming(baseUrl, "/api/agent/chat", {
        message: "Inspect the README",
        modelId: "gpt-4o-mini",
        workspaceRoot: "/tmp/stream-empty-final-budget",
        isTauri: false,
        stream: true,
        maxSteps: 1,
      });

      expect(response.status).toBe(200);
      expect(generate).toHaveBeenCalledWith(
        expect.stringContaining(
          "The server-side tool-action budget is exhausted.",
        ),
        expect.objectContaining({
          maxSteps: 1,
          toolChoice: "none",
        }),
      );

      const doneChunk = response.body
        .split("\n\n")
        .find((chunk) => chunk.includes("event: done"));
      const doneDataLine = (doneChunk || "")
        .split("\n")
        .find((line) => line.startsWith("data:"));
      const donePayload = JSON.parse(
        String(doneDataLine).replace(/^data:\s*/, ""),
      );

      expect(donePayload.response).toBe(
        "Final answer from completed evidence.",
      );
      expect(donePayload.toolCalls).toEqual([]);
      expect(donePayload.maxStepsReached).toBe(false);
    } finally {
      await stopServer(server);
    }
  }, 30000);

  it("preserves pending tool calls when the stream budget is not exhausted", async () => {
    const generate = jest.fn(async () => ({
      text: "Unexpected synthesis.",
      steps: [],
      toolCalls: [],
    }));
    mockCreateCodingAgent.mockResolvedValueOnce({
      generate,
      stream: jest.fn(async () => ({
        fullStream: createMockFullStream([
          {
            type: "tool-call",
            payload: {
              toolName: "read_file",
              args: { filePath: "README.md" },
              toolCallId: "pending_1",
            },
          },
        ]),
        text: Promise.resolve("I need to inspect the README."),
        toolCalls: Promise.resolve([
          {
            toolName: "read_file",
            args: { filePath: "README.md" },
            toolCallId: "pending_1",
          },
        ]),
        steps: Promise.resolve([
          {
            toolCalls: [{ toolName: "read_file" }],
          },
        ]),
      })),
    });

    const { server, baseUrl } = await startServer();

    try {
      const response = await postStreaming(baseUrl, "/api/agent/chat", {
        message: "Inspect the README",
        modelId: "gpt-4o-mini",
        workspaceRoot: "/tmp/stream-waiting-tool",
        isTauri: false,
        stream: true,
        maxSteps: 2,
      });

      expect(response.status).toBe(200);
      expect(generate).not.toHaveBeenCalled();

      const doneChunk = response.body
        .split("\n\n")
        .find((chunk) => chunk.includes("event: done"));
      const doneDataLine = (doneChunk || "")
        .split("\n")
        .find((line) => line.startsWith("data:"));
      const donePayload = JSON.parse(
        String(doneDataLine).replace(/^data:\s*/, ""),
      );

      expect(donePayload.lifecycleState).toBe("waiting_tool");
      expect(donePayload.toolCalls).toEqual([
        expect.objectContaining({
          name: "read_file",
          toolCallId: "pending_1",
          status: "pending",
        }),
      ]);
      expect(donePayload.maxStepsReached).toBe(false);
    } finally {
      await stopServer(server);
    }
  }, 30000);

  it("does not synthesize a budget-exhausted stream with an in-progress tool result", async () => {
    const generate = jest.fn(async () => ({
      text: "Unexpected synthesis.",
      steps: [],
      toolCalls: [],
    }));
    mockCreateCodingAgent.mockResolvedValueOnce({
      generate,
      stream: jest.fn(async () => ({
        fullStream: createMockFullStream([
          {
            type: "tool-call",
            payload: {
              toolName: "read_file",
              args: { filePath: "README.md" },
              toolCallId: "pending_1",
            },
          },
          {
            type: "tool-result",
            payload: {
              toolName: "read_file",
              args: { filePath: "README.md" },
              toolCallId: "pending_1",
              result: { status: "in_progress", progress: 50 },
            },
          },
        ]),
        text: Promise.resolve("The read is still running."),
        toolCalls: Promise.resolve([
          {
            toolName: "read_file",
            args: { filePath: "README.md" },
            toolCallId: "pending_1",
          },
        ]),
        steps: Promise.resolve([
          {
            toolCalls: [{ toolName: "read_file" }],
          },
        ]),
      })),
    });

    const { server, baseUrl } = await startServer();

    try {
      const response = await postStreaming(baseUrl, "/api/agent/chat", {
        message: "Inspect the README",
        modelId: "gpt-4o-mini",
        workspaceRoot: "/tmp/stream-in-progress-at-budget",
        isTauri: false,
        stream: true,
        maxSteps: 1,
      });

      expect(response.status).toBe(200);
      expect(generate).not.toHaveBeenCalled();

      const doneChunk = response.body
        .split("\n\n")
        .find((chunk) => chunk.includes("event: done"));
      const doneDataLine = (doneChunk || "")
        .split("\n")
        .find((line) => line.startsWith("data:"));
      const donePayload = JSON.parse(
        String(doneDataLine).replace(/^data:\s*/, ""),
      );

      expect(donePayload.lifecycleState).toBe("waiting_tool");
      expect(donePayload.toolCalls).toEqual([
        expect.objectContaining({
          name: "read_file",
          toolCallId: "pending_1",
          status: "pending",
        }),
      ]);
      expect(donePayload.executedToolResults).toEqual([
        expect.objectContaining({
          name: "read_file",
          toolCallId: "pending_1",
          status: "in_progress",
        }),
      ]);
      expect(donePayload.maxStepsReached).toBe(true);
    } finally {
      await stopServer(server);
    }
  }, 30000);

  it("synthesizes at the exact budget when an earlier result precedes a pending tool", async () => {
    const generate = jest.fn(async () => ({
      text: "Unexpected synthesis.",
      steps: [],
      toolCalls: [],
    }));
    mockCreateCodingAgent.mockResolvedValueOnce({
      generate,
      stream: jest.fn(async () => ({
        fullStream: createMockFullStream([
          {
            type: "tool-call",
            payload: {
              toolName: "read_file",
              args: { filePath: "README.md" },
              toolCallId: "read_1",
            },
          },
          {
            type: "tool-result",
            payload: {
              toolName: "read_file",
              args: { filePath: "README.md" },
              toolCallId: "read_1",
              result: { status: "completed", content: "README contents" },
            },
          },
          {
            type: "tool-call",
            payload: {
              toolName: "grep_search",
              args: { pattern: "TODO" },
              toolCallId: "grep_1",
            },
          },
        ]),
        text: Promise.resolve(""),
        toolCalls: Promise.resolve([
          {
            toolName: "grep_search",
            args: { pattern: "TODO" },
            toolCallId: "grep_1",
          },
        ]),
        steps: Promise.resolve([
          {
            toolCalls: [{ toolName: "read_file" }, { toolName: "grep_search" }],
          },
        ]),
      })),
    });

    const { server, baseUrl } = await startServer();

    try {
      const response = await postStreaming(baseUrl, "/api/agent/chat", {
        message: "Inspect the README and search for TODOs",
        modelId: "gpt-4o-mini",
        workspaceRoot: "/tmp/stream-mixed-tool-state",
        isTauri: false,
        stream: true,
        maxSteps: 2,
      });

      expect(response.status).toBe(200);
      expect(generate).toHaveBeenCalled();

      const doneChunk = response.body
        .split("\n\n")
        .find((chunk) => chunk.includes("event: done"));
      const doneDataLine = (doneChunk || "")
        .split("\n")
        .find((line) => line.startsWith("data:"));
      const donePayload = JSON.parse(
        String(doneDataLine).replace(/^data:\s*/, ""),
      );

      expect(donePayload.lifecycleState).toBe("succeeded");
      expect(donePayload.toolCalls).toEqual([]);
      expect(donePayload.executedToolResults).toEqual([
        expect.objectContaining({
          name: "read_file",
          toolCallId: "read_1",
          status: "completed",
        }),
      ]);
    } finally {
      await stopServer(server);
    }
  }, 30000);

  it("returns processed AIRIS diff metadata instead of the raw streamed edit result", async () => {
    const oldSecret = "sk-abcdefghijklmnopqrstuvwxyz123456";
    const newSecret = "sk-zyxwvutsrqponmlkjihgfedcba654321";
    const diffResult = {
      success: true,
      filePath: "/tmp/stream-diff/example.ts",
      fileExisted: true,
      oldContent: 'export const token = "[REDACTED:openai_key]";\n',
      newContent: 'export const token = "[REDACTED:openai_key]";\n',
      diff: '--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-export const token = "[REDACTED:openai_key]";\n+export const token = "[REDACTED:openai_key]";\n',
      linesAdded: 1,
      linesRemoved: 1,
    };
    const takeProcessedWorkspaceResults = jest.fn(
      (_generationId: string, _toolCallIds: string[]) => [
        { toolCallId: "call_edit", result: diffResult },
      ],
    );
    const clearProcessedWorkspaceResults = jest.fn();
    mockCreateCodingAgent.mockResolvedValueOnce({
      generate: jest.fn(async () => ({
        text: "fallback",
        steps: [],
        toolCalls: [],
      })),
      takeProcessedWorkspaceResults,
      clearProcessedWorkspaceResults,
      stream: jest.fn(async () => ({
        fullStream: createMockFullStream([
          {
            type: "tool-call",
            payload: {
              toolName: "editFile",
              args: { path: "example.ts" },
              toolCallId: "call_edit",
            },
          },
          {
            type: "tool-result",
            payload: {
              toolName: "editFile",
              args: { path: "example.ts" },
              toolCallId: "call_edit",
              result: {
                success: true,
                oldContent: `export const token = "${oldSecret}";\n`,
                newContent: `export const token = "${newSecret}";\n`,
                diff: `-${oldSecret}\n+${newSecret}\n`,
              },
            },
          },
        ]),
        text: Promise.resolve("Updated the file."),
        toolCalls: Promise.resolve([]),
        steps: Promise.resolve([
          {
            toolCalls: [{ toolName: "editFile" }],
            content: [
              {
                type: "tool-call",
                toolName: "editFile",
                toolCallId: "call_edit",
                args: { path: "example.ts" },
              },
              {
                type: "tool-result",
                toolName: "editFile",
                toolCallId: "call_edit",
                result: {
                  success: true,
                  oldContent: `export const token = "${oldSecret}";\n`,
                  newContent: `export const token = "${newSecret}";\n`,
                  diff: `-${oldSecret}\n+${newSecret}\n`,
                },
              },
            ],
          },
        ]),
      })),
    });

    const { server, baseUrl } = await startServer();

    try {
      const response = await postStreaming(baseUrl, "/api/agent/chat", {
        message: "edit the file",
        modelId: "gpt-4o-mini",
        workspaceRoot: "/tmp/stream-diff",
        isTauri: false,
        stream: true,
      });
      expect(response.body).not.toContain(oldSecret);
      expect(response.body).not.toContain(newSecret);
      const toolResultChunk = response.body
        .split("\n\n")
        .find((chunk) => chunk.includes("event: tool_result"));
      const toolResultDataLine = (toolResultChunk || "")
        .split("\n")
        .find((line) => line.startsWith("data:"));
      const toolResultPayload = JSON.parse(
        String(toolResultDataLine).replace(/^data:\s*/, ""),
      );
      expect(toolResultPayload.result).toEqual(
        expect.objectContaining({
          oldContent: expect.stringContaining("[REDACTED:openai_key]"),
          newContent: expect.stringContaining("[REDACTED:openai_key]"),
          diff: expect.stringContaining("[REDACTED:openai_key]"),
        }),
      );
      const doneChunk = response.body
        .split("\n\n")
        .find((chunk) => chunk.includes("event: done"));
      const doneDataLine = (doneChunk || "")
        .split("\n")
        .find((line) => line.startsWith("data:"));
      const donePayload = JSON.parse(
        String(doneDataLine).replace(/^data:\s*/, ""),
      );

      expect(donePayload.executedToolResults).toEqual([
        expect.objectContaining({
          name: "editFile",
          toolCallId: "call_edit",
          result: diffResult,
        }),
      ]);
      expect(takeProcessedWorkspaceResults).toHaveBeenCalledWith(
        expect.any(String),
        ["call_edit"],
      );
      const generationId = takeProcessedWorkspaceResults.mock.calls[0][0];
      expect(clearProcessedWorkspaceResults).toHaveBeenCalledWith(generationId);
    } finally {
      await stopServer(server);
    }
  }, 30000);

  it("clears captured workspace results when streaming fails before reconciliation", async () => {
    const takeProcessedWorkspaceResults = jest.fn();
    const clearProcessedWorkspaceResults = jest.fn();
    let readCount = 0;
    mockCreateCodingAgent.mockResolvedValueOnce({
      generate: jest.fn(async () => ({
        text: "fallback",
        steps: [],
        toolCalls: [],
      })),
      takeProcessedWorkspaceResults,
      clearProcessedWorkspaceResults,
      stream: jest.fn(async () => ({
        fullStream: {
          getReader: () => ({
            read: async () => {
              if (readCount === 0) {
                readCount += 1;
                return {
                  done: false,
                  value: {
                    type: "tool-result",
                    payload: {
                      toolName: "editFile",
                      args: { path: "example.ts" },
                      toolCallId: "call_failed_edit",
                      result: "File edited successfully",
                    },
                  },
                };
              }

              throw new Error("stream interrupted");
            },
          }),
        },
        text: Promise.resolve(""),
        toolCalls: Promise.resolve([]),
      })),
    });

    const { server, baseUrl } = await startServer();

    try {
      const response = await postStreaming(baseUrl, "/api/agent/chat", {
        message: "edit the file",
        modelId: "gpt-4o-mini",
        workspaceRoot: "/tmp/stream-failed-diff",
        isTauri: false,
        stream: true,
      });

      expect(response.status).toBe(200);
      expect(response.body).toContain("event: tool_result");
      expect(response.body).toContain("event: error");
      expect(takeProcessedWorkspaceResults).not.toHaveBeenCalled();
      expect(clearProcessedWorkspaceResults).toHaveBeenCalledTimes(1);
    } finally {
      await stopServer(server);
    }
  }, 30000);

  it("does not mark maxStepsReached when only a final text step exceeds step count", async () => {
    mockCreateCodingAgent.mockResolvedValueOnce({
      generate: jest.fn(async () => ({
        text: "fallback",
        steps: [],
        toolCalls: [],
      })),
      stream: jest.fn(async () => ({
        fullStream: createMockFullStream([
          {
            type: "tool-call",
            payload: {
              toolName: "read_file",
              args: { filePath: "src/containers/ChatBot.tsx" },
              toolCallId: "call_1",
            },
          },
          {
            type: "tool-result",
            payload: {
              toolName: "read_file",
              args: { filePath: "src/containers/ChatBot.tsx" },
              toolCallId: "call_1",
              result: { success: true },
            },
          },
          {
            type: "text-delta",
            payload: { text: "Final answer." },
          },
        ]),
        text: Promise.resolve("Final answer."),
        toolCalls: Promise.resolve([]),
        steps: Promise.resolve([
          {
            toolCalls: [{ toolName: "read_file" }],
          },
          {
            toolCalls: [],
          },
        ]),
      })),
    });

    const { server, baseUrl } = await startServer();

    try {
      const response = await postStreaming(baseUrl, "/api/agent/chat", {
        message: "run tool then answer",
        modelId: "gpt-4o-mini",
        workspaceRoot: "/tmp/stream-tools-final-step",
        isTauri: false,
        stream: true,
        maxSteps: 1,
      });

      expect(response.status).toBe(200);
      expect(response.body).toContain('"stepsUsed":2');
      expect(response.body).toContain('"toolCallsUsed":1');
      expect(response.body).toContain('"maxStepsReached":false');
    } finally {
      await stopServer(server);
    }
  }, 30000);

  it("preserves observed stream tool activity when steps omit tool calls", async () => {
    mockCreateCodingAgent.mockResolvedValueOnce({
      generate: jest.fn(async () => ({
        text: "fallback",
        steps: [],
        toolCalls: [],
      })),
      stream: jest.fn(async () => ({
        fullStream: createMockFullStream([
          {
            type: "tool-call",
            payload: {
              toolName: "read_file",
              args: { filePath: "README.md" },
              toolCallId: "stream-call-1",
            },
          },
        ]),
        text: Promise.resolve(""),
        toolCalls: Promise.resolve([]),
        steps: Promise.resolve([]),
      })),
    });

    const { server, baseUrl } = await startServer();

    try {
      const response = await postStreaming(baseUrl, "/api/agent/chat", {
        message: "inspect the README",
        modelId: "gpt-4o-mini",
        workspaceRoot: "/tmp/stream-steps-without-tools",
        isTauri: false,
        stream: true,
        maxSteps: 1,
      });

      expect(response.status).toBe(200);
      expect(response.body).toContain('"toolCallsUsed":1');
      expect(response.body).toContain('"toolCallId":"stream-call-1"');
    } finally {
      await stopServer(server);
    }
  }, 30000);

  it("does not count duplicate anonymous results from stream and step snapshots", async () => {
    mockCreateCodingAgent.mockResolvedValueOnce({
      generate: jest.fn(async () => ({
        text: "fallback",
        steps: [],
        toolCalls: [],
      })),
      stream: jest.fn(async () => ({
        fullStream: createMockFullStream([
          {
            type: "tool-call",
            payload: {
              toolName: "read_file",
              args: { filePath: "README.md", encoding: "utf-8" },
            },
          },
          {
            type: "tool-call",
            payload: {
              toolName: "read_file",
              args: { filePath: "README.md", encoding: "utf-8" },
            },
          },
          {
            type: "tool-result",
            payload: {
              toolName: "read_file",
              args: { filePath: "README.md", encoding: "utf-8" },
              result: { status: "completed", content: "README contents" },
            },
          },
        ]),
        text: Promise.resolve(""),
        toolCalls: Promise.resolve([]),
        steps: Promise.resolve([
          {
            content: [
              {
                type: "tool-result",
                toolName: "read_file",
                args: { encoding: "utf-8", filePath: "README.md" },
                result: { status: "completed", content: "README contents" },
              },
            ],
          },
        ]),
      })),
    });

    const { server, baseUrl } = await startServer();

    try {
      const response = await postStreaming(baseUrl, "/api/agent/chat", {
        message: "inspect the README twice",
        modelId: "gpt-4o-mini",
        workspaceRoot: "/tmp/stream-duplicate-anonymous-results",
        isTauri: false,
        stream: true,
        maxSteps: 2,
      });

      expect(response.status).toBe(200);
      expect(response.body).toContain('"toolCallsUsed":2');
    } finally {
      await stopServer(server);
    }
  }, 30000);

  it("reconciles duplicate anonymous pending-call snapshots", async () => {
    const calls = [
      { toolName: "read_file", args: { filePath: "README.md" } },
      { toolName: "read_file", args: { filePath: "README.md" } },
    ];
    mockCreateCodingAgent.mockResolvedValueOnce({
      generate: jest.fn(async () => ({
        text: "fallback",
        steps: [],
        toolCalls: [],
      })),
      stream: jest.fn(async () => ({
        fullStream: createMockFullStream(
          calls.map((payload) => ({ type: "tool-call", payload })),
        ),
        text: Promise.resolve(""),
        toolCalls: Promise.resolve(calls),
        steps: Promise.resolve([]),
      })),
    });

    const { server, baseUrl } = await startServer();

    try {
      const response = await postStreaming(baseUrl, "/api/agent/chat", {
        message: "inspect the README twice",
        modelId: "gpt-4o-mini",
        workspaceRoot: "/tmp/stream-duplicate-anonymous-calls",
        isTauri: false,
        stream: true,
      });

      expect(response.status).toBe(200);
      expect(response.body).toContain('"toolCallsUsed":2');
    } finally {
      await stopServer(server);
    }
  }, 30000);

  it("reconciles a missing-ID step result with one identified stream result", async () => {
    mockCreateCodingAgent.mockResolvedValueOnce({
      generate: jest.fn(async () => ({
        text: "fallback",
        steps: [],
        toolCalls: [],
      })),
      stream: jest.fn(async () => ({
        fullStream: createMockFullStream([
          {
            type: "tool-call",
            payload: {
              toolName: "read_file",
              args: { filePath: "README.md" },
              toolCallId: "identified-stream-call",
            },
          },
          {
            type: "tool-result",
            payload: {
              toolName: "read_file",
              args: { filePath: "README.md" },
              toolCallId: "identified-stream-call",
              result: { status: "completed", content: "README contents" },
            },
          },
        ]),
        text: Promise.resolve(""),
        toolCalls: Promise.resolve([]),
        steps: Promise.resolve([
          {
            content: [
              {
                type: "tool-result",
                toolName: "read_file",
                args: { filePath: "README.md" },
                result: { status: "completed", content: "README contents" },
              },
            ],
          },
        ]),
      })),
    });

    const { server, baseUrl } = await startServer();

    try {
      const response = await postStreaming(baseUrl, "/api/agent/chat", {
        message: "inspect the README",
        modelId: "gpt-4o-mini",
        workspaceRoot: "/tmp/stream-identified-missing-id",
        isTauri: false,
        stream: true,
      });

      expect(response.status).toBe(200);
      const donePayload = response.body.split("event: done\n")[1];
      expect(donePayload).toContain(
        '"executedToolResults":[{"name":"read_file"',
      );
      expect(donePayload).toContain('"toolCallId":"identified-stream-call"');
      expect(donePayload).not.toContain(
        '"executedToolResults":[{"name":"read_file"},{',
      );
    } finally {
      await stopServer(server);
    }
  }, 30000);

  it("reconciles repeated missing-ID result snapshots in stream order", async () => {
    const args = { filePath: "README.md" };
    mockCreateCodingAgent.mockResolvedValueOnce({
      generate: jest.fn(async () => ({
        text: "fallback",
        steps: [],
        toolCalls: [],
      })),
      stream: jest.fn(async () => ({
        fullStream: createMockFullStream([
          {
            type: "tool-result",
            payload: {
              toolName: "read_file",
              args,
              toolCallId: "stream-call-1",
              result: { status: "completed", content: "first" },
            },
          },
          {
            type: "tool-result",
            payload: {
              toolName: "read_file",
              args,
              toolCallId: "stream-call-2",
              result: { status: "completed", content: "second" },
            },
          },
        ]),
        text: Promise.resolve(""),
        toolCalls: Promise.resolve([]),
        steps: Promise.resolve([
          {
            content: [
              {
                type: "tool-result",
                toolName: "read_file",
                args,
                result: { status: "completed", content: "first" },
              },
              {
                type: "tool-result",
                toolName: "read_file",
                args,
                result: { status: "completed", content: "second" },
              },
            ],
          },
        ]),
      })),
    });

    const { server, baseUrl } = await startServer();

    try {
      const response = await postStreaming(baseUrl, "/api/agent/chat", {
        message: "inspect the README twice",
        modelId: "gpt-4o-mini",
        workspaceRoot: "/tmp/stream-repeated-missing-id",
        isTauri: false,
        stream: true,
      });

      expect(response.status).toBe(200);
      const donePayload = response.body.split("event: done\ndata: ")[1];
      const payload = JSON.parse(donePayload) as {
        executedToolResults: Array<{ toolCallId?: string }>;
      };
      expect(payload.executedToolResults).toHaveLength(2);
      expect(
        payload.executedToolResults.map(({ toolCallId }) => toolCallId),
      ).toEqual(["stream-call-1", "stream-call-2"]);
    } finally {
      await stopServer(server);
    }
  }, 30000);

  it("pauses instead of completing when the tool-call budget is exhausted", async () => {
    mockCreateCodingAgent.mockResolvedValueOnce({
      generate: jest.fn(async () => ({
        text: "fallback",
        steps: [],
        toolCalls: [],
      })),
      stream: jest.fn(async () => ({
        fullStream: createMockFullStream([
          {
            type: "tool-call",
            payload: {
              toolName: "read_file",
              args: { filePath: "src/containers/ChatBot.tsx" },
              toolCallId: "call_1",
            },
          },
          {
            type: "tool-result",
            payload: {
              toolName: "read_file",
              args: { filePath: "src/containers/ChatBot.tsx" },
              toolCallId: "call_1",
              result: { success: true },
            },
          },
        ]),
        text: Promise.resolve("Read the file."),
        toolCalls: Promise.resolve([]),
        steps: Promise.resolve([
          {
            toolCalls: [{ toolName: "read_file" }],
          },
        ]),
      })),
    });

    const { server, baseUrl } = await startServer();

    try {
      const response = await postStreaming(baseUrl, "/api/agent/chat", {
        message: "inspect the file",
        modelId: "gpt-4o-mini",
        workspaceRoot: "/tmp/stream-tools-budget",
        isTauri: false,
        stream: true,
        maxSteps: 1,
      });

      expect(response.status).toBe(200);
      expect(response.body).toContain('"lifecycleState":"paused"');
      expect(response.body).toContain('"stopReason":"max_steps_reached"');
      expect(response.body).toContain('"maxStepsReached":true');
    } finally {
      await stopServer(server);
    }
  }, 30000);

  it("emits a tool_call event per anonymous invocation sharing a signature", async () => {
    const args = { filePath: "README.md" };
    mockCreateCodingAgent.mockResolvedValueOnce({
      generate: jest.fn(async () => ({
        text: "fallback",
        steps: [],
        toolCalls: [],
      })),
      stream: jest.fn(async () => ({
        fullStream: createMockFullStream([
          {
            type: "tool-call",
            payload: { toolName: "read_file", args },
          },
          {
            type: "tool-call",
            payload: { toolName: "read_file", args },
          },
        ]),
        text: Promise.resolve("Read it twice."),
        toolCalls: Promise.resolve([]),
        steps: Promise.resolve([
          {
            toolCalls: [{ toolName: "read_file" }, { toolName: "read_file" }],
          },
        ]),
      })),
    });

    const { server, baseUrl } = await startServer();

    try {
      const response = await postStreaming(baseUrl, "/api/agent/chat", {
        message: "read the README twice",
        modelId: "gpt-4o-mini",
        workspaceRoot: "/tmp/stream-anonymous-emission",
        isTauri: false,
        stream: true,
      });

      expect(response.status).toBe(200);
      const toolCallEvents = response.body
        .split("\n")
        .filter((line) => line === "event: tool_call");
      expect(toolCallEvents).toHaveLength(2);
    } finally {
      await stopServer(server);
    }
  }, 30000);

  it("reports budget reached when an exact-budget step leaves a pending call", async () => {
    mockCreateCodingAgent.mockResolvedValueOnce({
      generate: jest.fn(async () => ({
        text: "",
        steps: [],
        toolCalls: [],
      })),
      stream: jest.fn(async () => ({
        fullStream: createMockFullStream([
          {
            type: "tool-call",
            payload: {
              toolName: "read_file",
              args: { filePath: "README.md" },
              toolCallId: "call_1",
            },
          },
        ]),
        text: Promise.resolve("Reading the file now."),
        toolCalls: Promise.resolve([]),
        steps: Promise.resolve([
          {
            toolCalls: [{ toolName: "read_file" }],
          },
        ]),
      })),
    });

    const { server, baseUrl } = await startServer();

    try {
      const response = await postStreaming(baseUrl, "/api/agent/chat", {
        message: "read the README",
        modelId: "gpt-4o-mini",
        workspaceRoot: "/tmp/stream-exact-budget-pending",
        isTauri: false,
        stream: true,
        maxSteps: 1,
      });

      expect(response.status).toBe(200);
      const doneChunk = response.body
        .split("\n\n")
        .find((chunk) => chunk.includes("event: done"));
      const doneDataLine = (doneChunk || "")
        .split("\n")
        .find((line) => line.startsWith("data:"));
      const donePayload = JSON.parse(
        String(doneDataLine).replace(/^data:\s*/, ""),
      ) as { maxStepsReached: boolean; lifecycleState: string };
      expect(donePayload.maxStepsReached).toBe(true);
    } finally {
      await stopServer(server);
    }
  }, 30000);

  it("emits tool_suspended events and includes suspendedTools in done payload", async () => {
    mockCreateCodingAgent.mockResolvedValueOnce({
      generate: jest.fn(async () => ({
        text: "fallback",
        steps: [],
        toolCalls: [],
      })),
      stream: jest.fn(async () => ({
        fullStream: createMockFullStream([
          {
            type: "tool_suspended",
            payload: {
              toolName: "ask_user",
              toolCallId: "tool_call_123",
              suspendPayload: {
                question: "Which file should I update?",
              },
            },
          },
        ]),
        text: Promise.resolve("I need your input."),
        toolCalls: Promise.resolve([]),
      })),
    });

    const { server, baseUrl } = await startServer();

    try {
      const response = await postStreaming(baseUrl, "/api/agent/chat", {
        message: "hello",
        modelId: "gpt-4o",
        workspaceRoot: "/tmp/stream-test",
        isTauri: false,
        stream: true,
      });

      expect(response.status).toBe(200);
      expect(response.contentType).toContain("text/event-stream");
      expect(response.body).toContain("event: tool_suspended");
      expect(response.body).toContain("ask_user");

      const doneChunk = response.body
        .split("\n\n")
        .find((chunk) => chunk.includes("event: done"));

      expect(doneChunk).toBeDefined();

      const doneDataLine = (doneChunk || "")
        .split("\n")
        .find((line) => line.startsWith("data:"));
      expect(doneDataLine).toBeDefined();

      const payload = JSON.parse(String(doneDataLine).replace(/^data:\s*/, ""));
      expect(Array.isArray(payload.suspendedTools)).toBe(true);
      expect(payload.suspendedTools).toHaveLength(1);
      expect(payload.suspendedTools[0]).toMatchObject({
        name: "ask_user",
        toolCallId: "tool_call_123",
      });
    } finally {
      await stopServer(server);
    }
  });

  it("returns waitingForUserInput in non-stream mode when tool is suspended", async () => {
    mockCreateCodingAgent.mockResolvedValueOnce({
      generate: jest.fn(async () => ({
        text: "",
        steps: [
          {
            content: [
              {
                type: "tool_suspended",
                toolName: "ask_user",
                toolCallId: "tool_call_456",
                suspendPayload: {
                  question: "Which file should I edit?",
                },
              },
            ],
          },
        ],
        toolCalls: [],
      })),
      stream: jest.fn(async () => ({
        fullStream: createMockFullStream([]),
        text: Promise.resolve(""),
        toolCalls: Promise.resolve([]),
      })),
    });

    const { server, baseUrl } = await startServer();

    try {
      const response = await postJson(baseUrl, "/api/agent/chat", {
        message: "hello",
        modelId: "gpt-4o-mini",
        workspaceRoot: "/tmp/non-stream-suspension",
        isTauri: false,
      });

      expect(response.status).toBe(200);
      expect(response.contentType).toContain("application/json");
      expect(response.body.success).toBe(true);
      expect(response.body.waitingForUserInput).toBe(true);
      expect(response.body.response).toBe("Which file should I edit?");
      expect(Array.isArray(response.body.suspendedTools)).toBe(true);
      expect(response.body.suspendedTools).toHaveLength(1);
      expect(
        (response.body.suspendedTools as Array<Record<string, unknown>>)[0],
      ).toMatchObject({
        name: "ask_user",
        toolCallId: "tool_call_456",
      });
      expect(response.body.toolCalls).toEqual([]);
    } finally {
      await stopServer(server);
    }
  });

  it("redacts rich mutation results in non-stream responses", async () => {
    const oldSecret = "sk-abcdefghijklmnopqrstuvwxyz123456";
    const newSecret = "sk-zyxwvutsrqponmlkjihgfedcba654321";
    mockCreateCodingAgent.mockResolvedValueOnce({
      generate: jest.fn(async () => ({
        text: "Updated the file",
        steps: [
          {
            content: [
              {
                type: "tool-call",
                toolName: "editFile",
                toolCallId: "call_non_stream_edit",
                args: { filePath: "src/config.ts" },
              },
              {
                type: "tool-result",
                toolName: "editFile",
                toolCallId: "call_non_stream_edit",
                result: {
                  success: true,
                  oldContent: `export const token = "${oldSecret}";\n`,
                  newContent: `export const token = "${newSecret}";\n`,
                  diff: `-${oldSecret}\n+${newSecret}`,
                },
              },
            ],
            toolCalls: [{ toolName: "editFile" }],
          },
        ],
        toolCalls: [],
      })),
      stream: jest.fn(async () => ({
        fullStream: createMockFullStream([]),
        text: Promise.resolve(""),
        toolCalls: Promise.resolve([]),
      })),
    });

    const { server, baseUrl } = await startServer();

    try {
      const response = await postJson(baseUrl, "/api/agent/chat", {
        message: "update config",
        modelId: "gpt-4o-mini",
        workspaceRoot: "/tmp/non-stream-redaction",
        isTauri: false,
        stream: false,
      });

      expect(response.status).toBe(200);
      const serialized = JSON.stringify(response.body);
      expect(serialized).not.toContain(oldSecret);
      expect(serialized).not.toContain(newSecret);
      expect(serialized).toContain("[REDACTED:openai_key]");
    } finally {
      await stopServer(server);
    }
  });

  it("sends multimodal input when image context is provided", async () => {
    const generateMock = jest.fn<
      Promise<{ text: string; steps: []; toolCalls: [] }>,
      [unknown, (Record<string, unknown> | undefined)?]
    >(async () => ({
      text: "Image processed",
      steps: [],
      toolCalls: [],
    }));

    mockCreateCodingAgent.mockResolvedValueOnce({
      generate: generateMock,
      stream: jest.fn(async () => ({
        fullStream: createMockFullStream([]),
        text: Promise.resolve(""),
        toolCalls: Promise.resolve([]),
      })),
    });

    const { server, baseUrl } = await startServer();

    try {
      const response = await postJson(baseUrl, "/api/agent/chat", {
        message: "What is in this image?",
        modelId: "gpt-4o-mini",
        workspaceRoot: "/tmp/multimodal-image-context",
        isTauri: false,
        filesInContext: [
          {
            name: "diagram.png",
            path: "diagram.png",
            type: "image/png",
            imageDataUrl: "data:image/png;base64,AAAA",
          },
        ],
      });

      expect(response.status).toBe(200);
      expect(response.contentType).toContain("application/json");
      expect(response.body.success).toBe(true);

      expect(generateMock).toHaveBeenCalledTimes(1);
      const firstCallArgs = generateMock.mock.calls[0];
      expect(firstCallArgs).toBeDefined();
      const input = firstCallArgs?.[0] as unknown;

      expect(Array.isArray(input)).toBe(true);
      const messages = input as Array<Record<string, unknown>>;
      expect(messages).toHaveLength(1);
      expect(messages[0]?.role).toBe("user");

      const contentParts = messages[0]?.content as Array<
        Record<string, unknown>
      >;
      expect(Array.isArray(contentParts)).toBe(true);
      expect(contentParts.some((part) => part.type === "text")).toBe(true);
      expect(contentParts.some((part) => part.type === "image")).toBe(true);
      expect(contentParts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "image",
            image: "data:image/png;base64,AAAA",
            mediaType: "image/png",
          }),
        ]),
      );
    } finally {
      await stopServer(server);
    }
  });

  it("emits actionable OpenRouter auth errors in stream mode", async () => {
    mockCreateCodingAgent.mockResolvedValueOnce({
      generate: jest.fn(async () => ({
        text: "fallback",
        steps: [],
        toolCalls: [],
      })),
      stream: jest.fn(async () => {
        const error = new Error("User not found.");
        (error as Error & { data?: unknown }).data = {
          error: { code: "401", message: "User not found." },
        };
        throw error;
      }),
    });

    const { server, baseUrl } = await startServer();

    try {
      const response = await postStreaming(baseUrl, "/api/agent/chat", {
        message: "hello",
        modelId: "openrouter/openai/gpt-5.3-codex",
        workspaceRoot: "/tmp/openrouter-stream-auth",
        isTauri: false,
        stream: true,
      });

      expect(response.status).toBe(200);
      expect(response.contentType).toContain("text/event-stream");
      expect(response.body).toContain("event: error");
      expect(response.body).toContain(
        "OpenRouter rejected the configured API key. Replace OPENROUTER_API_KEY in Settings and click Save & Activate Keys.",
      );
    } finally {
      await stopServer(server);
    }
  });
});
