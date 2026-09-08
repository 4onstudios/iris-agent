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
                { workspaceRoot: "/workspace" },
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
});