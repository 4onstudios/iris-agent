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
        });
        expect(updates).toEqual([
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
});