import { spawn, type ChildProcessByStdio } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

export type IrisClientOptions = {
    clientName?: string;
    clientVersion?: string;
    onSessionUpdate?: (notification: acp.SessionNotification) => void;
};

export type SpawnIrisClientOptions = IrisClientOptions & {
    command?: string;
    args?: string[];
    cwd: string;
    env?: NodeJS.ProcessEnv;
};

export type IrisClientTransport = acp.Stream | acp.AgentApp;

export class IrisClient {
    private readonly connection: acp.ClientConnection;
    private readonly context: acp.ClientContext;
    private closeTransport?: () => void;
    private activeSession?: acp.ActiveSession;
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

    async openSession(cwd: string): Promise<string> {
        this.assertOpen();
        if (this.activeSession) {
            throw new Error("An ACP session is already open");
        }
        this.activeSession = await this.context.buildSession(cwd).start();
        return this.activeSession.sessionId;
    }

    async prompt(prompt: string | acp.ContentBlock[]): Promise<acp.PromptResponse> {
        this.assertOpen();
        if (!this.activeSession) {
            throw new Error("Open an ACP session before prompting");
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
        const sessionId = this.activeSession.sessionId;
        this.activeSession.dispose();
        this.activeSession = undefined;
        await this.context.request(acp.methods.agent.session.close, { sessionId });
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
