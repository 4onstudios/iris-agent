import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

type AgentStreamChunk = {
  type?: string;
  payload?: Record<string, unknown>;
};

type AgentStreamResult = {
  fullStream: {
    getReader(): {
      read(): Promise<{ done: boolean; value?: AgentStreamChunk }>;
      cancel(reason?: unknown): Promise<void>;
    };
  };
  text: Promise<string>;
};

export type AcpRuntimeAgent = {
  stream?: (
    input: string,
    options: Record<string, unknown>,
  ) => Promise<unknown>;
  generate?: (
    input: string,
    options?: Record<string, unknown>,
  ) => Promise<{ text?: string }>;
  chat?: (request: {
    messages: Array<{ role: "user"; content: string }>;
  }) => Promise<unknown>;
};

type ActiveTurn = {
  abortController: AbortController;
  cancelStream?: () => Promise<void>;
};

type AcpSessionState = {
  cwd: string;
  activeTurn?: ActiveTurn;
};

const toPromptText = (prompt: acp.ContentBlock[]): string =>
  prompt
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "resource_link") {
        return `[Resource: ${block.name || block.uri}](${block.uri})`;
      }
      if (block.type === "resource" && "text" in block.resource) {
        return block.resource.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n\n");

const toToolKind = (toolName: string): acp.ToolKind => {
  const normalized = toolName.toLowerCase();
  if (normalized.includes("read") || normalized.includes("view")) return "read";
  if (normalized.includes("write") || normalized.includes("edit")) return "edit";
  if (normalized.includes("delete")) return "delete";
  if (normalized.includes("move") || normalized.includes("rename")) return "move";
  if (normalized.includes("search") || normalized.includes("grep")) return "search";
  if (normalized.includes("terminal") || normalized.includes("command")) return "execute";
  if (normalized.includes("fetch") || normalized.includes("http")) return "fetch";
  return "other";
};

const extractText = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
    if (typeof record.content === "string") return record.content;
  }
  return value === undefined ? "" : JSON.stringify(value);
};

