import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import path from "path";
import {
  getToolCallSignature,
  resolveToolExecutionStatus,
} from "../core/agent/utils/toolLifecycle";

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
    signal?: AbortSignal;
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

type PendingToolInvocation = {
  protocolToolCallId: string;
  runtimeToolCallId?: string;
  operationKey: string;
};

export function assertAcpWorkspace(
  params: { workspaceRoot?: unknown; cwd?: unknown } | null | undefined,
  boundWorkspaceRoot: string,
): void {
  const requestedWorkspace =
    typeof params?.workspaceRoot === "string"
      ? params.workspaceRoot
      : typeof params?.cwd === "string"
        ? params.cwd
        : undefined;
  if (
    requestedWorkspace &&
    path.resolve(requestedWorkspace) !== path.resolve(boundWorkspaceRoot)
  ) {
    throw new Error(
      `This ACP process is bound to '${path.resolve(boundWorkspaceRoot)}'. Close it and respawn iris-agent with --workspace '${path.resolve(requestedWorkspace)}' to switch workspaces.`,
    );
  }
}

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

export const createAcpAgentApp = (
  runtimeAgent: AcpRuntimeAgent,
  workspaceRoot?: string,
): acp.AgentApp => {
  const boundWorkspaceRoot = workspaceRoot
    ? path.resolve(workspaceRoot)
    : undefined;
  const sessions = new Map<string, AcpSessionState>();

  const cancelActiveTurn = async (
    activeTurn: ActiveTurn | undefined,
  ): Promise<void> => {
    if (!activeTurn) return;
    activeTurn.abortController.abort();
    await activeTurn.cancelStream?.().catch(() => undefined);
  };

  const cancelSessionTurn = async (sessionId: string): Promise<void> => {
    await cancelActiveTurn(sessions.get(sessionId)?.activeTurn);
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
      if (boundWorkspaceRoot) {
        assertAcpWorkspace({ cwd: ctx.params.cwd }, boundWorkspaceRoot);
      }
      const sessionId = randomUUID();
      sessions.set(sessionId, { cwd: boundWorkspaceRoot || ctx.params.cwd });
      return { sessionId };
    })
    .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
      const sessionId = ctx.params.sessionId;
      const session = sessions.get(sessionId);
      if (!session) {
        throw new Error(`Unknown ACP session '${sessionId}'`);
      }

      const activeTurn: ActiveTurn = { abortController: new AbortController() };
      const previousTurn = session.activeTurn;
      session.activeTurn = activeTurn;
      await cancelActiveTurn(previousTurn);
      const promptText = toPromptText(ctx.params.prompt);
      const turnSignal = activeTurn.abortController.signal;
      if (sessions.get(sessionId) !== session || turnSignal.aborted) {
        return { stopReason: "cancelled" as const };
      }
      const abortedMarker = Symbol("aborted");
      const raceWithAbort = async <T>(
        startWork: () => Promise<T>,
      ): Promise<T> => {
        if (turnSignal.aborted) {
          throw new Error("ACP session turn cancelled");
        }

        let onAbort: (() => void) | undefined;
        const abortWait = new Promise<T | typeof abortedMarker>((resolve) => {
          onAbort = () => resolve(abortedMarker);
          turnSignal.addEventListener("abort", onAbort, { once: true });
        });
        const cleanup = () => {
          if (onAbort) {
            turnSignal.removeEventListener("abort", onAbort);
            onAbort = undefined;
          }
        };
        const work = Promise.resolve().then(() => startWork());
        work.then(cleanup, cleanup);

        const result = await Promise.race<T | typeof abortedMarker>([
          work,
          abortWait,
        ]);
        cleanup();
        if (result === abortedMarker) {
          throw new Error("ACP session turn cancelled");
        }
        return result;
      };

      try {
        if (runtimeAgent.stream) {
          const streamResult = await raceWithAbort(
            async () =>
              (runtimeAgent.stream as NonNullable<AcpRuntimeAgent["stream"]>)(
                promptText,
                {
                  workspaceRoot: session.cwd,
                  signal: turnSignal,
                },
              ) as Promise<AgentStreamResult>,
          );
          const reader = streamResult.fullStream.getReader();
          activeTurn.cancelStream = async () => reader.cancel();
          const pendingToolInvocations = new Map<
            string,
            PendingToolInvocation[]
          >();
          const generatedToolCallCounts = new Map<string, number>();
          const usedProtocolToolCallIds = new Set<string>();
          const runtimeSignaturesByToolCall = new Map<string, Set<string>>();
          const runtimeProtocolIdByOperation = new Map<string, string>();
          let emittedText = false;

          const normalizeToolArgs = (
            rawArgs: unknown,
          ): Record<string, unknown> => {
            if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
              return {};
            }
            return rawArgs as Record<string, unknown>;
          };

          const hasArgumentDetails = (toolArgs: Record<string, unknown>): boolean =>
            Object.keys(toolArgs).length > 0;

          const buildRuntimeCallKey = (
            toolName: string,
            runtimeToolCallId: string,
          ): string =>
            `${toolName}:${runtimeToolCallId}`;

          const buildRuntimeOperationKey = (
            toolName: string,
            runtimeToolCallId: string,
            signature: string,
          ): string =>
            `${buildRuntimeCallKey(toolName, runtimeToolCallId)}:${signature}`;

          const allocateGeneratedToolCallId = (toolName: string): string => {
            let occurrence = generatedToolCallCounts.get(toolName) || 0;
            while (true) {
              occurrence += 1;
              const candidate = `generated-${toolName}-${occurrence}`;
              if (!usedProtocolToolCallIds.has(candidate)) {
                generatedToolCallCounts.set(toolName, occurrence);
                usedProtocolToolCallIds.add(candidate);
                return candidate;
              }
            }
          };

          const resolveProtocolToolCallId = (
            toolName: string,
            runtimeToolCallId: string | undefined,
            toolArgs: Record<string, unknown>,
          ): string => {
            if (!runtimeToolCallId) {
              return allocateGeneratedToolCallId(toolName);
            }

            const signature = getToolCallSignature(toolName, toolArgs);
            const runtimeOperationKey = buildRuntimeOperationKey(
              toolName,
              runtimeToolCallId,
              signature,
            );
            const existingProtocolId =
              runtimeProtocolIdByOperation.get(runtimeOperationKey);
            if (existingProtocolId) {
              usedProtocolToolCallIds.add(existingProtocolId);
              return existingProtocolId;
            }

            const runtimeCallKey = buildRuntimeCallKey(toolName, runtimeToolCallId);
            const signatures =
              runtimeSignaturesByToolCall.get(runtimeCallKey) || new Set<string>();
            runtimeSignaturesByToolCall.set(runtimeCallKey, signatures);

            const protocolToolCallId =
              usedProtocolToolCallIds.has(runtimeToolCallId) ||
              (signatures.size > 0 && !signatures.has(signature))
                ? allocateGeneratedToolCallId(toolName)
                : runtimeToolCallId;

            signatures.add(signature);
            runtimeProtocolIdByOperation.set(
              runtimeOperationKey,
              protocolToolCallId,
            );
            usedProtocolToolCallIds.add(protocolToolCallId);
            return protocolToolCallId;
          };

          const resolveMappedProtocolIdForOmittedArgs = (
            toolName: string,
            runtimeToolCallId: string,
          ): string | undefined => {
            const runtimeCallKey = buildRuntimeCallKey(toolName, runtimeToolCallId);
            const signatures = runtimeSignaturesByToolCall.get(runtimeCallKey);
            if (!signatures || signatures.size !== 1) {
              return undefined;
            }

            const [signature] = Array.from(signatures);
            if (!signature) {
              return undefined;
            }

            return runtimeProtocolIdByOperation.get(
              buildRuntimeOperationKey(toolName, runtimeToolCallId, signature),
            );
          };

          const consumePendingInvocation = (
            toolName: string,
            suppliedToolCallId: unknown,
            rawToolArgs: unknown,
          ): { invocation?: PendingToolInvocation; toolCallId: string } => {
            const pending = pendingToolInvocations.get(toolName) || [];
            const toolArgs = normalizeToolArgs(rawToolArgs);
            const hasArgs = hasArgumentDetails(toolArgs);

            if (
              typeof suppliedToolCallId === "string" &&
              suppliedToolCallId.length > 0
            ) {
              if (hasArgs) {
                const signature = getToolCallSignature(toolName, toolArgs);
                const runtimeOperationKey = buildRuntimeOperationKey(
                  toolName,
                  suppliedToolCallId,
                  signature,
                );
                const matchIndex = pending.findIndex(
                  (entry) =>
                    entry.runtimeToolCallId === suppliedToolCallId &&
                    entry.operationKey === runtimeOperationKey,
                );
                if (matchIndex >= 0) {
                  const [invocation] = pending.splice(matchIndex, 1);
                  return {
                    invocation,
                    toolCallId: invocation.protocolToolCallId,
                  };
                }

                const mappedProtocolId =
                  runtimeProtocolIdByOperation.get(runtimeOperationKey);
                if (mappedProtocolId) {
                  return { toolCallId: mappedProtocolId };
                }

                return {
                  toolCallId: resolveProtocolToolCallId(
                    toolName,
                    suppliedToolCallId,
                    toolArgs,
                  ),
                };
              }

              const sameIdEntries = pending.filter(
                (entry) => entry.runtimeToolCallId === suppliedToolCallId,
              );
              if (sameIdEntries.length === 1) {
                const [invocation] = sameIdEntries;
                const matchIndex = pending.findIndex(
                  (entry) => entry === invocation,
                );
                if (matchIndex >= 0) {
                  pending.splice(matchIndex, 1);
                }
                return {
                  invocation,
                  toolCallId: invocation.protocolToolCallId,
                };
              }

              const mappedProtocolId = resolveMappedProtocolIdForOmittedArgs(
                toolName,
                suppliedToolCallId,
              );
              if (mappedProtocolId) {
                const matchIndex = pending.findIndex(
                  (entry) =>
                    entry.runtimeToolCallId === suppliedToolCallId &&
                    entry.protocolToolCallId === mappedProtocolId,
                );
                if (matchIndex >= 0) {
                  const [invocation] = pending.splice(matchIndex, 1);
                  return {
                    invocation,
                    toolCallId: invocation.protocolToolCallId,
                  };
                }

                return { toolCallId: mappedProtocolId };
              }

              return {
                toolCallId: resolveProtocolToolCallId(
                  toolName,
                  suppliedToolCallId,
                  toolArgs,
                ),
              };
            }

            if (pending.length > 0) {
              const invocation = pending.shift() as PendingToolInvocation;
              return {
                invocation,
                toolCallId: invocation.protocolToolCallId,
              };
            }

            return { toolCallId: allocateGeneratedToolCallId(toolName) };
          };

          while (true) {
            if (activeTurn.abortController.signal.aborted) {
              await reader.cancel().catch(() => undefined);
              return { stopReason: "cancelled" as const };
            }

            const { value, done } = await raceWithAbort(() => reader.read());
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
              const toolArgs = normalizeToolArgs(value.payload?.args);
              const suppliedToolCallId = value.payload?.toolCallId;
              const runtimeToolCallId =
                typeof suppliedToolCallId === "string" &&
                suppliedToolCallId.length > 0
                  ? suppliedToolCallId
                  : undefined;
              const toolCallId = resolveProtocolToolCallId(
                toolName,
                runtimeToolCallId,
                toolArgs,
              );
              const pending = pendingToolInvocations.get(toolName) || [];
              const signature = getToolCallSignature(toolName, toolArgs);
              pending.push({
                protocolToolCallId: toolCallId,
                runtimeToolCallId,
                operationKey: runtimeToolCallId
                  ? buildRuntimeOperationKey(toolName, runtimeToolCallId, signature)
                  : `${toolCallId}:${signature}`,
              });
              pendingToolInvocations.set(toolName, pending);
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
              const suppliedToolCallId = value.payload?.toolCallId;
              const consumed = consumePendingInvocation(
                toolName,
                suppliedToolCallId,
                value.payload?.args,
              );
              const toolCallId = consumed.toolCallId;
              const hasMatchingCall = Boolean(consumed.invocation);
              if (!hasMatchingCall) {
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
                  status:
                    resolveToolExecutionStatus(output) === "failed"
                      ? "failed"
                      : "completed",
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

          for (const invocations of pendingToolInvocations.values()) {
            for (const invocation of invocations) {
              await ctx.client.notify(acp.methods.client.session.update, {
                sessionId: ctx.params.sessionId,
                update: {
                  sessionUpdate: "tool_call_update",
                  toolCallId: invocation.protocolToolCallId,
                  status: "failed",
                  content: [
                    {
                      type: "content",
                      content: {
                        type: "text",
                        text: "Tool call did not report a result before the turn ended.",
                      },
                    },
                  ],
                },
              });
            }
          }
          pendingToolInvocations.clear();

          const finalText = await raceWithAbort(() => streamResult.text);
          if (activeTurn.abortController.signal.aborted) {
            return { stopReason: "cancelled" as const };
          }
          if (!emittedText && finalText) {
            await ctx.client.notify(acp.methods.client.session.update, {
              sessionId: ctx.params.sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: finalText },
              },
            });
          }
          if (activeTurn.abortController.signal.aborted) {
            return { stopReason: "cancelled" as const };
          }
          return { stopReason: "end_turn" as const };
        }

        const generated = await raceWithAbort(async () =>
          runtimeAgent.generate
            ? runtimeAgent.generate(promptText, {
              workspaceRoot: session.cwd,
              signal: turnSignal,
            })
            : runtimeAgent.chat
              ? runtimeAgent.chat({
                messages: [{ role: "user", content: promptText }],
                signal: turnSignal,
              })
              : Promise.resolve(undefined),
        );
        if (activeTurn.abortController.signal.aborted) {
          return { stopReason: "cancelled" as const };
        }
        const responseText = extractText(generated);
        if (responseText) {
          if (activeTurn.abortController.signal.aborted) {
            return { stopReason: "cancelled" as const };
          }
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
      await cancelActiveTurn(sessions.get(ctx.params.sessionId)?.activeTurn);
      sessions.delete(ctx.params.sessionId);
      return {};
    })
    .onNotification(acp.methods.agent.session.cancel, async (ctx) => {
      await cancelSessionTurn(ctx.params.sessionId);
    });
};

export async function startAcpServer(
  runtimeAgent: AcpRuntimeAgent,
  workspaceRoot?: string,
): Promise<void> {
  const output = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
  const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
  const connection = createAcpAgentApp(runtimeAgent, workspaceRoot).connect(
    acp.ndJsonStream(output, input),
  );

  console.error("ACP agent ready: iris-agent@0.1.0 (stdio)");
  await connection.closed;
}
