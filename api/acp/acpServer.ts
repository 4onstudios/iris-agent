import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";
import os from "node:os";
import fs from "node:fs/promises";
import * as acp from "@agentclientprotocol/sdk";
import path from "path";
import {
  getToolCallSignature,
  resolveToolExecutionStatus,
} from "../core/agent/utils/toolLifecycle";
import { executeCommand } from "../core/agent/tools/executeCommand";
import {
  getSlashCommandDescriptors,
  isSlashCommandsFeatureEnabled,
} from "../helpers/slashCommands";
import {
  extractTokenUsageFromChunkPayload,
  mergeTokenUsage,
  type TokenUsageSummary,
} from "../helpers/tokenUsage";

const DEFAULT_MAX_STEPS = 50;

const CHAT_SESSIONS_DIR = path.join(os.homedir(), ".iris", "chat-sessions");

type PersistedChatMessage = {
  role: "user" | "assistant";
  content: string;
};

type PersistedChatSession = {
  id: string;
  title?: string;
  createdAt?: number;
  updatedAt?: number;
  messages: PersistedChatMessage[];
};

const isSafeChatSessionId = (sessionId: string): boolean =>
  /^[A-Za-z0-9._:-]+$/.test(sessionId);

const getChatSessionPath = (sessionId: string): string =>
  path.join(CHAT_SESSIONS_DIR, `${sessionId}.json`);

const loadPersistedChatSession = async (
  sessionId: string,
): Promise<PersistedChatSession | undefined> => {
  if (!isSafeChatSessionId(sessionId)) return undefined;
  try {
    const raw = await fs.readFile(getChatSessionPath(sessionId), "utf8");
    const parsed = JSON.parse(raw) as PersistedChatSession;
    if (!Array.isArray(parsed?.messages)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
};

const savePersistedChatSession = async (
  sessionId: string,
  messages: PersistedChatMessage[],
  existing?: PersistedChatSession,
): Promise<void> => {
  if (!isSafeChatSessionId(sessionId)) return;
  const timestamp = Date.now();
  const payload: PersistedChatSession = {
    id: sessionId,
    title: existing?.title,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
    messages,
  };
  try {
    await fs.mkdir(CHAT_SESSIONS_DIR, { recursive: true });
    await fs.writeFile(
      getChatSessionPath(sessionId),
      JSON.stringify(payload, null, 2),
      "utf8",
    );
  } catch {
    // Persistence is best-effort; the in-memory session remains usable.
  }
};

type IrisMetaExtension = {
  chatSessionId?: string;
  maxSteps?: number;
};

const readIrisMeta = (
  meta: { [key: string]: unknown } | null | undefined,
): IrisMetaExtension => {
  const iris = meta && typeof meta === "object" ? meta.iris : undefined;
  if (!iris || typeof iris !== "object") return {};
  const record = iris as Record<string, unknown>;
  return {
    chatSessionId:
      typeof record.chatSessionId === "string"
        ? record.chatSessionId
        : undefined,
    maxSteps:
      typeof record.maxSteps === "number" && Number.isFinite(record.maxSteps)
        ? Math.max(1, Math.floor(record.maxSteps))
        : undefined,
  };
};

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
    abortSignal?: AbortSignal;
  }) => Promise<unknown>;
};

type ActiveTurn = {
  abortController: AbortController;
  cancelStream?: () => Promise<void>;
};

