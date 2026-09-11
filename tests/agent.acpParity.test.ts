import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import {
    createAcpAgentApp,
    type AcpRuntimeAgent,
} from "../api/acp/acpServer";

jest.mock("../api/core/agent/tools/executeCommand", () => ({
    executeCommand: jest.fn(),
}));

import { executeCommand } from "../api/core/agent/tools/executeCommand";

const createChunkStream = (
    chunks: Array<{ type: string; payload?: Record<string, unknown> }>,
): ReadableStream<{ type: string; payload?: Record<string, unknown> }> =>
    new ReadableStream({
        start(controller) {
            chunks.forEach((chunk) => controller.enqueue(chunk));
            controller.close();
        },
    });

const chatSessionPath = (sessionId: string): string =>
    path.join(os.homedir(), ".iris", "chat-sessions", `${sessionId}.json`);

describe("ACP parity features", () => {
    afterEach(async () => {
        jest.clearAllMocks();
    });

    it("advertises available slash commands when a session is created", async () => {
        const runtime: AcpRuntimeAgent = {
            stream: jest.fn(async () => ({
                fullStream: createChunkStream([
                    { type: "text-delta", payload: { text: "hi" } },
                ]),
                text: Promise.resolve("hi"),
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
            expect(initialized.agentCapabilities?.loadSession).toBe(true);

            await ctx.request(acp.methods.agent.session.new, {
                cwd: "/workspace",
                mcpServers: [],
            });

            expect(updates[0]?.update).toEqual(
                expect.objectContaining({
                    sessionUpdate: "available_commands_update",
                }),
            );
        });
    });

    it("requests permission for commands pending confirmation and re-executes on approval", async () => {
        const mockedExecuteCommand = executeCommand as jest.MockedFunction<
            typeof executeCommand
        >;
        mockedExecuteCommand.mockResolvedValue({
            success: true,
            output: "done",
        } as never);

        const runtime: AcpRuntimeAgent = {
            stream: jest.fn(async () => ({
                fullStream: createChunkStream([
                    {
                        type: "tool-call",
                        payload: {
                            toolName: "runCommand",
                            toolCallId: "call-1",
                            args: { command: "npm test" },
                        },
                    },
                    {
                        type: "tool-result",
                        payload: {
                            toolName: "runCommand",
                            toolCallId: "call-1",
                            args: { command: "npm test" },
                            result: { status: "pending_confirmation" },
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
            })
            .onRequest(acp.methods.client.session.requestPermission, async () => ({
                outcome: { outcome: "selected", optionId: "allow_once" },
            }));

        await client.connectWith(createAcpAgentApp(runtime), async (ctx) => {
            const session = await ctx.request(acp.methods.agent.session.new, {
                cwd: "/workspace",
                mcpServers: [],
            });
            const response = await ctx.request(acp.methods.agent.session.prompt, {
                sessionId: session.sessionId,
                prompt: [{ type: "text", text: "run tests" }],
            });

            expect(response.stopReason).toBe("end_turn");
            expect(mockedExecuteCommand).toHaveBeenCalledWith(
                expect.objectContaining({
                    command: "npm test",
                    workspaceRoot: "/workspace",
                    skipConfirmation: true,
                }),
            );
            const toolUpdate = updates.find(
                (entry) => entry.update.sessionUpdate === "tool_call_update",
            );
            expect(toolUpdate?.update).toEqual(
                expect.objectContaining({ status: "completed" }),
            );
        });
    });

    it("marks the tool call failed when the user rejects the permission request", async () => {
        const mockedExecuteCommand = executeCommand as jest.MockedFunction<
            typeof executeCommand
        >;

        const runtime: AcpRuntimeAgent = {
            stream: jest.fn(async () => ({
                fullStream: createChunkStream([
                    {
                        type: "tool-call",
                        payload: {
                            toolName: "runCommand",
                            toolCallId: "call-1",
                            args: { command: "rm -rf /" },
                        },
                    },
                    {
                        type: "tool-result",
                        payload: {
                            toolName: "runCommand",
                            toolCallId: "call-1",
                            args: { command: "rm -rf /" },
                            result: { status: "pending_confirmation" },
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
            })
            .onRequest(acp.methods.client.session.requestPermission, async () => ({
                outcome: { outcome: "selected", optionId: "reject_once" },
            }));

        await client.connectWith(createAcpAgentApp(runtime), async (ctx) => {
            const session = await ctx.request(acp.methods.agent.session.new, {
                cwd: "/workspace",
                mcpServers: [],
            });
            await ctx.request(acp.methods.agent.session.prompt, {
                sessionId: session.sessionId,
                prompt: [{ type: "text", text: "run destructive command" }],
            });

            expect(mockedExecuteCommand).not.toHaveBeenCalled();
            const toolUpdate = updates.find(
                (entry) => entry.update.sessionUpdate === "tool_call_update",
            );
            expect(toolUpdate?.update).toEqual(
                expect.objectContaining({ status: "failed" }),
            );
        });
    });

    it("reports max_turn_requests when the configured step budget is exhausted", async () => {
        const runtime: AcpRuntimeAgent = {
            stream: jest.fn(async () => ({
                fullStream: createChunkStream([
                    {
                        type: "tool-call",
                        payload: { toolName: "readFile", toolCallId: "call-1", args: {} },
                    },
                    {
                        type: "tool-result",
                        payload: {
                            toolName: "readFile",
                            toolCallId: "call-1",
                            result: { content: "ok" },
                        },
                    },
                ]),
                text: Promise.resolve(""),
            })),
        };

        const client = acp
            .client({ name: "iris-agent-test-client" })
            .onNotification(acp.methods.client.session.update, () => undefined);

        await client.connectWith(createAcpAgentApp(runtime), async (ctx) => {
            const session = await ctx.request(acp.methods.agent.session.new, {
                cwd: "/workspace",
                mcpServers: [],
            });
            const response = await ctx.request(acp.methods.agent.session.prompt, {
                sessionId: session.sessionId,
                prompt: [{ type: "text", text: "go" }],
                _meta: { iris: { maxSteps: 1 } },
            });

            expect(runtime.stream).toHaveBeenCalledWith(
                "go",
                expect.objectContaining({ maxSteps: 1 }),
            );
            expect(response.stopReason).toBe("max_turn_requests");
        });
    });

    it("reports usage on the prompt response when the runtime emits token usage", async () => {
        const runtime: AcpRuntimeAgent = {
            stream: jest.fn(async () => ({
                fullStream: createChunkStream([
                    {
                        type: "text-delta",
                        payload: {
                            text: "Hi",
                            usage: {
                                inputTokens: 10,
                                outputTokens: 5,
                                totalTokens: 15,
                            },
                        },
                    },
                ]),
                text: Promise.resolve("Hi"),
            })),
        };

        const client = acp
            .client({ name: "iris-agent-test-client" })
            .onNotification(acp.methods.client.session.update, () => undefined);

        await client.connectWith(createAcpAgentApp(runtime), async (ctx) => {
            const session = await ctx.request(acp.methods.agent.session.new, {
                cwd: "/workspace",
                mcpServers: [],
            });
            const response = await ctx.request(acp.methods.agent.session.prompt, {
                sessionId: session.sessionId,
                prompt: [{ type: "text", text: "hi" }],
            });

            expect(response.usage).toEqual({
                inputTokens: 10,
                outputTokens: 5,
                totalTokens: 15,
            });
        });
    });

    it("notifies suspended tool calls and reports them in prompt response metadata", async () => {
        const runtime: AcpRuntimeAgent = {
            stream: jest.fn(async () => ({
                fullStream: createChunkStream([
                    {
                        type: "tool-call",
                        payload: { toolName: "askUser", toolCallId: "call-1", args: {} },
                    },
                    {
                        type: "tool-suspended",
                        payload: {
                            toolName: "askUser",
                            toolCallId: "call-1",
                            suspendPayload: { question: "Which environment?" },
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
            const session = await ctx.request(acp.methods.agent.session.new, {
                cwd: "/workspace",
                mcpServers: [],
            });
            const response = await ctx.request(acp.methods.agent.session.prompt, {
                sessionId: session.sessionId,
                prompt: [{ type: "text", text: "deploy" }],
            });

            expect(response.stopReason).toBe("end_turn");
            expect(
                (response as { _meta?: { iris?: { suspendedTools?: unknown[] } } })._meta
                    ?.iris?.suspendedTools,
            ).toHaveLength(1);
            expect(
                updates.some(
                    (entry) =>
                        entry.update.sessionUpdate === "agent_message_chunk" &&
                        "content" in entry.update &&
                        entry.update.content.type === "text" &&
                        entry.update.content.text.includes("Which environment?"),
                ),
            ).toBe(true);
        });
    });

    it("persists chat history and reloads it via session/load", async () => {
        const runtime: AcpRuntimeAgent = {
            stream: jest.fn(async () => ({
                fullStream: createChunkStream([
                    { type: "text-delta", payload: { text: "Hello there" } },
                ]),
                text: Promise.resolve("Hello there"),
            })),
        };

        const client = acp
            .client({ name: "iris-agent-test-client" })
            .onNotification(acp.methods.client.session.update, () => undefined);

        let chatSessionId = "";
        try {
            await client.connectWith(createAcpAgentApp(runtime), async (ctx) => {
                chatSessionId = `parity-test-${Date.now()}`;
                const session = await ctx.request(acp.methods.agent.session.new, {
                    cwd: "/workspace",
                    mcpServers: [],
                    _meta: { iris: { chatSessionId } },
                });
                expect(session.sessionId).toBe(chatSessionId);

                await ctx.request(acp.methods.agent.session.prompt, {
                    sessionId: session.sessionId,
                    prompt: [{ type: "text", text: "Say hi" }],
                });
            });

            const persisted = JSON.parse(
                await fs.readFile(chatSessionPath(chatSessionId), "utf8"),
            );
            expect(persisted.messages).toEqual([
                { role: "user", content: "Say hi" },
                { role: "assistant", content: "Hello there" },
            ]);

            const reloadUpdates: acp.SessionNotification[] = [];
            const reloadClient = acp
                .client({ name: "iris-agent-test-client-2" })
                .onNotification(acp.methods.client.session.update, (ctx) => {
                    reloadUpdates.push(ctx.params);
                });
            await reloadClient.connectWith(
                createAcpAgentApp(runtime),
                async (ctx) => {
                    await ctx.request(acp.methods.agent.session.load, {
                        sessionId: chatSessionId,
                        cwd: "/workspace",
                        mcpServers: [],
                    });

                    const replayed = reloadUpdates.filter(
                        (entry) =>
                            entry.update.sessionUpdate === "user_message_chunk" ||
                            entry.update.sessionUpdate === "agent_message_chunk",
                    );
                    expect(replayed).toHaveLength(2);
                },
            );
        } finally {
            await fs.rm(chatSessionPath(chatSessionId), { force: true });
        }
    });
});
