import { spawn, type ChildProcessByStdio } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

export type IrisClientOptions = {
    clientName?: string;
    clientVersion?: string;
    onSessionUpdate?: (notification: acp.SessionNotification) => void;
    /**
     * Called when the agent asks the client to approve or reject a tool call
     * (e.g. a shell command) via `session/request_permission`. Return the
     * outcome describing the user's decision. If omitted, IrisClient
     * responds with `cancelled`, which the agent treats as a rejection.
     */
    onRequestPermission?: (
        params: acp.RequestPermissionRequest,
    ) => Promise<acp.RequestPermissionOutcome> | acp.RequestPermissionOutcome;
};

export type SpawnIrisClientOptions = IrisClientOptions & {
    command?: string;
    args?: string[];
    cwd: string;
    env?: NodeJS.ProcessEnv;
};

export type IrisClientTransport = acp.Stream | acp.AgentApp;

export type OpenSessionOptions = {
    modelId?: string;
    chatSessionId?: string;
    mcpServers?: acp.McpServer[];
    additionalDirectories?: string[];
    meta?: Record<string, unknown>;
};

export type PromptOptions = {
    modelId?: string;
    maxSteps?: number;
    meta?: Record<string, unknown>;
};

export class IrisClient {
    private readonly connection: acp.ClientConnection;
    private readonly context: acp.ClientContext;
    private closeTransport?: () => void;
    private activeSession?: acp.ActiveSession;
    private openingSession?: Promise<string>;
    private closed = false;

    private constructor(
        connection: acp.ClientConnection,
        context: acp.ClientContext,
    ) {
        this.connection = connection;
        this.context = context;
    }

    static async connect(
        transport: IrisClientTransport,
        options: IrisClientOptions = {},
    ): Promise<IrisClient> {
        const app = acp
            .client({ name: options.clientName ?? "iris-client" })
            .onNotification(acp.methods.client.session.update, (ctx) => {
                options.onSessionUpdate?.(ctx.params);
            })
            .onRequest(acp.methods.client.session.requestPermission, async (ctx) => {
                const outcome = options.onRequestPermission
                    ? await options.onRequestPermission(ctx.params)
                    : { outcome: "cancelled" as const };
                return { outcome };
            });
        const connection =
            transport instanceof acp.AgentApp
                ? app.connect(transport)
                : app.connect(transport);
        const context = connection.agent;

        try {
            await context.request(acp.methods.agent.initialize, {
                protocolVersion: acp.PROTOCOL_VERSION,
                clientCapabilities: {},
                clientInfo: {
                    name: options.clientName ?? "iris-client",
                    version: options.clientVersion ?? "0.1.0",
                },
            });
        } catch (error) {
            connection.close(error);
            throw error;
        }

        return new IrisClient(connection, context);
    }

    static async spawn(options: SpawnIrisClientOptions): Promise<SpawnedIrisClient> {
        const child = spawn(
            options.command ?? "iris-agent",
            options.args ?? ["--workspace", options.cwd, "--acp"],
            {
                cwd: options.cwd,
                env: { ...process.env, ...options.env },
                stdio: ["pipe", "pipe", "inherit"],
            },
        );
        const output = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
        const input = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
        let rejectProcessError: (error: Error) => void = () => undefined;
        const processError = new Promise<never>((_, reject) => {
            rejectProcessError = reject;
        });
        const onProcessError = (error: Error) => rejectProcessError(error);
        child.once("error", onProcessError);

        try {
            const client = await Promise.race([
                IrisClient.connect(acp.ndJsonStream(output, input), options),
                processError,
            ]);
            child.off("error", onProcessError);
            client.ownTransport(() => {
                if (child.exitCode === null && child.signalCode === null) child.kill();
            });
            return { client, process: child };
        } catch (error) {
            child.off("error", onProcessError);
            if (child.exitCode === null && child.signalCode === null) child.kill();
            throw error;
        }
    }

