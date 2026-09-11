import * as acp from "@agentclientprotocol/sdk";
import { createAcpAgentApp, type AcpRuntimeAgent } from "../api/acp/acpServer";
import { IrisClient } from "../api/acp/irisClient";

describe("IrisClient", () => {
    it("manages an ACP session and forwards streamed updates", async () => {
        const runtime: AcpRuntimeAgent = {
            stream: jest.fn(async () => ({
                fullStream: new ReadableStream({
                    start(controller) {
                        controller.enqueue({
                            type: "text-delta",
                            payload: { text: "Hello from Iris" },
                        });
                        controller.close();
                    },
                }),
                text: Promise.resolve("Hello from Iris"),
            })),
        };
        const updates: acp.SessionNotification[] = [];
        const client = await IrisClient.connect(createAcpAgentApp(runtime), {
            clientName: "test-ide",
            onSessionUpdate: (notification) => updates.push(notification),
        });

        const sessionId = await client.openSession("/workspace");
        await expect(client.openSession("/other")).rejects.toThrow(
            "An ACP session is already open",
        );
        await expect(client.prompt("Say hello")).resolves.toEqual({
            stopReason: "end_turn",
        });
        expect(runtime.stream).toHaveBeenCalledWith("Say hello", {
            workspaceRoot: "/workspace",
            abortSignal: expect.any(AbortSignal),
            maxSteps: 50,
        });
        expect(updates).toEqual([
            expect.objectContaining({
                sessionId,
                update: expect.objectContaining({
                    sessionUpdate: "available_commands_update",
                }),
            }),
            expect.objectContaining({
                sessionId,
                update: expect.objectContaining({
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: "Hello from Iris" },
                }),
            }),
        ]);

        await client.closeSession();
        await expect(client.prompt("After close")).rejects.toThrow(
            "Open an ACP session before prompting",
        );
        await client.close();
    });

    it("retains the active session when closeSession fails and allows retry", async () => {
        let closeAttempts = 0;
        const agent = acp
            .agent({ name: "close-retry-agent" })
            .onRequest(acp.methods.agent.initialize, async () => ({
                protocolVersion: acp.PROTOCOL_VERSION,
                agentCapabilities: { sessionCapabilities: { close: {} } },
            }))
            .onRequest(acp.methods.agent.session.new, async () => ({
                sessionId: "session-close-retry",
            }))
            .onRequest(acp.methods.agent.session.prompt, async () => ({
                stopReason: "end_turn" as const,
            }))
            .onRequest(acp.methods.agent.session.close, async () => {
                closeAttempts += 1;
                if (closeAttempts === 1) {
                    throw new Error("temporary close failure");
                }
                return {};
            });
        const client = await IrisClient.connect(agent);
        await client.openSession("/workspace");

        await expect(client.closeSession()).rejects.toThrow();
        await expect(client.prompt("Still open")).resolves.toEqual({
            stopReason: "end_turn",
        });
        await expect(client.closeSession()).resolves.toBeUndefined();
        await expect(client.prompt("After close")).rejects.toThrow(
            "Open an ACP session before prompting",
        );
        await client.close();
    });

    it("cancels an active prompt and can be closed repeatedly", async () => {
        let markStreamStarted: () => void = () => undefined;
        const streamStarted = new Promise<void>((resolve) => {
            markStreamStarted = resolve;
        });
        const runtime: AcpRuntimeAgent = {
            stream: jest.fn(async () => ({
                fullStream: new ReadableStream({
                    start() {
                        markStreamStarted();
                    },
                }),
                text: Promise.resolve(""),
            })),
        };
        const client = await IrisClient.connect(createAcpAgentApp(runtime));
        await client.openSession("/workspace");

        const prompt = client.prompt("Keep working");
        await streamStarted;
        await client.cancel();
        await expect(prompt).resolves.toEqual({ stopReason: "cancelled" });

        await client.close();
        await expect(client.close()).resolves.toBeUndefined();
        await expect(client.openSession("/workspace")).rejects.toThrow(
            "ACP client is closed",
        );
    });

    it("rejects when the agent process cannot be started", async () => {
        await expect(
            IrisClient.spawn({
                command: "iris-agent-command-that-does-not-exist",
                cwd: process.cwd(),
            }),
        ).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("rejects a concurrent session open while the first is in flight", async () => {
        let releaseSession: () => void = () => undefined;
        const sessionGate = new Promise<void>((resolve) => {
            releaseSession = resolve;
        });
        const agent = acp
            .agent({ name: "delayed-agent" })
            .onRequest(acp.methods.agent.initialize, async () => ({
                protocolVersion: acp.PROTOCOL_VERSION,
                agentCapabilities: { sessionCapabilities: { close: {} } },
            }))
            .onRequest(acp.methods.agent.session.new, async () => {
                await sessionGate;
                return { sessionId: "session-1" };
            })
            .onRequest(acp.methods.agent.session.close, async () => ({}));
        const client = await IrisClient.connect(agent);

        const firstOpen = client.openSession("/workspace");
        await expect(client.openSession("/other")).rejects.toThrow(
            "An ACP session is already opening",
        );
        releaseSession();
        await expect(firstOpen).resolves.toBe("session-1");
        await client.close();
    });
});