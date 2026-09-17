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
            expect(
                initialized.agentCapabilities?.sessionCapabilities?.list,
            ).toEqual({});

            const session = await ctx.request(acp.methods.agent.session.new, {
                cwd: "/workspace",
                mcpServers: [],
            });

            expect(session.configOptions).toEqual([
                expect.objectContaining({
                    id: "model",
                    category: "model",
                    currentValue: "default",
                }),
            ]);
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
            expect(persisted).toMatchObject({
                cwd: "/workspace",
                title: "Say hi",
            });

            const reloadUpdates: acp.SessionNotification[] = [];
            const reloadClient = acp
                .client({ name: "iris-agent-test-client-2" })
                .onNotification(acp.methods.client.session.update, (ctx) => {
                    reloadUpdates.push(ctx.params);
                });
            await reloadClient.connectWith(
                createAcpAgentApp(runtime),
                async (ctx) => {
                    const listed = await ctx.request(acp.methods.agent.session.list, {
                        cwd: "/workspace",
                    });
                    expect(listed.sessions).toEqual(expect.arrayContaining([
                        expect.objectContaining({
                            sessionId: chatSessionId,
                            cwd: "/workspace",
                            title: "Say hi",
                        }),
                    ]));

                    const loaded = await ctx.request(acp.methods.agent.session.load, {
                        sessionId: chatSessionId,
                        cwd: "/workspace",
                        mcpServers: [],
                    });
                    expect(loaded.configOptions).toEqual([
                        expect.objectContaining({
                            id: "model",
                            currentValue: "default",
                        }),
                    ]);

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

    it("limits session discovery to the bound workspace when cwd is omitted", async () => {
        const runtime: AcpRuntimeAgent = {};
        const sessionIds = [
            `bound-session-${Date.now()}`,
            `other-session-${Date.now()}`,
        ];
        const boundWorkspace = path.resolve("/tmp/iris-bound-workspace");
        const otherWorkspace = path.resolve("/tmp/iris-other-workspace");

        try {
            await fs.mkdir(path.dirname(chatSessionPath(sessionIds[0])), {
                recursive: true,
            });
            await Promise.all([
                fs.writeFile(
                    chatSessionPath(sessionIds[0]),
                    JSON.stringify({
                        id: sessionIds[0],
                        cwd: boundWorkspace,
                        messages: [],
                    }),
                ),
                fs.writeFile(
                    chatSessionPath(sessionIds[1]),
                    JSON.stringify({
                        id: sessionIds[1],
                        cwd: otherWorkspace,
                        messages: [],
                    }),
                ),
            ]);

            const client = acp.client({ name: "iris-agent-test-client" });
            await client.connectWith(
                createAcpAgentApp(runtime, boundWorkspace),
                async (ctx) => {
                    const listed = await ctx.request(
                        acp.methods.agent.session.list,
                        {},
                    );
                    expect(listed.sessions).toEqual(
                        expect.arrayContaining([
                            expect.objectContaining({
                                sessionId: sessionIds[0],
                                cwd: boundWorkspace,
                            }),
                        ]),
                    );
                    expect(listed.sessions).not.toEqual(
                        expect.arrayContaining([
                            expect.objectContaining({ sessionId: sessionIds[1] }),
                        ]),
                    );
                },
            );
        } finally {
            await Promise.all(
                sessionIds.map((sessionId) =>
                    fs.rm(chatSessionPath(sessionId), { force: true }),
                ),
            );
        }
    });

    it("lists legacy sessions without cwd in the requested workspace", async () => {
        const runtime: AcpRuntimeAgent = {};
        const sessionId = `legacy-session-${Date.now()}`;
        const workspace = path.resolve("/tmp/iris-legacy-workspace");

        try {
            await fs.mkdir(path.dirname(chatSessionPath(sessionId)), {
                recursive: true,
            });
            await fs.writeFile(
                chatSessionPath(sessionId),
                JSON.stringify({ id: sessionId, messages: [] }),
            );

            const client = acp.client({ name: "iris-agent-test-client" });
            await client.connectWith(
                createAcpAgentApp(runtime, workspace),
                async (ctx) => {
                    const listed = await ctx.request(
                        acp.methods.agent.session.list,
                        {},
                    );
                    expect(listed.sessions).toEqual(
                        expect.arrayContaining([
                            expect.objectContaining({ sessionId, cwd: workspace }),
                        ]),
                    );
                },
            );
        } finally {
            await fs.rm(chatSessionPath(sessionId), { force: true });
        }
    });

    it("uses the persisted workspace when loading a session", async () => {
        const persistedWorkspace = path.resolve("/tmp/iris-persisted-workspace");
        const requestedWorkspace = path.resolve("/tmp/iris-requested-workspace");
        const sessionId = `persisted-workspace-${Date.now()}`;
        const runtime: AcpRuntimeAgent = {
            generate: jest.fn(async () => ({ text: "restored" })),
        };

        try {
            await fs.mkdir(path.dirname(chatSessionPath(sessionId)), {
                recursive: true,
            });
            await fs.writeFile(
                chatSessionPath(sessionId),
                JSON.stringify({
                    id: sessionId,
                    cwd: persistedWorkspace,
                    messages: [],
                }),
            );

            const client = acp.client({ name: "iris-agent-test-client" });
            await client.connectWith(createAcpAgentApp(runtime), async (ctx) => {
                await ctx.request(acp.methods.agent.session.load, {
                    sessionId,
                    cwd: requestedWorkspace,
                    mcpServers: [],
                });
                await ctx.request(acp.methods.agent.session.prompt, {
                    sessionId,
                    prompt: [{ type: "text", text: "Continue" }],
                });
            });

            expect(runtime.generate).toHaveBeenCalledWith(
                "Continue",
                expect.objectContaining({ workspaceRoot: persistedWorkspace }),
            );
        } finally {
            await fs.rm(chatSessionPath(sessionId), { force: true });
        }
    });

    it("ignores malformed persisted metadata when listing and loading sessions", async () => {
        const workspace = path.resolve("/tmp/iris-malformed-session-workspace");
        const sessionId = `malformed-session-${Date.now()}`;
        const runtime: AcpRuntimeAgent = {};

        try {
            await fs.mkdir(path.dirname(chatSessionPath(sessionId)), {
                recursive: true,
            });
            await fs.writeFile(
                chatSessionPath(sessionId),
                JSON.stringify({
                    id: "mismatched-persisted-id",
                    cwd: workspace,
                    title: { unexpected: "title" },
                    updatedAt: "not-a-date",
                    messages: [],
                }),
            );

            const client = acp.client({ name: "iris-agent-test-client" });
            await client.connectWith(createAcpAgentApp(runtime), async (ctx) => {
                const listed = await ctx.request(
                    acp.methods.agent.session.list,
                    { cwd: workspace },
                );
                expect(listed.sessions).toEqual(
                    expect.arrayContaining([
                        expect.objectContaining({
                            sessionId,
                            cwd: workspace,
                            title: undefined,
                            updatedAt: undefined,
                        }),
                    ]),
                );
                await expect(
                    ctx.request(acp.methods.agent.session.load, {
                        sessionId,
                        cwd: workspace,
                        mcpServers: [],
                    }),
                ).resolves.toEqual(
                    expect.objectContaining({
                        configOptions: expect.any(Array),
                    }),
                );
            });
        } finally {
            await fs.rm(chatSessionPath(sessionId), { force: true });
        }
    });
});
