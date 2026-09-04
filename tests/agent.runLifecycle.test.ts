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
