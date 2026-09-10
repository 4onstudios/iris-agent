import * as acp from "@agentclientprotocol/sdk";
import {
    createAcpAgentApp,
    type AcpRuntimeAgent,
} from "../api/acp/acpServer";

const createChunkStream = (
    chunks: Array<{ type: string; payload?: Record<string, unknown> }>,
): ReadableStream<{ type: string; payload?: Record<string, unknown> }> =>
    new ReadableStream({
        start(controller) {
            chunks.forEach((chunk) => controller.enqueue(chunk));
            controller.close();
        },
    });

const readToolCallId = (update: acp.SessionUpdate): string | undefined =>
    "toolCallId" in update ? update.toolCallId : undefined;

describe("ACP server", () => {
    it("supports the standard initialize, session, prompt, update, and close flow", async () => {
        const runtime: AcpRuntimeAgent = {
            stream: jest.fn(async () => ({
                fullStream: createChunkStream([
                    { type: "reasoning-delta", payload: { text: "Checking context" } },
                    {
                        type: "tool-call",
                        payload: {
                            toolName: "readFile",
                            toolCallId: "call-1",
                            args: { path: "README.md" },
                        },
                    },
                    {
                        type: "tool-result",
                        payload: {
                            toolName: "readFile",
                            toolCallId: "call-1",
                            result: { content: "Project readme" },
                        },
                    },
                    { type: "text-delta", payload: { text: "Finished" } },
                ]),
                text: Promise.resolve("Finished"),
            })),
        };
        const updates: acp.SessionNotification[] = [];
        const client = acp
            .client({ name: "iris-agent-test-client" })
            .onNotification(acp.methods.client.session.update, (ctx) => {
                updates.push(ctx.params);
            });

        await client.connectWith(createAcpAgentApp(runtime), async (ctx) => {
            const initialized = await ctx.request(acp.methods.agent.initialize, {
                protocolVersion: acp.PROTOCOL_VERSION,
                clientCapabilities: {},
            });
            expect(initialized.protocolVersion).toBe(acp.PROTOCOL_VERSION);
            expect(initialized.agentCapabilities?.sessionCapabilities?.close).toEqual({});

            const session = await ctx.request(acp.methods.agent.session.new, {
                cwd: "/workspace",
                mcpServers: [],
            });
            const response = await ctx.request(acp.methods.agent.session.prompt, {
                sessionId: session.sessionId,
                prompt: [{ type: "text", text: "Read the README" }],
            });

            expect(response.stopReason).toBe("end_turn");
            expect(runtime.stream).toHaveBeenCalledWith("Read the README", {
                workspaceRoot: "/workspace",
                signal: expect.any(AbortSignal),
            });
            expect(updates.map((entry) => entry.update.sessionUpdate)).toEqual([
                "agent_thought_chunk",
                "tool_call",
                "tool_call_update",
                "agent_message_chunk",
            ]);
            expect(updates[1]?.update).toEqual(
                expect.objectContaining({
                    toolCallId: "call-1",
                    kind: "read",
                    status: "in_progress",
                }),
            );
            expect(updates[2]?.update).toEqual(
                expect.objectContaining({
                    toolCallId: "call-1",
                    status: "completed",
                    rawOutput: { content: "Project readme" },
                }),
            );

            await expect(
                ctx.request(acp.methods.agent.session.close, {
                    sessionId: session.sessionId,
                }),
            ).resolves.toEqual({});
            await expect(
                ctx.request(acp.methods.agent.session.prompt, {
                    sessionId: session.sessionId,
                    prompt: [{ type: "text", text: "After close" }],
                }),
            ).rejects.toThrow("Internal error");
        });
    });

    it("falls back to generation and emits the final response", async () => {
        const runtime: AcpRuntimeAgent = {
            generate: jest.fn(async () => ({ text: "Generated answer" })),
        };
        const updates: acp.SessionNotification[] = [];
        const client = acp
            .client({ name: "iris-agent-test-client" })
            .onNotification(acp.methods.client.session.update, (ctx) => {
                updates.push(ctx.params);
            });

        await client.connectWith(createAcpAgentApp(runtime), async (ctx) => {
            await ctx.request(acp.methods.agent.initialize, {
                protocolVersion: acp.PROTOCOL_VERSION,
                clientCapabilities: {},
            });
            const session = await ctx.request(acp.methods.agent.session.new, {
                cwd: "/workspace",
                mcpServers: [],
            });
            const response = await ctx.request(acp.methods.agent.session.prompt, {
                sessionId: session.sessionId,
                prompt: [
                    { type: "text", text: "Explain this" },
                    {
                        type: "resource_link",
                        uri: "file:///workspace/README.md",
                        name: "README.md",
                    },
                ],
            });

            expect(response.stopReason).toBe("end_turn");
            expect(runtime.generate).toHaveBeenCalledWith(
                "Explain this\n\n[Resource: README.md](file:///workspace/README.md)",
                expect.objectContaining({ workspaceRoot: "/workspace" }),
            );
            expect(updates).toEqual([
                expect.objectContaining({
                    sessionId: session.sessionId,
                    update: expect.objectContaining({
                        sessionUpdate: "agent_message_chunk",
                        content: { type: "text", text: "Generated answer" },
                    }),
                }),
            ]);
        });
    });

    it("reuses an ordered generated tool id when stream chunks omit ids", async () => {
        const runtime: AcpRuntimeAgent = {
            stream: jest.fn(async () => ({
                fullStream: createChunkStream([
                    { type: "tool-call", payload: { toolName: "readFile" } },
                    {
                        type: "tool-result",
                        payload: { toolName: "readFile", result: "contents" },
                    },
                ]),
                text: Promise.resolve(""),
            })),
        };
        const updates: acp.SessionNotification[] = [];
        const client = acp
            .client({ name: "iris-agent-test-client" })
            .onNotification(acp.methods.client.session.update, (ctx) => {
                updates.push(ctx.params);
            });

        await client.connectWith(createAcpAgentApp(runtime), async (ctx) => {
            await ctx.request(acp.methods.agent.initialize, {
                protocolVersion: acp.PROTOCOL_VERSION,
                clientCapabilities: {},
            });
            const session = await ctx.request(acp.methods.agent.session.new, {
                cwd: "/workspace",
                mcpServers: [],
            });
            await ctx.request(acp.methods.agent.session.prompt, {
                sessionId: session.sessionId,
                prompt: [{ type: "text", text: "Read the file" }],
            });
        });

        expect(updates).toHaveLength(2);
        expect(updates[0]?.update).toEqual(
            expect.objectContaining({
                sessionUpdate: "tool_call",
                toolCallId: "generated-readFile-1",
            }),
        );
        expect(updates[1]?.update).toEqual(
            expect.objectContaining({
                sessionUpdate: "tool_call_update",
                toolCallId: "generated-readFile-1",
                status: "completed",
            }),
        );
    });

    it("reports failed tool results and synthesizes the missing start for orphaned results", async () => {
        const runtime: AcpRuntimeAgent = {
            stream: jest.fn(async () => ({
                fullStream: createChunkStream([
                    {
                        type: "tool-result",
                        payload: {
                            toolName: "runCommand",
                            toolCallId: "orphan-status",
                            result: { status: "failed" },
                        },
                    },
                    {
                        type: "tool-call",
                        payload: { toolName: "runCommand", toolCallId: "success-false" },
                    },
                    {
                        type: "tool-result",
                        payload: {
                            toolName: "runCommand",
                            toolCallId: "success-false",
                            result: { success: false },
                        },
                    },
                    {
                        type: "tool-call",
                        payload: { toolName: "runCommand", toolCallId: "is-error" },
                    },
                    {
                        type: "tool-result",
                        payload: {
                            toolName: "runCommand",
                            toolCallId: "is-error",
                            result: { isError: true },
                        },
                    },
                ]),
                text: Promise.resolve(""),
            })),
        };
        const updates: acp.SessionNotification[] = [];
        const client = acp
            .client({ name: "iris-agent-test-client" })
            .onNotification(acp.methods.client.session.update, (ctx) => {
                updates.push(ctx.params);
            });

        await client.connectWith(createAcpAgentApp(runtime), async (ctx) => {
            await ctx.request(acp.methods.agent.initialize, {
                protocolVersion: acp.PROTOCOL_VERSION,
                clientCapabilities: {},
            });
            const session = await ctx.request(acp.methods.agent.session.new, {
                cwd: "/workspace",
                mcpServers: [],
            });
            await ctx.request(acp.methods.agent.session.prompt, {
                sessionId: session.sessionId,
                prompt: [{ type: "text", text: "Run commands" }],
            });
        });

        const mapped = updates.map((entry) => entry.update);
        const orphanStart = mapped[0];
        const orphanFinish = mapped[1];

        expect(orphanStart).toEqual(
            expect.objectContaining({
                sessionUpdate: "tool_call",
                toolCallId: "orphan-status",
                status: "in_progress",
            }),
        );
        expect(orphanFinish).toEqual(
            expect.objectContaining({
                sessionUpdate: "tool_call_update",
                toolCallId: "orphan-status",
                status: "failed",
            }),
        );
        expect(mapped.slice(2)).toEqual([
            expect.objectContaining({
                sessionUpdate: "tool_call",
                toolCallId: "success-false",
                status: "in_progress",
            }),
            expect.objectContaining({
                sessionUpdate: "tool_call_update",
                toolCallId: "success-false",
                status: "failed",
            }),
            expect.objectContaining({
                sessionUpdate: "tool_call",
                toolCallId: "is-error",
                status: "in_progress",
            }),
            expect.objectContaining({
                sessionUpdate: "tool_call_update",
                toolCallId: "is-error",
                status: "failed",
            }),
        ]);
    });

    it("fails pending tool calls when the stream ends without a result", async () => {
        const runtime: AcpRuntimeAgent = {
            stream: jest.fn(async () => ({
                fullStream: createChunkStream([
                    {
                        type: "tool-call",
                        payload: {
                            toolName: "runCommand",
                            toolCallId: "interrupted-command",
                            args: { command: "npm test" },
                        },
                    },
                ]),
                text: Promise.resolve(""),
            })),
        };
        const updates: acp.SessionNotification[] = [];
        const client = acp
            .client({ name: "iris-agent-test-client" })
            .onNotification(acp.methods.client.session.update, (ctx) => {
                updates.push(ctx.params);
            });

        await client.connectWith(createAcpAgentApp(runtime), async (ctx) => {
            await ctx.request(acp.methods.agent.initialize, {
                protocolVersion: acp.PROTOCOL_VERSION,
                clientCapabilities: {},
            });
            const session = await ctx.request(acp.methods.agent.session.new, {
                cwd: "/workspace",
                mcpServers: [],
            });
            await expect(
                ctx.request(acp.methods.agent.session.prompt, {
                    sessionId: session.sessionId,
                    prompt: [{ type: "text", text: "Run the tests" }],
                }),
            ).resolves.toEqual({ stopReason: "end_turn" });
        });

        expect(updates.map((entry) => entry.update)).toEqual([
            expect.objectContaining({
                sessionUpdate: "tool_call",
                toolCallId: "interrupted-command",
                status: "in_progress",
            }),
            expect.objectContaining({
                sessionUpdate: "tool_call_update",
                toolCallId: "interrupted-command",
                status: "failed",
            }),
        ]);
    });

    it("cancels a fallback turn before it emits the generated response", async () => {
        let resolveGenerate!: (value: { text: string }) => void;
        const generateResult = new Promise<{ text: string }>((resolve) => {
            resolveGenerate = resolve;
        });
        const runtime: AcpRuntimeAgent = {
            generate: jest.fn(async (_input, options) => {
                expect(options?.signal).toBeInstanceOf(AbortSignal);
                return generateResult;
            }),
        };
        const updates: acp.SessionNotification[] = [];
        const client = acp
            .client({ name: "iris-agent-test-client" })
            .onNotification(acp.methods.client.session.update, (ctx) => {
                updates.push(ctx.params);
            });

        await client.connectWith(createAcpAgentApp(runtime), async (ctx) => {
            await ctx.request(acp.methods.agent.initialize, {
                protocolVersion: acp.PROTOCOL_VERSION,
                clientCapabilities: {},
            });
            const session = await ctx.request(acp.methods.agent.session.new, {
                cwd: "/workspace",
                mcpServers: [],
            });
            const prompt = ctx.request(acp.methods.agent.session.prompt, {
                sessionId: session.sessionId,
                prompt: [{ type: "text", text: "Wait" }],
            });
            await ctx.notify(acp.methods.agent.session.cancel, {
                sessionId: session.sessionId,
            });
            resolveGenerate({ text: "Should not be emitted" });

            await expect(prompt).resolves.toEqual({ stopReason: "cancelled" });
        });

        expect(updates).toHaveLength(0);
    });

    it("cancels a fallback turn even when generation never resolves", async () => {
        const runtime: AcpRuntimeAgent = {
            generate: jest.fn(async (_input, options) => {
                expect(options?.signal).toBeInstanceOf(AbortSignal);
                return new Promise<{ text: string }>(() => undefined);
            }),
        };
        const client = acp.client({ name: "iris-agent-test-client" });

        await client.connectWith(createAcpAgentApp(runtime), async (ctx) => {
            await ctx.request(acp.methods.agent.initialize, {
                protocolVersion: acp.PROTOCOL_VERSION,
                clientCapabilities: {},
            });
            const session = await ctx.request(acp.methods.agent.session.new, {
                cwd: "/workspace",
                mcpServers: [],
            });
            const prompt = ctx.request(acp.methods.agent.session.prompt, {
                sessionId: session.sessionId,
                prompt: [{ type: "text", text: "Wait forever" }],
            });
            await ctx.notify(acp.methods.agent.session.cancel, {
                sessionId: session.sessionId,
            });

            const promptWithTimeout = new Promise<acp.PromptResponse>(
                (resolve, reject) => {
                    const timer = setTimeout(
                        () => reject(new Error("Prompt did not cancel in time")),
                        200,
                    );
                    prompt.then(
                        (value) => {
                            clearTimeout(timer);
                            resolve(value);
                        },
                        (error) => {
                            clearTimeout(timer);
                            reject(error);
                        },
                    );
                },
            );
            await expect(promptWithTimeout).resolves.toEqual({
                stopReason: "cancelled",
            });
        });
    });

    it("passes cancellation to stream startup", async () => {
        let resolveStream!: (value: {
            fullStream: ReadableStream<never>;
            text: Promise<string>;
        }) => void;
        const streamResult = new Promise<{
            fullStream: ReadableStream<never>;
            text: Promise<string>;
        }>((resolve) => {
            resolveStream = resolve;
        });
        let receivedSignal!: AbortSignal;
        const runtime: AcpRuntimeAgent = {
            stream: jest.fn(async (_input, options) => {
                receivedSignal = options.signal as AbortSignal;
                return streamResult;
            }),
        };
        const client = acp.client({ name: "iris-agent-test-client" });

        await client.connectWith(createAcpAgentApp(runtime), async (ctx) => {
            await ctx.request(acp.methods.agent.initialize, {
                protocolVersion: acp.PROTOCOL_VERSION,
                clientCapabilities: {},
            });
            const session = await ctx.request(acp.methods.agent.session.new, {
                cwd: "/workspace",
                mcpServers: [],
            });
            const prompt = ctx.request(acp.methods.agent.session.prompt, {
                sessionId: session.sessionId,
                prompt: [{ type: "text", text: "Start" }],
            });
            while (!receivedSignal) await Promise.resolve();
            await ctx.notify(acp.methods.agent.session.cancel, {
                sessionId: session.sessionId,
            });
            expect(receivedSignal.aborted).toBe(true);
            resolveStream({
                fullStream: new ReadableStream({ start(controller) { controller.close(); } }),
                text: Promise.resolve(""),
            });
            await expect(prompt).resolves.toEqual({ stopReason: "cancelled" });
        });
    });

    it("cancels after stream completion but before final text resolves", async () => {
        let resolveText!: (value: string) => void;
        const finalText = new Promise<string>((resolve) => {
            resolveText = resolve;
        });
        const runtime: AcpRuntimeAgent = {
            stream: jest.fn(async () => ({
                fullStream: new ReadableStream({
                    start(controller) {
                        controller.close();
                    },
                }),
                text: finalText,
            })),
        };
        const updates: acp.SessionNotification[] = [];
        const client = acp
            .client({ name: "iris-agent-test-client" })
            .onNotification(acp.methods.client.session.update, (ctx) => {
                updates.push(ctx.params);
            });

        await client.connectWith(createAcpAgentApp(runtime), async (ctx) => {
            await ctx.request(acp.methods.agent.initialize, {
                protocolVersion: acp.PROTOCOL_VERSION,
                clientCapabilities: {},
            });
            const session = await ctx.request(acp.methods.agent.session.new, {
                cwd: "/workspace",
                mcpServers: [],
            });
            const prompt = ctx.request(acp.methods.agent.session.prompt, {
                sessionId: session.sessionId,
                prompt: [{ type: "text", text: "Wait for final text" }],
            });
            await Promise.resolve();
            await ctx.notify(acp.methods.agent.session.cancel, {
                sessionId: session.sessionId,
            });
            resolveText("late text");
            await expect(prompt).resolves.toEqual({ stopReason: "cancelled" });
        });

        expect(updates).toHaveLength(0);
    });

    it("cancels after stream completion even when final text never resolves", async () => {
        const runtime: AcpRuntimeAgent = {
            stream: jest.fn(async () => ({
                fullStream: new ReadableStream({
                    start(controller) {
                        controller.close();
                    },
                }),
                text: new Promise<string>(() => undefined),
            })),
        };
        const client = acp.client({ name: "iris-agent-test-client" });

        await client.connectWith(createAcpAgentApp(runtime), async (ctx) => {
            await ctx.request(acp.methods.agent.initialize, {
                protocolVersion: acp.PROTOCOL_VERSION,
                clientCapabilities: {},
            });
            const session = await ctx.request(acp.methods.agent.session.new, {
                cwd: "/workspace",
                mcpServers: [],
            });
            const prompt = ctx.request(acp.methods.agent.session.prompt, {
                sessionId: session.sessionId,
                prompt: [{ type: "text", text: "Wait for final text" }],
            });
            await Promise.resolve();
            await ctx.notify(acp.methods.agent.session.cancel, {
                sessionId: session.sessionId,
            });

            const promptWithTimeout = new Promise<acp.PromptResponse>(
                (resolve, reject) => {
                    const timer = setTimeout(
                        () => reject(new Error("Prompt did not cancel in time")),
                        200,
                    );
                    prompt.then(
                        (value) => {
                            clearTimeout(timer);
                            resolve(value);
                        },
                        (error) => {
                            clearTimeout(timer);
                            reject(error);
                        },
                    );
                },
            );
            await expect(promptWithTimeout).resolves.toEqual({
                stopReason: "cancelled",
            });
        });
    });

    it("allocates a unique protocol id when a runtime call id is reused for a different signature", async () => {
        const runtime: AcpRuntimeAgent = {
            stream: jest.fn(async () => ({
                fullStream: createChunkStream([
                    {
                        type: "tool-call",
                        payload: {
                            toolName: "writeFile",
                            toolCallId: "reused",
                            args: { path: "a.txt", content: "A" },
                        },
                    },
                    {
                        type: "tool-call",
                        payload: {
                            toolName: "writeFile",
                            toolCallId: "reused",
                            args: { path: "b.txt", content: "B" },
                        },
                    },
                    {
                        type: "tool-result",
                        payload: {
                            toolName: "writeFile",
                            toolCallId: "reused",
                            args: { path: "b.txt", content: "B" },
                            result: { status: "completed", ok: true },
                        },
                    },
                ]),
                text: Promise.resolve(""),
            })),
        };
        const updates: acp.SessionNotification[] = [];
        const client = acp
            .client({ name: "iris-agent-test-client" })
            .onNotification(acp.methods.client.session.update, (ctx) => {
                updates.push(ctx.params);
            });

        await client.connectWith(createAcpAgentApp(runtime), async (ctx) => {
            await ctx.request(acp.methods.agent.initialize, {
                protocolVersion: acp.PROTOCOL_VERSION,
                clientCapabilities: {},
            });
            const session = await ctx.request(acp.methods.agent.session.new, {
                cwd: "/workspace",
                mcpServers: [],
            });
            await ctx.request(acp.methods.agent.session.prompt, {
                sessionId: session.sessionId,
                prompt: [{ type: "text", text: "Write two files" }],
            });
        });

        const toolCallUpdates = updates.filter(
            (entry) => entry.update.sessionUpdate === "tool_call",
        );
        const toolResultUpdates = updates.filter(
            (entry) => entry.update.sessionUpdate === "tool_call_update",
        );
        expect(toolCallUpdates).toHaveLength(2);
        expect(toolResultUpdates).toHaveLength(2);
        const firstProtocolId = readToolCallId(
            toolCallUpdates[0]?.update as acp.SessionUpdate,
        );
        const secondProtocolId = readToolCallId(
            toolCallUpdates[1]?.update as acp.SessionUpdate,
        );
        expect(firstProtocolId).toBe("reused");
        expect(secondProtocolId).toBeDefined();
        expect(secondProtocolId).not.toBe(firstProtocolId);
        expect(
            readToolCallId(toolResultUpdates[0]?.update as acp.SessionUpdate),
        ).toBe(secondProtocolId);
        expect(toolResultUpdates[0]?.update).toEqual(
            expect.objectContaining({ status: "completed" }),
        );
        // The first "reused" invocation (a.txt) never received a matching
        // tool-result from the runtime, so it must be closed out with a
        // terminal update when the turn ends rather than staying in_progress.
        expect(
            readToolCallId(toolResultUpdates[1]?.update as acp.SessionUpdate),
        ).toBe(firstProtocolId);
        expect(toolResultUpdates[1]?.update).toEqual(
            expect.objectContaining({ status: "failed" }),
        );
    });

    it("allocates unique protocol ids when different tools reuse a runtime id", async () => {
        const runtime: AcpRuntimeAgent = {
            stream: jest.fn(async () => ({
                fullStream: createChunkStream([
                    {
                        type: "tool-call",
                        payload: {
                            toolName: "readFile",
                            toolCallId: "reused",
                            args: { path: "README.md" },
                        },
                    },
                    {
                        type: "tool-call",
                        payload: {
                            toolName: "runCommand",
                            toolCallId: "reused",
                            args: { command: "npm test" },
                        },
                    },
                    {
                        type: "tool-result",
                        payload: {
                            toolName: "readFile",
                            toolCallId: "reused",
                            result: { content: "readme" },
                        },
                    },
                    {
                        type: "tool-result",
                        payload: {
                            toolName: "runCommand",
                            toolCallId: "reused",
                            result: { exitCode: 0 },
                        },
                    },
                ]),
                text: Promise.resolve(""),
            })),
        };
        const updates: acp.SessionNotification[] = [];
        const client = acp
            .client({ name: "iris-agent-test-client" })
            .onNotification(acp.methods.client.session.update, (ctx) => {
                updates.push(ctx.params);
            });

        await client.connectWith(createAcpAgentApp(runtime), async (ctx) => {
            await ctx.request(acp.methods.agent.initialize, {
                protocolVersion: acp.PROTOCOL_VERSION,
                clientCapabilities: {},
            });
            const session = await ctx.request(acp.methods.agent.session.new, {
                cwd: "/workspace",
                mcpServers: [],
            });
            await ctx.request(acp.methods.agent.session.prompt, {
                sessionId: session.sessionId,
                prompt: [{ type: "text", text: "Read then test" }],
            });
        });

        const starts = updates
            .map((entry) => entry.update)
            .filter((update) => update.sessionUpdate === "tool_call");
        const finishes = updates
            .map((entry) => entry.update)
            .filter((update) => update.sessionUpdate === "tool_call_update");
        const firstId = readToolCallId(starts[0] as acp.SessionUpdate);
        const secondId = readToolCallId(starts[1] as acp.SessionUpdate);

        expect(firstId).toBe("reused");
        expect(secondId).toBeDefined();
        expect(secondId).not.toBe(firstId);
        expect(readToolCallId(finishes[0] as acp.SessionUpdate)).toBe(firstId);
        expect(readToolCallId(finishes[1] as acp.SessionUpdate)).toBe(secondId);
    });
});