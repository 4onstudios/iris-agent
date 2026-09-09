import type {
    AgentRuntime,
    AgentStreamEvent,
    AgentTurnResult,
    AgentTurnStreamResult,
} from "../api/core/agent/host/AgentContract";
import { HostSessionManager } from "../api/core/agent/host/hostSessionManager";

const createRuntime = (overrides: Partial<AgentRuntime> = {}): AgentRuntime => ({
    descriptor: {
        id: "test-runtime",
        name: "Test Runtime",
        version: "1.0.0",
        source: "external",
    },
    startSession: jest.fn(async ({ sessionId }) => ({
        sessionId,
        agentId: "test-runtime",
        createdAt: 1,
    })),
    runTurn: jest.fn(async (request): Promise<AgentTurnResult> => ({
        text: `response:${request.input}`,
        toolCalls: [{ name: "readFile", toolCallId: "tool-1" }],
        toolResults: [{ content: "file contents" }],
    })),
    endSession: jest.fn(async () => undefined),
    ...overrides,
});

describe("HostSessionManager", () => {
    it("runs session, turn, tool, and disconnect hooks in order", async () => {
        const runtime = createRuntime();
        const events: string[] = [];
        const manager = new HostSessionManager(() => runtime, {
            workspacePath: "/workspace",
            modelId: "base-model",
            metadata: { base: true },
        });

        const session = await manager.createSession({
            sessionId: "session-1",
            modelId: "session-model",
            metadata: { request: true },
            hooks: {
                onSessionStart: ({ context }) => {
                    events.push(`start:${context.modelId}`);
                    expect(context.metadata).toEqual({ base: true, request: true });
                },
                onPreTurn: ({ request }) => {
                    events.push(`pre-turn:${request.input}`);
                },
                onPreToolUse: ({ toolName }) => {
                    events.push(`pre-tool:${toolName}`);
                    return { permissionDecision: "allow" };
                },
                onPostToolUse: ({ toolName, toolResult }) => {
                    events.push(`post-tool:${toolName}`);
                    expect(toolResult).toEqual({ content: "file contents" });
                },
                onPostTurn: ({ result }) => {
                    events.push(`post-turn:${result.text}`);
                },
                onSessionEnd: () => {
                    events.push("end");
                },
            },
        });

        const result = await session.sendAndWait({
            prompt: "hello",
            metadata: {
                declaredToolCalls: [
                    { toolName: "readFile", toolCallId: "tool-1", toolArgs: { path: "README.md" } },
                ],
            },
        });
        await session.disconnect();

        expect(result.text).toBe("response:hello");
        expect(events).toEqual([
            "start:session-model",
            "pre-turn:hello",
            "pre-tool:readFile",
            "post-tool:readFile",
            "post-turn:response:hello",
            "end",
        ]);
        expect(runtime.startSession).toHaveBeenCalledTimes(1);
        expect(runtime.endSession).toHaveBeenCalledWith("session-1");
    });

    it("rejects denied permission requests before running the turn", async () => {
        const runtime = createRuntime();
        const manager = new HostSessionManager(() => runtime, {
            workspacePath: "/workspace",
        });
        const session = await manager.createSession({
            onPermissionRequest: () => ({
                kind: "reject",
                feedback: "Command is not allowed",
            }),
        });

        await expect(
            session.sendAndWait({
                prompt: "run command",
                permissionRequest: { kind: "shell", command: "rm -rf build" },
            }),
        ).rejects.toThrow("Command is not allowed");
        expect(runtime.runTurn).not.toHaveBeenCalled();
    });

    it("reuses an open session when resuming the same id", async () => {
        const runtimeFactory = jest.fn(() => createRuntime());
        const manager = new HostSessionManager(runtimeFactory, {
            workspacePath: "/workspace",
        });

        const created = await manager.createSession({ sessionId: "shared-session" });
        const resumed = await manager.resumeSession("shared-session");

        expect(resumed.sessionId).toBe(created.sessionId);
        expect(runtimeFactory).toHaveBeenCalledTimes(1);
        await manager.stopAll();
    });

    it("preserves runtime-specific stream fields and runs the post-turn hook", async () => {
        const sourceEvents: AgentStreamEvent[] = [
            { type: "text-delta", text: "hello" },
            { type: "done" },
        ];
        const stream = new ReadableStream<AgentStreamEvent>({
            start(controller) {
                sourceEvents.forEach((event) => controller.enqueue(event));
                controller.close();
            },
        });
        const nativeTransport = { id: "native-stream" };
        const runtimeStreamResult = {
            stream,
            getFinalResult: jest.fn(async () => ({ text: "hello" })),
            nativeTransport,
        } as AgentTurnStreamResult & { nativeTransport: { id: string } };
        const runtime = createRuntime({
            runTurnStream: jest.fn(async () => runtimeStreamResult),
        });
        const onPostTurn = jest.fn();
        const manager = new HostSessionManager(() => runtime, {
            workspacePath: "/workspace",
        });
        const session = await manager.createSession({
            hooks: { onPostTurn },
        });

        const result = await session.sendStream({ prompt: "stream this" });
        expect(
            (result as AgentTurnStreamResult & { nativeTransport?: { id: string } }).nativeTransport,
        ).toBe(nativeTransport);

        await expect(result.getFinalResult()).resolves.toEqual({ text: "hello" });
        expect(onPostTurn).toHaveBeenCalledWith(
            expect.objectContaining({
                request: expect.objectContaining({ input: "stream this" }),
                result: { text: "hello" },
            }),
            { sessionId: session.sessionId },
        );
    });

    it("enforces tool hooks and reports completed tools for streaming turns", async () => {
        const stream = new ReadableStream<AgentStreamEvent>({
            start(controller) {
                controller.enqueue({ type: "done" });
                controller.close();
            },
        });
        const runtime = createRuntime({
            runTurnStream: jest.fn(async () => ({
                stream,
                getFinalResult: async () => ({
                    text: "done",
                    toolCalls: [{ name: "readFile", toolCallId: "stream-tool-1" }],
                    toolResults: [{ content: "streamed contents" }],
                }),
            })),
        });
        const onPreToolUse = jest.fn(() => ({ permissionDecision: "allow" as const }));
        const onPostToolUse = jest.fn();
        const manager = new HostSessionManager(() => runtime, {
            workspacePath: "/workspace",
        });
        const session = await manager.createSession({
            hooks: { onPreToolUse, onPostToolUse },
        });

        const streamResult = await session.sendStream({
            prompt: "read a file",
            metadata: {
                declaredToolCalls: [
                    { toolName: "readFile", toolCallId: "stream-tool-1" },
                ],
            },
        });
        await streamResult.getFinalResult();

        expect(onPreToolUse).toHaveBeenCalledWith(
            expect.objectContaining({
                toolName: "readFile",
                toolCallId: "stream-tool-1",
            }),
            { sessionId: session.sessionId },
        );
        expect(onPostToolUse).toHaveBeenCalledWith(
            expect.objectContaining({
                toolName: "readFile",
                toolCallId: "stream-tool-1",
                toolResult: { content: "streamed contents" },
            }),
            { sessionId: session.sessionId },
        );
    });

    it("blocks streaming before runtime execution when a tool hook denies access", async () => {
        const runTurnStream = jest.fn();
        const runtime = createRuntime({ runTurnStream });
        const manager = new HostSessionManager(() => runtime, {
            workspacePath: "/workspace",
        });
        const session = await manager.createSession({
            hooks: {
                onPreToolUse: () => ({ permissionDecision: "deny" }),
            },
        });

        await expect(
            session.sendStream({
                prompt: "write a file",
                metadata: {
                    declaredToolCalls: [{ toolName: "writeFile" }],
                },
            }),
        ).rejects.toThrow("Tool 'writeFile' denied by onPreToolUse hook");
        expect(runTurnStream).not.toHaveBeenCalled();
    });

    it("guards a tool selected by the runtime without declared metadata", async () => {
        const onPreToolUse = jest.fn(() => ({ permissionDecision: "deny" as const }));
        const runtime = createRuntime({
            runTurn: jest.fn(async (request) => {
                await request.onPreToolUse?.({
                    toolName: "undeclaredTool",
                    toolArgs: { value: 1 },
                });
                return { text: "unreachable" };
            }),
        });
        const manager = new HostSessionManager(() => runtime, {
            workspacePath: "/workspace",
        });
        const session = await manager.createSession({
            hooks: { onPreToolUse },
        });

        await expect(session.sendAndWait({ prompt: "run the tool" })).rejects.toThrow(
            "Tool 'undeclaredTool' denied by onPreToolUse hook",
        );
        expect(onPreToolUse).toHaveBeenCalledWith(
            expect.objectContaining({ toolName: "undeclaredTool" }),
            { sessionId: session.sessionId },
        );
    });

    it("reapplies a denied tool decision when the runtime retries the same call", async () => {
        const onPreToolUse = jest.fn(() => ({ permissionDecision: "deny" as const }));
        const denialMessages: string[] = [];
        let executed = false;
        const runtime = createRuntime({
            runTurn: jest.fn(async (request) => {
                for (let attempt = 0; attempt < 2; attempt += 1) {
                    try {
                        await request.onPreToolUse?.({
                            toolName: "writeFile",
                            toolCallId: "call-1",
                            toolArgs: { path: "README.md" },
                        });
                        executed = true;
                    } catch (error) {
                        denialMessages.push((error as Error).message);
                    }
                }
                return { text: "blocked" };
            }),
        });
        const manager = new HostSessionManager(() => runtime, {
            workspacePath: "/workspace",
        });
        const session = await manager.createSession({
            hooks: { onPreToolUse },
        });

        await session.sendAndWait({ prompt: "retry the tool" });

        expect(executed).toBe(false);
        expect(denialMessages).toEqual([
            "Tool 'writeFile' denied by onPreToolUse hook",
            "Tool 'writeFile' denied by onPreToolUse hook",
        ]);
        expect(onPreToolUse).toHaveBeenCalledTimes(2);
    });

    it("deduplicates concurrent opens and delegates cancellation", async () => {
        let releaseStart!: () => void;
        const startGate = new Promise<void>((resolve) => {
            releaseStart = resolve;
        });
        const cancelTurn = jest.fn(async () => undefined);
        const runtime = createRuntime({
            startSession: jest.fn(async ({ sessionId }) => {
                await startGate;
                return { sessionId, agentId: "test-runtime", createdAt: 1 };
            }),
            cancelTurn,
        });
        const runtimeFactory = jest.fn(() => runtime);
        const manager = new HostSessionManager(runtimeFactory, {
            workspacePath: "/workspace",
        });

        const first = manager.createSession({ sessionId: "concurrent-session" });
        const second = manager.resumeSession("concurrent-session");
        releaseStart();
        const [firstHandle, secondHandle] = await Promise.all([first, second]);

        expect(firstHandle.sessionId).toBe(secondHandle.sessionId);
        expect(runtimeFactory).toHaveBeenCalledTimes(1);
        expect(runtime.startSession).toHaveBeenCalledTimes(1);

        await firstHandle.cancel();
        expect(cancelTurn).toHaveBeenCalledWith("concurrent-session");
    });

    it("ends and removes a session even when the end hook fails", async () => {
        const runtime = createRuntime();
        const manager = new HostSessionManager(() => runtime, {
            workspacePath: "/workspace",
        });
        const session = await manager.createSession({
            sessionId: "failing-end-hook",
            hooks: {
                onSessionEnd: () => {
                    throw new Error("end hook failed");
                },
            },
        });

        await expect(session.disconnect()).rejects.toThrow("end hook failed");
        expect(runtime.endSession).toHaveBeenCalledWith("failing-end-hook");
        await expect(session.sendAndWait({ prompt: "after disconnect" })).rejects.toThrow(
            "Unknown session 'failing-end-hook'",
        );
    });
});