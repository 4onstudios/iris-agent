import express from "express";
import http from "http";
import os from "os";
import path from "path";
import fs from "fs/promises";

const mockCreateCodingAgent = jest.fn();
const mockGenerate = jest.fn();

const runStorePath = path.join(
  os.tmpdir(),
  `iris-agent-runs-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  `iris-agent-runs-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
);
process.env.IRIS_AGENT_RUNS_DB_PATH = runStorePath;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  safePersistRunLifecycleEvent,
  requestRunCancellation,
  getRunSnapshot,
  listRunEvents,
} = require("../api/data/runStore");

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

type RequestResult = { status: number; body: any };

const requestJson = async (
  baseUrl: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  apiPath: string,
  payload?: Record<string, unknown>,
  headers?: Record<string, string>,
): Promise<RequestResult> => {
  const url = new URL(`${baseUrl}${apiPath}`);
  const body = payload ? JSON.stringify(payload) : "";

  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method,
        headers: payload
          ? {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(body).toString(),
              ...(headers || {}),
            }
          : headers,
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
    if (payload) {
      req.write(body);
    }
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
        async cancel() {
          return undefined;
        },
      };
    },
  };
};

describe("agent run lifecycle APIs", () => {
  beforeEach(() => {
    mockGenerate.mockReset();
    mockCreateCodingAgent.mockReset();

    mockGenerate.mockResolvedValue({
      text: "ok",
      steps: [],
      toolCalls: [],
    });

    mockCreateCodingAgent.mockResolvedValue({
      generate: mockGenerate,
    });
  });

  afterAll(async () => {
    try {
      await fs.rm(path.dirname(runStorePath), { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  });

  it("creates the configured run store parent directory", async () => {
    const { server, baseUrl } = await startServer();

    try {
      const parentDir = path.dirname(runStorePath);
      await expect(fs.stat(parentDir)).rejects.toThrow();

      const chatResponse = await requestJson(baseUrl, "POST", "/api/agent/chat", {
        message: "initialize run store",
        modelId: "gpt-4o",
        workspaceRoot: "/tmp/run-lifecycle",
        isTauri: false,
      });

      expect(chatResponse.status).toBe(200);
      const stat = await fs.stat(parentDir);
      expect(stat.isDirectory()).toBe(true);
    } finally {
      await stopServer(server);
    }
  });

  it("returns run snapshot and replay events", async () => {
    const { server, baseUrl } = await startServer();

    try {
      const chatResponse = await requestJson(baseUrl, "POST", "/api/agent/chat", {
        message: "check lifecycle",
        modelId: "gpt-4o",
        workspaceRoot: "/tmp/run-lifecycle",
        isTauri: false,
      });

      expect(chatResponse.status).toBe(200);
      expect(chatResponse.body.success).toBe(true);
      expect(typeof chatResponse.body.runId).toBe("string");

      const runId = String(chatResponse.body.runId);

      const snapshot = await requestJson(baseUrl, "GET", `/api/agent/runs/${runId}`);
      expect(snapshot.status).toBe(200);
      expect(snapshot.body.success).toBe(true);
      expect(snapshot.body.run).toMatchObject({
        runId,
        lifecycleState: "succeeded",
        stopReason: "completed",
      });
      expect(snapshot.body.latestCheckpoint).toBeTruthy();

      const events = await requestJson(
        baseUrl,
        "GET",
        `/api/agent/runs/${runId}/events?afterSequence=0&limit=200`,
      );
      expect(events.status).toBe(200);
      expect(events.body.success).toBe(true);
      expect(events.body.runId).toBe(runId);
      expect(Array.isArray(events.body.events)).toBe(true);
      expect(events.body.events.length).toBeGreaterThan(0);

      const eventTypes = events.body.events.map((event: { eventType: string }) => event.eventType);
      expect(eventTypes).toContain("request_received");
      expect(eventTypes).toContain("response_ready");
    } finally {
      await stopServer(server);
    }
  });

  it("persists detailed tool actions for replay clients", async () => {
    mockGenerate.mockResolvedValueOnce({
      text: "Found the requested code.",
      steps: [
        {
          content: [
            {
              type: "tool-call",
              toolName: "readFile",
              toolCallId: "read-1",
              args: { filePath: "src/index.ts", startLine: 1, endLine: 20 },
            },
            {
              type: "tool-result",
              toolName: "readFile",
              toolCallId: "read-1",
              result: {
                success: true,
                filePath: "src/index.ts",
                content: "export const answer = 42;",
              },
            },
            {
              type: "tool-call",
              toolName: "grepSearch",
              toolCallId: "search-1",
              args: { searchText: "answer", filePattern: "src/**/*.ts" },
            },
          ],
          toolCalls: [],
        },
      ],
      toolCalls: [],
    });

    const { server, baseUrl } = await startServer();

    try {
      const chatResponse = await requestJson(baseUrl, "POST", "/api/agent/chat", {
        message: "Inspect the source",
        modelId: "gpt-4o",
        workspaceRoot: "/tmp/run-lifecycle",
        isTauri: false,
      });
      expect(chatResponse.status).toBe(200);

      const eventsResponse = await requestJson(
        baseUrl,
        "GET",
        `/api/agent/runs/${chatResponse.body.runId}/events`,
      );
      expect(eventsResponse.status).toBe(200);

      const actionEvents = eventsResponse.body.events.filter(
        (event: { eventType: string }) =>
          event.eventType === "tool_call" || event.eventType === "tool_result",
      );
      expect(
        actionEvents.map(
          (event: { eventType: string; payload: { name: string } }) =>
            `${event.eventType}:${event.payload.name}`,
        ),
      ).toEqual(["tool_result:readFile", "tool_call:grepSearch"]);

      expect(eventsResponse.body.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            eventType: "tool_call",
            payload: {
              name: "grepSearch",
              toolName: "grepSearch",
              args: {
                searchText: "answer",
                filePattern: "src/**/*.ts",
              },
              toolCallId: "search-1",
              status: "pending",
            },
          }),
          expect.objectContaining({
            eventType: "tool_result",
            payload: {
              name: "readFile",
              toolName: "readFile",
              args: {
                filePath: "src/index.ts",
                startLine: 1,
                endLine: 20,
              },
              result: {
                success: true,
                filePath: "src/index.ts",
                content: "export const answer = 42;",
              },
              toolCallId: "read-1",
              status: "completed",
            },
          }),
        ]),
      );
    } finally {
      await stopServer(server);
    }
  });

  it("normalizes legacy persisted tool action names for replay clients", async () => {
    const runId = `run-legacy-tool-action-${Date.now()}`;
    await safePersistRunLifecycleEvent({
      runId,
      lifecycleState: "succeeded",
      stopReason: "completed",
      eventType: "tool_result",
      payload: {
        toolName: "readFile",
        args: { filePath: "src/legacy.ts" },
        result: { success: true, content: "legacy contents" },
        status: "completed",
      },
    });

    const { server, baseUrl } = await startServer();

    try {
      const eventsResponse = await requestJson(
        baseUrl,
        "GET",
        `/api/agent/runs/${runId}/events`,
      );
      expect(eventsResponse.status).toBe(200);
      expect(eventsResponse.body.events).toEqual([
        expect.objectContaining({
          eventType: "tool_result",
          payload: {
            name: "readFile",
            toolName: "readFile",
            args: { filePath: "src/legacy.ts" },
            result: { success: true, content: "legacy contents" },
            status: "completed",
          },
        }),
      ]);

      const snapshotResponse = await requestJson(
        baseUrl,
        "GET",
        `/api/agent/runs/${runId}`,
      );
      expect(snapshotResponse.status).toBe(200);
      expect(snapshotResponse.body.latestCheckpoint.payload).toMatchObject({
        name: "readFile",
        toolName: "readFile",
      });
    } finally {
      await stopServer(server);
    }
  });

  it("persists bounded streaming results with the matching call arguments", async () => {
    const largeContent = "x".repeat(20 * 1024);
    const largeError = "failed: ".concat("E".repeat(2 * 1024 * 1024));
    const runId = `run-stream-result-${Date.now()}`;
    mockCreateCodingAgent.mockResolvedValueOnce({
      generate: mockGenerate,
      stream: jest.fn(async () => ({
        fullStream: createMockFullStream([
          {
            type: "tool-call",
            payload: {
              toolName: "readFile",
              toolCallId: "stream-read-1",
              args: {
                filePath: "src/large.ts",
                startLine: 10,
                endLine: 20,
              },
            },
          },
          {
            type: "tool-result",
            payload: {
              toolName: "readFile",
              toolCallId: "stream-read-1",
              result: {
                success: false,
                error: largeError,
                content: largeContent,
              },
            },
          },
        ]),
        text: Promise.resolve("Read complete."),
        toolCalls: Promise.resolve([]),
        steps: Promise.resolve([]),
      })),
    });

    const { server, baseUrl } = await startServer();

    try {
      const chatResponse = await requestJson(baseUrl, "POST", "/api/agent/chat", {
        runId,
        message: "Read the large source file",
        modelId: "gpt-4o",
        workspaceRoot: `/tmp/stream-persistence-${runId}`,
        isTauri: false,
        stream: true,
      });
      expect(chatResponse.status).toBe(200);

      const eventsResponse = await requestJson(
        baseUrl,
        "GET",
        `/api/agent/runs/${runId}/events`,
      );
      expect(eventsResponse.status).toBe(200);
      const persistedResultEvent = eventsResponse.body.events.find(
        (event: { eventType: string; payload?: { name?: string } }) =>
          event.eventType === "tool_result" &&
          event.payload?.name === "readFile",
      );
      expect(persistedResultEvent).toBeDefined();
      const serializedPersistedResult = JSON.stringify(
        persistedResultEvent.payload.result,
      );
      expect(
        Buffer.byteLength(serializedPersistedResult, "utf8"),
      ).toBeLessThanOrEqual(16 * 1024);
      expect(
        persistedResultEvent.payload.result.error.length,
      ).toBeLessThanOrEqual(1024);
      expect(eventsResponse.body.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            eventType: "tool_result",
            payload: expect.objectContaining({
              name: "readFile",
              args: {
                filePath: "src/large.ts",
                startLine: 10,
                endLine: 20,
              },
              result: expect.objectContaining({
                truncated: true,
                originalByteLength: expect.any(Number),
                success: false,
              }),
            }),
          }),
        ]),
      );
    } finally {
      await stopServer(server);
    }
  });

  it("summarizes tool results with no JSON representation before persistence", async () => {
    const runId = `run-no-json-result-${Date.now()}`;
    mockGenerate.mockResolvedValueOnce({
      text: "Handled missing result.",
      steps: [
        {
          content: [
            {
              type: "tool-call",
              toolName: "readFile",
              toolCallId: "missing-result-1",
              args: { filePath: "src/missing.ts" },
            },
            {
              type: "tool-result",
              toolName: "readFile",
              toolCallId: "missing-result-1",
              result: undefined,
            },
          ],
          toolCalls: [],
        },
      ],
      toolCalls: [],
    });

    const { server, baseUrl } = await startServer();

    try {
      const chatResponse = await requestJson(baseUrl, "POST", "/api/agent/chat", {
        runId,
        message: "Read a file with no result",
        modelId: "gpt-4o",
        workspaceRoot: `/tmp/no-json-result-${runId}`,
        isTauri: false,
      });
      expect(chatResponse.status).toBe(200);

      const eventsResponse = await requestJson(
        baseUrl,
        "GET",
        `/api/agent/runs/${runId}/events`,
      );
      expect(eventsResponse.status).toBe(200);
      expect(eventsResponse.body.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            eventType: "tool_result",
            payload: expect.objectContaining({
              name: "readFile",
              args: { filePath: "src/missing.ts" },
              result: {
                truncated: true,
                reason: "Tool result has no JSON representation for persistence",
              },
            }),
          }),
        ]),
      );
    } finally {
      await stopServer(server);
    }
  });

  it("bounds persisted tool arguments while preserving useful metadata", async () => {
    const runId = `run-large-args-${Date.now()}`;
    mockGenerate.mockResolvedValueOnce({
      text: "Wrote file.",
      steps: [
        {
          content: [
            {
              type: "tool-call",
              toolName: "writeFile",
              toolCallId: "write-large-args-1",
              args: {
                filePath: "src/large.ts",
                content: "x".repeat(128 * 1024),
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
      const chatResponse = await requestJson(baseUrl, "POST", "/api/agent/chat", {
        runId,
        message: "Write a large file",
        modelId: "gpt-4o",
        workspaceRoot: `/tmp/large-args-${runId}`,
        isTauri: false,
      });
      expect(chatResponse.status).toBe(200);

      const eventsResponse = await requestJson(
        baseUrl,
        "GET",
        `/api/agent/runs/${runId}/events`,
      );
      expect(eventsResponse.status).toBe(200);
      const toolCall = eventsResponse.body.events.find(
        (event: { eventType: string }) => event.eventType === "tool_call",
      );
      expect(toolCall.payload.args).toEqual(
        expect.objectContaining({
          truncated: true,
          originalByteLength: expect.any(Number),
          filePath: "src/large.ts",
        }),
      );
      expect(
        Buffer.byteLength(JSON.stringify(toolCall.payload.args), "utf8"),
      ).toBeLessThanOrEqual(16 * 1024);
    } finally {
      await stopServer(server);
    }
  });

  it("sanitizes workspace-only arguments before persisting stream actions", async () => {
    const runId = `run-web-workspace-args-${Date.now()}`;
    mockCreateCodingAgent.mockResolvedValueOnce({
      generate: mockGenerate,
      stream: jest.fn(async () => ({
        fullStream: createMockFullStream([
          {
            type: "tool-call",
            payload: {
              toolName: "getWorkspaceInfo",
              toolCallId: "workspace-info-1",
              args: {
                workspacePath: "/workspace/project",
                includeFiles: true,
              },
            },
          },
        ]),
        text: Promise.resolve("Workspace inspected."),
        toolCalls: Promise.resolve([]),
        steps: Promise.resolve([]),
      })),
    });

    const { server, baseUrl } = await startServer();

    try {
      const chatResponse = await requestJson(baseUrl, "POST", "/api/agent/chat", {
        runId,
        message: "Inspect the web workspace",
        modelId: "gpt-4o",
        workspaceRoot: "/workspace/project",
        isTauri: false,
        stream: true,
      });
      expect(chatResponse.status).toBe(200);

      const eventsResponse = await requestJson(
        baseUrl,
        "GET",
        `/api/agent/runs/${runId}/events`,
      );
      expect(eventsResponse.status).toBe(200);
      const toolCall = eventsResponse.body.events.find(
        (event: { eventType: string }) => event.eventType === "tool_call",
      );
      expect(toolCall.payload.args).toEqual({ includeFiles: true });
    } finally {
      await stopServer(server);
    }
  });

  it("recovers anonymous non-stream result arguments one-for-one", async () => {
    const runId = `run-anonymous-non-stream-results-${Date.now()}`;
    mockGenerate.mockResolvedValueOnce({
      text: "Read both files.",
      steps: [
        {
          content: [
            {
              type: "tool-call",
              toolName: "readFile",
              args: { filePath: "src/first.ts" },
            },
            {
              type: "tool-call",
              toolName: "readFile",
              args: { filePath: "src/second.ts" },
            },
            {
              type: "tool-result",
              toolName: "readFile",
              result: { success: true, content: "first" },
            },
            {
              type: "tool-result",
              toolName: "readFile",
              result: { success: true, content: "second" },
            },
          ],
          toolCalls: [],
        },
      ],
      toolCalls: [],
    });

    const { server, baseUrl } = await startServer();

    try {
      const chatResponse = await requestJson(baseUrl, "POST", "/api/agent/chat", {
        runId,
        message: "Read both files",
        modelId: "gpt-4o",
        workspaceRoot: `/tmp/anonymous-non-stream-${runId}`,
        isTauri: false,
      });
      expect(chatResponse.status).toBe(200);

      const eventsResponse = await requestJson(
        baseUrl,
        "GET",
        `/api/agent/runs/${runId}/events`,
      );
      expect(eventsResponse.status).toBe(200);
      const persistedResults = eventsResponse.body.events
        .filter((event: { eventType: string }) => event.eventType === "tool_result")
        .map((event: { payload: { args: unknown } }) => event.payload.args);
      expect(persistedResults).toEqual([
        { filePath: "src/first.ts" },
        { filePath: "src/second.ts" },
      ]);
    } finally {
      await stopServer(server);
    }
  });

  it("consumes anonymous streaming call arguments for each omitted-args result", async () => {
    const runId = `run-anonymous-stream-results-${Date.now()}`;
    mockCreateCodingAgent.mockResolvedValueOnce({
      generate: mockGenerate,
      stream: jest.fn(async () => ({
        fullStream: createMockFullStream([
          {
            type: "tool-call",
            payload: {
              toolName: "readFile",
              args: { filePath: "src/first.ts" },
            },
          },
          {
            type: "tool-call",
            payload: {
              toolName: "readFile",
              args: { filePath: "src/second.ts" },
            },
          },
          {
            type: "tool-result",
            payload: {
              toolName: "readFile",
              result: { success: true, content: "first" },
            },
          },
          {
            type: "tool-result",
            payload: {
              toolName: "readFile",
              result: { success: true, content: "second" },
            },
          },
        ]),
        text: Promise.resolve("Read both files."),
        toolCalls: Promise.resolve([]),
        steps: Promise.resolve([]),
      })),
    });

    const { server, baseUrl } = await startServer();

    try {
      const chatResponse = await requestJson(baseUrl, "POST", "/api/agent/chat", {
        runId,
        message: "Read both files",
        modelId: "gpt-4o",
        workspaceRoot: `/tmp/anonymous-stream-${runId}`,
        isTauri: false,
        stream: true,
      });
      expect(chatResponse.status).toBe(200);

      const eventsResponse = await requestJson(
        baseUrl,
        "GET",
        `/api/agent/runs/${runId}/events`,
      );
      expect(eventsResponse.status).toBe(200);
      const persistedResults = eventsResponse.body.events
        .filter((event: { eventType: string }) => event.eventType === "tool_result")
        .map((event: { payload: { args: unknown } }) => event.payload.args);
      expect(persistedResults).toEqual([
        { filePath: "src/first.ts" },
        { filePath: "src/second.ts" },
      ]);
    } finally {
      await stopServer(server);
    }
  });

  it("matches anonymous streaming results with explicit args before FIFO fallback", async () => {
    const runId = `run-anonymous-stream-explicit-args-${Date.now()}`;
    mockCreateCodingAgent.mockResolvedValueOnce({
      generate: mockGenerate,
      stream: jest.fn(async () => ({
        fullStream: createMockFullStream([
          {
            type: "tool-call",
            payload: {
              toolName: "readFile",
              args: { filePath: "src/first.ts" },
            },
          },
          {
            type: "tool-call",
            payload: {
              toolName: "readFile",
              args: { filePath: "src/second.ts" },
            },
          },
          {
            type: "tool-result",
            payload: {
              toolName: "readFile",
              args: { filePath: "src/second.ts" },
              result: { success: true, content: "second" },
            },
          },
          {
            type: "tool-result",
            payload: {
              toolName: "readFile",
              args: { filePath: "src/first.ts" },
              result: { success: true, content: "first" },
            },
          },
        ]),
        text: Promise.resolve("Read both files."),
        toolCalls: Promise.resolve([]),
        steps: Promise.resolve([]),
      })),
    });

    const { server, baseUrl } = await startServer();

    try {
      const chatResponse = await requestJson(baseUrl, "POST", "/api/agent/chat", {
        runId,
        message: "Read both files",
        modelId: "gpt-4o",
        workspaceRoot: `/tmp/anonymous-stream-explicit-${runId}`,
        isTauri: false,
        stream: true,
      });
      expect(chatResponse.status).toBe(200);

      const eventsResponse = await requestJson(
        baseUrl,
        "GET",
        `/api/agent/runs/${runId}/events`,
      );
      expect(eventsResponse.status).toBe(200);
      const persistedResults = eventsResponse.body.events
        .filter((event: { eventType: string }) => event.eventType === "tool_result")
        .map((event: { payload: { args: unknown } }) => event.payload.args);
      expect(persistedResults).toEqual([
        { filePath: "src/second.ts" },
        { filePath: "src/first.ts" },
      ]);
    } finally {
      await stopServer(server);
    }
  });

  it("persists streaming result chunks in source order", async () => {
    const runId = `run-stream-result-order-${Date.now()}`;
    mockCreateCodingAgent.mockResolvedValueOnce({
      generate: mockGenerate,
      stream: jest.fn(async () => ({
        fullStream: createMockFullStream([
          {
            type: "tool-call",
            payload: {
              toolName: "readFile",
              toolCallId: "read-a",
              args: { filePath: "src/a.ts" },
            },
          },
          {
            type: "tool-result",
            payload: {
              toolName: "readFile",
              toolCallId: "read-a",
              result: { success: true, content: "a" },
            },
          },
          {
            type: "tool-call",
            payload: {
              toolName: "readFile",
              toolCallId: "read-b",
              args: { filePath: "src/b.ts" },
            },
          },
          {
            type: "tool-result",
            payload: {
              toolName: "readFile",
              toolCallId: "read-b",
              result: { success: true, content: "b" },
            },
          },
        ]),
        text: Promise.resolve("Read both files."),
        toolCalls: Promise.resolve([]),
        steps: Promise.resolve([]),
      })),
    });

    const { server, baseUrl } = await startServer();

    try {
      const chatResponse = await requestJson(baseUrl, "POST", "/api/agent/chat", {
        runId,
        message: "Read files",
        modelId: "gpt-4o",
        workspaceRoot: `/tmp/stream-result-order-${runId}`,
        isTauri: false,
        stream: true,
      });
      expect(chatResponse.status).toBe(200);

      const eventsResponse = await requestJson(
        baseUrl,
        "GET",
        `/api/agent/runs/${runId}/events`,
      );
      expect(eventsResponse.status).toBe(200);
      const actionOrder = eventsResponse.body.events
        .filter((event: { eventType: string }) =>
          ["tool_call", "tool_result"].includes(event.eventType),
        )
        .map(
          (event: {
            eventType: string;
            payload: { toolCallId?: string };
          }) => `${event.eventType}:${event.payload.toolCallId}`,
        );
      expect(actionOrder).toEqual([
        "tool_call:read-a",
        "tool_result:read-a",
        "tool_call:read-b",
        "tool_result:read-b",
      ]);
    } finally {
      await stopServer(server);
    }
  });

  it("persists reconciled stream step results missing from raw chunks", async () => {
    const runId = `run-reconciled-stream-results-${Date.now()}`;
    mockCreateCodingAgent.mockResolvedValueOnce({
      generate: mockGenerate,
      stream: jest.fn(async () => ({
        fullStream: createMockFullStream([
          {
            type: "tool-call",
            payload: {
              toolName: "editFile",
              toolCallId: "stream-edit-1",
              args: { filePath: "src/final.ts" },
            },
          },
        ]),
        text: Promise.resolve("Edited file."),
        toolCalls: Promise.resolve([]),
        steps: Promise.resolve([
          {
            content: [
              {
                type: "tool-call",
                toolName: "editFile",
                toolCallId: "stream-edit-1",
                args: { filePath: "src/final.ts" },
              },
              {
                type: "tool-result",
                toolName: "editFile",
                toolCallId: "stream-edit-1",
                result: { success: true, diff: "patched" },
              },
            ],
            toolCalls: [],
          },
        ]),
      })),
    });

    const { server, baseUrl } = await startServer();

    try {
      const chatResponse = await requestJson(baseUrl, "POST", "/api/agent/chat", {
        runId,
        message: "Edit file",
        modelId: "gpt-4o",
        workspaceRoot: `/tmp/reconciled-stream-${runId}`,
        isTauri: false,
        stream: true,
      });
      expect(chatResponse.status).toBe(200);

      const eventsResponse = await requestJson(
        baseUrl,
        "GET",
        `/api/agent/runs/${runId}/events`,
      );
      expect(eventsResponse.status).toBe(200);
      const toolCalls = eventsResponse.body.events.filter(
        (event: { eventType: string }) => event.eventType === "tool_call",
      );
      const toolResults = eventsResponse.body.events.filter(
        (event: { eventType: string }) => event.eventType === "tool_result",
      );
      expect(toolCalls).toHaveLength(1);
      expect(toolResults).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({
            name: "editFile",
            args: { filePath: "src/final.ts" },
            result: { success: true, diff: "patched" },
            toolCallId: "stream-edit-1",
          }),
        }),
      ]);
    } finally {
      await stopServer(server);
    }
  });

  it("preserves actions from every reflection attempt in the replay timeline", async () => {
    const runId = `run-reflection-actions-${Date.now()}`;
    mockGenerate
      .mockResolvedValueOnce({
        text: "Initial validation failed.",
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
        text: "Repaired.",
        steps: [
          {
            content: [
              {
                type: "tool-call",
                toolName: "editFile",
                args: { filePath: "src/fixed.ts" },
              },
              {
                type: "tool-result",
                toolName: "editFile",
                result: { success: true },
              },
            ],
            toolCalls: [],
          },
        ],
        toolCalls: [],
      });

    const { server, baseUrl } = await startServer();

    try {
      const chatResponse = await requestJson(baseUrl, "POST", "/api/agent/chat", {
        runId,
        message: "Repair the validation error",
        modelId: "gpt-4o",
        workspaceRoot: `/tmp/reflection-persistence-${runId}`,
        isTauri: false,
      });
      expect(chatResponse.status).toBe(200);

      const eventsResponse = await requestJson(
        baseUrl,
        "GET",
        `/api/agent/runs/${runId}/events`,
      );
      const toolResults = eventsResponse.body.events.filter(
        (event: { eventType: string }) => event.eventType === "tool_result",
      );
      expect(toolResults).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            payload: expect.objectContaining({ name: "writeFile" }),
          }),
          expect.objectContaining({
            payload: expect.objectContaining({
              name: "editFile",
              args: { filePath: "src/fixed.ts" },
            }),
          }),
        ]),
      );
    } finally {
      await stopServer(server);
    }
  });

  it("rejects invalid client-provided run ids on chat requests", async () => {
    const { server, baseUrl } = await startServer();

    try {
      const invalidRunId = "x".repeat(161);
      const response = await requestJson(baseUrl, "POST", "/api/agent/chat", {
        runId: invalidRunId,
        message: "check lifecycle",
        modelId: "gpt-4o",
        workspaceRoot: "/tmp/run-lifecycle",
        isTauri: false,
      });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        success: false,
        error: "Invalid run id",
      });
      expect(mockGenerate).not.toHaveBeenCalled();
    } finally {
      await stopServer(server);
    }
  });

  it("supports cancellation request and cooperative cancellation", async () => {
    const { server, baseUrl } = await startServer();

    try {
      const runId = "run-cancel-case";

      const initial = await requestJson(baseUrl, "POST", "/api/agent/chat", {
        runId,
        message: "create run",
        modelId: "gpt-4o",
        workspaceRoot: "/tmp/run-lifecycle",
        isTauri: false,
      });
      expect(initial.status).toBe(200);
      expect(initial.body.success).toBe(true);

      const cancelResponse = await requestJson(
        baseUrl,
        "POST",
        `/api/agent/runs/${runId}/cancel`,
      );
      expect(cancelResponse.status).toBe(200);
      expect(cancelResponse.body.success).toBe(true);
      expect(cancelResponse.body.runId).toBe(runId);
      expect(cancelResponse.body.cancelRequested).toBe(true);

      mockGenerate.mockClear();

      const cancelledAttempt = await requestJson(baseUrl, "POST", "/api/agent/chat", {
        runId,
        message: "should cancel",
        modelId: "gpt-4o",
        workspaceRoot: "/tmp/run-lifecycle",
        isTauri: false,
      });

      expect(cancelledAttempt.status).toBe(409);
      expect(cancelledAttempt.body.success).toBe(false);
      expect(cancelledAttempt.body.runId).toBe(runId);
      expect(cancelledAttempt.body.lifecycleState).toBe("cancelled");
      expect(cancelledAttempt.body.stopReason).toBe("cancelled");
      expect(mockGenerate).not.toHaveBeenCalled();

      const snapshot = await requestJson(baseUrl, "GET", `/api/agent/runs/${runId}`);
      expect(snapshot.status).toBe(200);
      expect(snapshot.body.run).toMatchObject({
        runId,
        lifecycleState: "cancelled",
        stopReason: "cancelled",
        cancelRequested: true,
      });
    } finally {
      await stopServer(server);
    }
  });

  it("settles a non-stream prompt when cancellation is requested during a stalled model response", async () => {
    const { server, baseUrl } = await startServer();

    try {
      const runId = "run-cancel-stalled-model";
      let receivedAbortSignal: AbortSignal | undefined;
      mockGenerate.mockImplementation(
        async (_prompt: unknown, options?: Record<string, unknown>) => {
          const signal =
            options?.abortSignal instanceof AbortSignal
              ? options.abortSignal
              : undefined;
          receivedAbortSignal = signal;
          return await new Promise<never>(() => undefined);
        },
      );

      const pendingChatResponse = requestJson(baseUrl, "POST", "/api/agent/chat", {
        runId,
        message: "wait for model forever",
        modelId: "gpt-4o",
        workspaceRoot: "/tmp/run-lifecycle",
        isTauri: false,
      });

      for (let attempt = 0; attempt < 20; attempt += 1) {
        const snapshot = await getRunSnapshot(runId);
        if (snapshot) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      const cancelResponse = await requestJson(
        baseUrl,
        "POST",
        `/api/agent/runs/${runId}/cancel`,
      );
      expect(cancelResponse.status).toBe(200);
      expect(cancelResponse.body.success).toBe(true);

      const timedResponse = await Promise.race([
        pendingChatResponse,
        new Promise<RequestResult>((_, reject) =>
          setTimeout(
            () => reject(new Error("Chat request did not settle after cancellation")),
            600,
          ),
        ),
      ]);

      expect(timedResponse.status).toBe(409);
      expect(timedResponse.body).toMatchObject({
        success: false,
        runId,
        lifecycleState: "cancelled",
        stopReason: "cancelled",
        error: "Run was cancelled",
      });
      expect(receivedAbortSignal).toBeDefined();
      expect(receivedAbortSignal?.aborted).toBe(true);
    } finally {
      await stopServer(server);
    }
  });

  it("settles a non-stream prompt when cancellation is requested during stalled backend synthesis", async () => {
    const { server, baseUrl } = await startServer();

    try {
      const runId = "run-cancel-stalled-synthesis";
      let receivedSynthesisAbortSignal: AbortSignal | undefined;
      mockGenerate
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
        .mockImplementationOnce(
          async (_prompt: unknown, options?: Record<string, unknown>) => {
            const signal =
              options?.abortSignal instanceof AbortSignal
                ? options.abortSignal
                : undefined;
            receivedSynthesisAbortSignal = signal;
            return await new Promise<never>(() => undefined);
          },
        );

      const pendingChatResponse = requestJson(baseUrl, "POST", "/api/agent/chat", {
        runId,
        message: "synthesize from tool output",
        modelId: "gpt-4o",
        workspaceRoot: "/tmp/run-lifecycle",
        isTauri: false,
        maxSteps: 2,
      });

      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (receivedSynthesisAbortSignal) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(receivedSynthesisAbortSignal).toBeDefined();

      const cancelResponse = await requestJson(
        baseUrl,
        "POST",
        `/api/agent/runs/${runId}/cancel`,
      );
      expect(cancelResponse.status).toBe(200);
      expect(cancelResponse.body.success).toBe(true);

      const timedResponse = await Promise.race([
        pendingChatResponse,
        new Promise<RequestResult>((_, reject) =>
          setTimeout(
            () =>
              reject(new Error("Chat request did not settle during stalled synthesis cancellation")),
            800,
          ),
        ),
      ]);

      expect(timedResponse.status).toBe(409);
      expect(timedResponse.body).toMatchObject({
        success: false,
        runId,
        lifecycleState: "cancelled",
        stopReason: "cancelled",
        error: "Run was cancelled",
      });
      expect(receivedSynthesisAbortSignal?.aborted).toBe(true);
    } finally {
      await stopServer(server);
    }
  });

  it("settles a non-stream prompt when cancellation is requested during stalled reflection", async () => {
    const { server, baseUrl } = await startServer();

    try {
      const runId = "run-cancel-stalled-reflection";
      let receivedReflectionAbortSignal: AbortSignal | undefined;
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
        .mockImplementationOnce(
          async (_prompt: unknown, options?: Record<string, unknown>) => {
            const signal =
              options?.abortSignal instanceof AbortSignal
                ? options.abortSignal
                : undefined;
            receivedReflectionAbortSignal = signal;
            return await new Promise<never>(() => undefined);
          },
        );

      const pendingChatResponse = requestJson(baseUrl, "POST", "/api/agent/chat", {
        runId,
        message: "repair lint issues",
        modelId: "gpt-4o",
        workspaceRoot: "/tmp/run-lifecycle",
        isTauri: false,
      });

      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (receivedReflectionAbortSignal) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(receivedReflectionAbortSignal).toBeDefined();

      const cancelResponse = await requestJson(
        baseUrl,
        "POST",
        `/api/agent/runs/${runId}/cancel`,
      );
      expect(cancelResponse.status).toBe(200);
      expect(cancelResponse.body.success).toBe(true);

      const timedResponse = await Promise.race([
        pendingChatResponse,
        new Promise<RequestResult>((_, reject) =>
          setTimeout(
            () =>
              reject(new Error("Chat request did not settle during stalled reflection cancellation")),
            800,
          ),
        ),
      ]);

      expect(timedResponse.status).toBe(409);
      expect(timedResponse.body).toMatchObject({
        success: false,
        runId,
        lifecycleState: "cancelled",
        stopReason: "cancelled",
        error: "Run was cancelled",
      });
      expect(receivedReflectionAbortSignal?.aborted).toBe(true);

      const eventsResponse = await requestJson(
        baseUrl,
        "GET",
        `/api/agent/runs/${runId}/events`,
      );
      expect(eventsResponse.status).toBe(200);
      expect(eventsResponse.body.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            eventType: "tool_result",
            payload: expect.objectContaining({ name: "writeFile" }),
          }),
        ]),
      );
    } finally {
      await stopServer(server);
    }
  });

  it("deleting a chat session also deletes related run lifecycle data", async () => {
    const { server, baseUrl } = await startServer();
    const previousTauriBundled = process.env.TAURI_BUNDLED;
    const previousDesktopToken = process.env.IRIS_DESKTOP_TOKEN;

    try {
      const chatResponse = await requestJson(baseUrl, "POST", "/api/agent/chat", {
        message: "session-linked run",
        modelId: "gpt-4o",
        workspaceRoot: "/tmp/run-lifecycle",
        isTauri: false,
      });

      expect(chatResponse.status).toBe(200);
      expect(chatResponse.body.success).toBe(true);
      const runId = String(chatResponse.body.runId || "");
      expect(runId.length).toBeGreaterThan(0);

      const sessionId = "session-linked-run-cleanup";
      process.env.TAURI_BUNDLED = "1";
      process.env.IRIS_DESKTOP_TOKEN = "test-desktop-token";
      const desktopHeaders = {
        "x-desktop-token": "test-desktop-token",
      };

      const putSession = await requestJson(
        baseUrl,
        "PUT",
        `/api/agent/chat-sessions/${sessionId}`,
        {
          id: sessionId,
          title: "Session with run",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          messages: [
            {
              role: "assistant",
              message: "stored",
              runId,
            },
          ],
        },
        desktopHeaders,
      );
      expect(putSession.status).toBe(200);
      expect(putSession.body.success).toBe(true);

      const deleteSession = await requestJson(
        baseUrl,
        "DELETE",
        `/api/agent/chat-sessions/${sessionId}`,
        undefined,
        desktopHeaders,
      );
      expect(deleteSession.status).toBe(200);
      expect(deleteSession.body.success).toBe(true);

      const runSnapshotAfterDelete = await requestJson(
        baseUrl,
        "GET",
        `/api/agent/runs/${runId}`,
      );
      expect(runSnapshotAfterDelete.status).toBe(404);
      expect(runSnapshotAfterDelete.body).toMatchObject({
        success: false,
        error: "Run not found",
      });
    } finally {
      if (previousTauriBundled === undefined) {
        delete process.env.TAURI_BUNDLED;
      } else {
        process.env.TAURI_BUNDLED = previousTauriBundled;
      }

      if (previousDesktopToken === undefined) {
        delete process.env.IRIS_DESKTOP_TOKEN;
      } else {
        process.env.IRIS_DESKTOP_TOKEN = previousDesktopToken;
      }

      await stopServer(server);
    }
  });

  it("persists overlapping lifecycle and cancellation writes without transaction errors", async () => {
    const runId = `run-concurrent-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    await safePersistRunLifecycleEvent({
      runId,
      lifecycleState: "queued",
      stopReason: "none",
      eventType: "request_received",
      payload: { phase: "seed" },
      objective: "concurrency test",
      workspacePath: "/tmp/run-lifecycle",
      modelId: "gpt-4o",
    });

    const overlappingLifecycleWrites = Array.from({ length: 12 }, (_, index) =>
      safePersistRunLifecycleEvent({
        runId,
        lifecycleState: "running",
        stopReason: "none",
        eventType: `concurrent_write_${index}`,
        payload: { index },
      }),
    );

    const overlappingCancellationWrites = Array.from({ length: 6 }, () =>
      requestRunCancellation(runId),
    );

    await expect(
      Promise.all([...overlappingLifecycleWrites, ...overlappingCancellationWrites]),
    ).resolves.toBeTruthy();

    await safePersistRunLifecycleEvent({
      runId,
      lifecycleState: "succeeded",
      stopReason: "completed",
      eventType: "response_ready",
      payload: { phase: "finalize" },
    });

    const snapshot = await getRunSnapshot(runId);
    expect(snapshot).toBeTruthy();
    expect(snapshot.run).toMatchObject({
      run_id: runId,
      stop_reason: "completed",
      cancel_requested: 1,
    });

    const events = await listRunEvents(runId, 0, 200);
    expect(events.length).toBe(14);
    expect(events.map((event: { sequence: number }) => event.sequence)).toEqual(
      Array.from({ length: 14 }, (_, index) => index + 1),
    );

    const eventTypes = events.map((event: { event_type: string }) => event.event_type);
    expect(eventTypes[0]).toBe("request_received");
    expect(eventTypes[eventTypes.length - 1]).toBe("response_ready");
    for (let index = 0; index < 12; index += 1) {
      expect(eventTypes).toContain(`concurrent_write_${index}`);
    }
  });
});