export const createAcpAgentApp = (runtimeAgent: AcpRuntimeAgent): acp.AgentApp => {
  const sessions = new Map<string, AcpSessionState>();

  const cancelSessionTurn = async (sessionId: string): Promise<void> => {
    const activeTurn = sessions.get(sessionId)?.activeTurn;
    if (!activeTurn) return;
    activeTurn.abortController.abort();
    await activeTurn.cancelStream?.().catch(() => undefined);
  };

  return acp
    .agent({ name: "iris-agent" })
    .onRequest(acp.methods.agent.initialize, async () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        sessionCapabilities: { close: {} },
      },
      agentInfo: {
        name: "iris-agent",
        version: "0.1.0",
      },
    }))
    .onRequest(acp.methods.agent.session.new, async (ctx) => {
      const sessionId = randomUUID();
      sessions.set(sessionId, { cwd: ctx.params.cwd });
      return { sessionId };
    })
    .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
      const session = sessions.get(ctx.params.sessionId);
      if (!session) {
        throw new Error(`Unknown ACP session '${ctx.params.sessionId}'`);
      }

      await cancelSessionTurn(ctx.params.sessionId);
      const activeTurn: ActiveTurn = { abortController: new AbortController() };
      session.activeTurn = activeTurn;
      const promptText = toPromptText(ctx.params.prompt);

      try {
        if (runtimeAgent.stream) {
          const streamResult = (await runtimeAgent.stream(promptText, {
            workspaceRoot: session.cwd,
          })) as AgentStreamResult;
          const reader = streamResult.fullStream.getReader();
          activeTurn.cancelStream = async () => reader.cancel();
          const knownToolCalls = new Set<string>();
          let emittedText = false;

          while (true) {
            if (activeTurn.abortController.signal.aborted) {
              await reader.cancel().catch(() => undefined);
              return { stopReason: "cancelled" as const };
            }

            const { value, done } = await reader.read();
            if (activeTurn.abortController.signal.aborted) {
              return { stopReason: "cancelled" as const };
            }
            if (done) break;
            if (!value?.type) continue;

            if (value.type === "text-delta" || value.type === "reasoning-delta") {
              const text = String(value.payload?.text || "");
              if (!text) continue;
              if (value.type === "text-delta") emittedText = true;
              await ctx.client.notify(acp.methods.client.session.update, {
                sessionId: ctx.params.sessionId,
                update: {
                  sessionUpdate:
                    value.type === "reasoning-delta"
                      ? "agent_thought_chunk"
                      : "agent_message_chunk",
                  content: { type: "text", text },
                },
              });
              continue;
            }

            if (value.type === "tool-call") {
              const toolName = String(value.payload?.toolName || "tool");
              const toolCallId = String(value.payload?.toolCallId || randomUUID());
              knownToolCalls.add(toolCallId);
              await ctx.client.notify(acp.methods.client.session.update, {
                sessionId: ctx.params.sessionId,
                update: {
                  sessionUpdate: "tool_call",
                  toolCallId,
                  title: toolName,
                  name: toolName,
                  kind: toToolKind(toolName),
                  status: "in_progress",
                  rawInput: value.payload?.args,
                },
              });
              continue;
            }

            if (value.type === "tool-result") {
              const toolName = String(value.payload?.toolName || "tool");
              const toolCallId = String(value.payload?.toolCallId || randomUUID());
              if (!knownToolCalls.has(toolCallId)) {
                knownToolCalls.add(toolCallId);
                await ctx.client.notify(acp.methods.client.session.update, {
                  sessionId: ctx.params.sessionId,
                  update: {
                    sessionUpdate: "tool_call",
                    toolCallId,
                    title: toolName,
                    name: toolName,
                    kind: toToolKind(toolName),
                    status: "in_progress",
                  },
                });
              }
              const output =
                value.payload?.result ??
                value.payload?.output ??
                value.payload?.content ??
                value.payload?.data;
              await ctx.client.notify(acp.methods.client.session.update, {
                sessionId: ctx.params.sessionId,
                update: {
                  sessionUpdate: "tool_call_update",
                  toolCallId,
                  status: "completed",
                  rawOutput: output,
                  content: [
                    {
                      type: "content",
                      content: { type: "text", text: extractText(output) },
                    },
                  ],
                },
              });
            }
          }

          const finalText = await streamResult.text;
          if (!emittedText && finalText) {
            await ctx.client.notify(acp.methods.client.session.update, {
              sessionId: ctx.params.sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: finalText },
              },
            });
          }
          return { stopReason: "end_turn" as const };
        }

        const generated = runtimeAgent.generate
          ? await runtimeAgent.generate(promptText, { workspaceRoot: session.cwd })
          : await runtimeAgent.chat?.({
            messages: [{ role: "user", content: promptText }],
          });
        const responseText = extractText(generated);
        if (responseText) {
          await ctx.client.notify(acp.methods.client.session.update, {
            sessionId: ctx.params.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: responseText },
            },
          });
        }
        return { stopReason: "end_turn" as const };
      } catch (error) {
        if (activeTurn.abortController.signal.aborted) {
          return { stopReason: "cancelled" as const };
        }
        throw error;
      } finally {
        if (session.activeTurn === activeTurn) {
          session.activeTurn = undefined;
        }
      }
    })
    .onRequest(acp.methods.agent.session.close, async (ctx) => {
      await cancelSessionTurn(ctx.params.sessionId);
      sessions.delete(ctx.params.sessionId);
      return {};
    })
    .onNotification(acp.methods.agent.session.cancel, async (ctx) => {
      await cancelSessionTurn(ctx.params.sessionId);
    });
};

export async function startAcpServer(runtimeAgent: AcpRuntimeAgent): Promise<void> {
  const output = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
  const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
  const connection = createAcpAgentApp(runtimeAgent).connect(
    acp.ndJsonStream(output, input),
  );

  console.error("ACP agent ready: iris-agent@0.1.0 (stdio)");
  await connection.closed;
}