type AcpSessionState = {
  cwd: string;
  activeTurn?: ActiveTurn;
  history: PersistedChatMessage[];
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

  const notifyAvailableCommands = async (
    ctx: {
      client: {
        notify: (method: string, params: Record<string, unknown>) => Promise<void>;
      };
    },
    sessionId: string,
  ): Promise<void> => {
    if (!isSlashCommandsFeatureEnabled()) return;
    const descriptors = getSlashCommandDescriptors();
    if (!descriptors.length) return;
    const availableCommands = descriptors.map((descriptor) => ({
      name: descriptor.name,
      description: descriptor.description,
    }));
    await ctx.client
      .notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands,
        },
      })
      .catch(() => undefined);
  };

  return acp
    .agent({ name: "iris-agent" })
    .onRequest(acp.methods.agent.initialize, async () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
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
      const irisMeta = readIrisMeta(ctx.params._meta);
      const sessionId =
        irisMeta.chatSessionId && isSafeChatSessionId(irisMeta.chatSessionId)
          ? irisMeta.chatSessionId
          : randomUUID();
      sessions.set(sessionId, {
        cwd: boundWorkspaceRoot || ctx.params.cwd,
        history: [],
      });
      await notifyAvailableCommands(ctx, sessionId);
      return { sessionId };
    })
    .onRequest(acp.methods.agent.session.load, async (ctx) => {
      const sessionId = ctx.params.sessionId;
      if (boundWorkspaceRoot) {
        assertAcpWorkspace({ cwd: ctx.params.cwd }, boundWorkspaceRoot);
      }
      const persisted = await loadPersistedChatSession(sessionId);
      if (!persisted) {
        throw new Error(`No persisted chat session found for '${sessionId}'`);
      }
      const history = persisted.messages.slice();
      sessions.set(sessionId, {
        cwd: boundWorkspaceRoot || ctx.params.cwd,
        history,
      });
      for (const message of history) {
        await ctx.client.notify(acp.methods.client.session.update, {
          sessionId,
          update: {
            sessionUpdate:
              message.role === "user" ? "user_message_chunk" : "agent_message_chunk",
            content: { type: "text", text: message.content },
          },
        });
      }
      await notifyAvailableCommands(ctx, sessionId);
      return {};
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
      const irisMeta = readIrisMeta(ctx.params._meta);
      const effectiveMaxSteps = irisMeta.maxSteps ?? DEFAULT_MAX_STEPS;
      let stepsUsed = 0;
      let usage: TokenUsageSummary | undefined;
      if (promptText) {
        session.history.push({ role: "user", content: promptText });
      }
      const persistTurn = async (assistantText: string): Promise<void> => {
        if (assistantText) {
          session.history.push({ role: "assistant", content: assistantText });
        }
        await savePersistedChatSession(
          sessionId,
          session.history,
          await loadPersistedChatSession(sessionId),
        );
      };
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
                  abortSignal: turnSignal,
                  maxSteps: effectiveMaxSteps,
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
          const suspendedTools: Array<{
            toolName: string;
            toolCallId: string;
            suspendPayload?: Record<string, unknown>;
          }> = [];

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

          const finalizePendingToolInvocations = async (
            reason: "cancelled" | "incomplete",
          ): Promise<void> => {
            const message =
              reason === "cancelled"
                ? "Tool call was cancelled before reporting a result."
                : "Tool call did not report a result before the turn ended.";

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
                          text: message,
                        },
                      },
                    ],
                  },
                });
              }
            }
            pendingToolInvocations.clear();
          };

          while (true) {
            if (activeTurn.abortController.signal.aborted) {
              await reader.cancel().catch(() => undefined);
              await finalizePendingToolInvocations("cancelled");
              return { stopReason: "cancelled" as const };
            }

            let value: AgentStreamChunk | undefined;
            let done = false;
            try {
              ({ value, done } = await raceWithAbort(() => reader.read()));
            } catch (error) {
              if (activeTurn.abortController.signal.aborted) {
                await reader.cancel().catch(() => undefined);
                await finalizePendingToolInvocations("cancelled");
                return { stopReason: "cancelled" as const };
              }
              throw error;
            }
            if (activeTurn.abortController.signal.aborted) {
              await reader.cancel().catch(() => undefined);
              await finalizePendingToolInvocations("cancelled");
              return { stopReason: "cancelled" as const };
            }
            if (done) break;
            if (!value?.type) continue;

            if (value.type === "text-delta" || value.type === "reasoning-delta") {
              const text = String(value.payload?.text || "");
              const chunkUsage = extractTokenUsageFromChunkPayload(value.payload);
              if (chunkUsage) {
                usage = mergeTokenUsage(usage, chunkUsage);
              }
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
              stepsUsed += 1;
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
              let output =
                value.payload?.result ??
                value.payload?.output ??
                value.payload?.content ??
                value.payload?.data;

              if (resolveToolExecutionStatus(output) === "pending_confirmation") {
                const permissionResponse = await ctx.client.request(
                  acp.methods.client.session.requestPermission,
                  {
                    sessionId: ctx.params.sessionId,
                    toolCall: {
                      toolCallId,
                      title: toolName,
                      kind: toToolKind(toolName),
                      status: "pending",
                      rawInput: value.payload?.args,
                    },
                    options: [
                      { optionId: "allow_once", name: "Allow", kind: "allow_once" },
                      { optionId: "reject_once", name: "Reject", kind: "reject_once" },
                    ],
                  },
                );
                const outcome = (
                  permissionResponse as {
                    outcome?: { outcome?: string; optionId?: string };
                  }
                )?.outcome;
                const approved =
                  outcome?.outcome === "selected" &&
                  outcome.optionId === "allow_once";

                if (approved) {
                  const toolArgs = normalizeToolArgs(value.payload?.args);
                  try {
                    output = await executeCommand({
                      command:
                        typeof toolArgs.command === "string"
                          ? toolArgs.command
                          : String(toolArgs.command || ""),
                      cwd: session.cwd,
                      workspaceRoot: session.cwd,
                      skipConfirmation: true,
                      ...toolArgs,
                    } as Parameters<typeof executeCommand>[0]);
                  } catch (error) {
                    output = {
                      status: "failed",
                      error: error instanceof Error ? error.message : String(error),
                    };
                  }
                } else {
                  output = {
                    status: "failed",
                    error: "Tool call was rejected by the user.",
                  };
                }
              }

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
              continue;
            }

            if (value.type === "tool-suspended" || value.type === "tool_suspended") {
              const toolName = String(value.payload?.toolName || "tool");
              const suppliedToolCallId = value.payload?.toolCallId;
              const consumed = consumePendingInvocation(
                toolName,
                suppliedToolCallId,
                undefined,
              );
              const toolCallId = consumed.toolCallId;
              const suspendPayload =
                value.payload?.suspendPayload &&
                typeof value.payload.suspendPayload === "object"
                  ? (value.payload.suspendPayload as Record<string, unknown>)
                  : undefined;
              const question = extractText(suspendPayload) || "Waiting for input to continue.";
              await ctx.client.notify(acp.methods.client.session.update, {
                sessionId: ctx.params.sessionId,
                update: {
                  sessionUpdate: "tool_call_update",
                  toolCallId,
                  status: "in_progress",
                  rawOutput: suspendPayload,
                  content: [
                    {
                      type: "content",
                      content: { type: "text", text: question },
                    },
                  ],
                },
              });
              await ctx.client.notify(acp.methods.client.session.update, {
                sessionId: ctx.params.sessionId,
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text: question },
                },
              });
              suspendedTools.push({ toolName, toolCallId, suspendPayload });
              continue;
            }
          }

          await finalizePendingToolInvocations("incomplete");

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
          await persistTurn(finalText || "");
          const resolvedUsage =
            usage &&
            typeof usage.totalTokens === "number" &&
            typeof usage.inputTokens === "number" &&
            typeof usage.outputTokens === "number"
              ? {
                  totalTokens: usage.totalTokens,
                  inputTokens: usage.inputTokens,
                  outputTokens: usage.outputTokens,
                }
              : undefined;
          const stopReason =
            !finalText && stepsUsed >= effectiveMaxSteps
              ? ("max_turn_requests" as const)
              : ("end_turn" as const);
          return {
            stopReason,
            ...(resolvedUsage ? { usage: resolvedUsage } : {}),
            ...(suspendedTools.length
              ? { _meta: { iris: { suspendedTools } } }
              : {}),
          };
        }

        const generated = await raceWithAbort(async () =>
          runtimeAgent.generate
            ? runtimeAgent.generate(promptText, {
              workspaceRoot: session.cwd,
              abortSignal: turnSignal,
              maxSteps: effectiveMaxSteps,
            })
            : runtimeAgent.chat
              ? runtimeAgent.chat({
                messages: [{ role: "user", content: promptText }],
                signal: turnSignal,
                abortSignal: turnSignal,
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
        await persistTurn(responseText || "");
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