    async openSession(
        cwd: string,
        options?: OpenSessionOptions,
    ): Promise<string> {
        this.assertOpen();
        if (this.activeSession) {
            throw new Error("An ACP session is already open");
        }
        if (this.openingSession) {
            throw new Error("An ACP session is already opening");
        }

        const openingSession = (async () => {
            let builder = this.context.buildSession(cwd);
            if (options?.additionalDirectories) {
                builder = builder.withAdditionalDirectories(options.additionalDirectories);
            }
            if (options?.mcpServers) {
                for (const server of options.mcpServers) {
                    builder = builder.withMcpServer(server);
                }
            }
            if (options?.modelId || options?.chatSessionId || options?.meta) {
                const req = (builder as unknown as { request: Record<string, unknown> }).request;
                req._meta = {
                    ...(options?.meta ?? {}),
                    iris: {
                        ...(typeof options?.meta?.iris === "object"
                            ? (options.meta.iris as Record<string, unknown>)
                            : {}),
                        ...(options?.modelId ? { modelId: options.modelId } : {}),
                        ...(options?.chatSessionId
                            ? { chatSessionId: options.chatSessionId }
                            : {}),
                    },
                    ...(options?.modelId ? { modelId: options.modelId } : {}),
                };
            }
            const session = await builder.start();
            this.activeSession = session;
            return session.sessionId;
        })();

        this.openingSession = openingSession;
        try {
            return await openingSession;
        } finally {
            if (this.openingSession === openingSession) {
                this.openingSession = undefined;
            }
        }
    }

    async setModel(modelId: string): Promise<void> {
        this.assertOpen();
        if (!this.activeSession) {
            throw new Error("Open an ACP session before setting configuration options");
        }
        await this.context.request(acp.methods.agent.session.setConfigOption, {
            sessionId: this.activeSession.sessionId,
            configId: "model",
            value: modelId,
        });
    }

    async prompt(
        prompt: string | acp.ContentBlock[],
        options?: PromptOptions,
    ): Promise<acp.PromptResponse> {
        this.assertOpen();
        if (!this.activeSession) {
            throw new Error("Open an ACP session before prompting");
        }
        if (options?.modelId || options?.maxSteps || options?.meta) {
            const promptBlocks =
                typeof prompt === "string"
                    ? [{ type: "text" as const, text: prompt }]
                    : Array.isArray(prompt)
                    ? prompt
                    : [prompt];
            return this.context.request(acp.methods.agent.session.prompt, {
                sessionId: this.activeSession.sessionId,
                prompt: promptBlocks,
                _meta: {
                    ...(options?.meta ?? {}),
                    iris: {
                        ...(typeof options?.meta?.iris === "object"
                            ? (options.meta.iris as Record<string, unknown>)
                            : {}),
                        ...(options?.modelId ? { modelId: options.modelId } : {}),
                        ...(typeof options?.maxSteps === "number"
                            ? { maxSteps: options.maxSteps }
                            : {}),
                    },
                    ...(options?.modelId ? { modelId: options.modelId } : {}),
                },
            });
        }
        return this.activeSession.prompt(prompt);
    }

    async cancel(): Promise<void> {
        this.assertOpen();
        if (!this.activeSession) return;
        await this.context.notify(acp.methods.agent.session.cancel, {
            sessionId: this.activeSession.sessionId,
        });
    }

    async closeSession(): Promise<void> {
        this.assertOpen();
        if (!this.activeSession) return;
        const activeSession = this.activeSession;
        const sessionId = activeSession.sessionId;
        await this.context.request(acp.methods.agent.session.close, { sessionId });
        activeSession.dispose();
        if (this.activeSession === activeSession) {
            this.activeSession = undefined;
        }
    }

    async close(): Promise<void> {
        if (this.closed) return;
        try {
            if (this.activeSession) await this.closeSession();
        } finally {
            this.closed = true;
            this.connection.close();
            this.closeTransport?.();
            await this.connection.closed;
        }
    }

    private assertOpen(): void {
        if (this.closed) throw new Error("ACP client is closed");
    }

    private ownTransport(closeTransport: () => void): void {
        this.closeTransport = closeTransport;
    }
}

export type SpawnedIrisClient = {
    client: IrisClient;
    process: ChildProcessByStdio<Writable, Readable, null>;
};

export async function spawnIrisClient(
    options: SpawnIrisClientOptions,
): Promise<SpawnedIrisClient> {
    return IrisClient.spawn(options);
}
