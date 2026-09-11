import { randomUUID } from "node:crypto";
import type {
  AgentRuntime,
  AgentRuntimeFactory,
  AgentSession,
  AgentSessionContext,
  AgentTurnRequest,
  AgentTurnResult,
  AgentTurnStreamResult,
} from "./AgentContract";
import { getToolCallSignature } from "../utils/toolLifecycle";

export type HostPermissionRequestKind =
  | "shell"
  | "read"
  | "write"
  | "mcp"
  | "custom-tool"
  | "factory"
  | "hook";

export type HostPermissionRequest = {
  kind: HostPermissionRequestKind;
  intention?: string;
  path?: string;
  command?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  managedApprovalRequired?: boolean;
  toolCallId?: string;
};

export type HostPermissionRequestResult =
  | { kind: "approve-once" }
  | { kind: "reject"; feedback?: string }
  | { kind: "ask"; feedback?: string }
  | { kind: "user-not-available" }
  | { kind: "no-result" };

export type HostPermissionHandler = (
  request: HostPermissionRequest,
  invocation: { sessionId: string },
) => Promise<HostPermissionRequestResult> | HostPermissionRequestResult;

export type HostSessionHooks = {
  onSessionStart?: (
    input: { context: AgentSessionContext },
    invocation: { sessionId: string },
  ) => Promise<void> | void;
  onPreTurn?: (
    input: { request: AgentTurnRequest },
    invocation: { sessionId: string },
  ) => Promise<void> | void;
  onPostTurn?: (
    input: { request: AgentTurnRequest; result: AgentTurnResult },
    invocation: { sessionId: string },
  ) => Promise<void> | void;
  onPreToolUse?: (
    input: {
      toolName: string;
      toolCallId?: string;
      toolArgs?: Record<string, unknown>;
      turnRequest: AgentTurnRequest;
    },
    invocation: { sessionId: string },
  ) => Promise<{ permissionDecision?: "allow" | "deny" | "ask" } | null | void> | { permissionDecision?: "allow" | "deny" | "ask" } | null | void;
  onPostToolUse?: (
    input: {
      toolName: string;
      toolCallId?: string;
      toolResult?: unknown;
      turnResult: AgentTurnResult;
    },
    invocation: { sessionId: string },
  ) => Promise<void> | void;
  onSessionEnd?: (
    input: { sessionId: string },
    invocation: { sessionId: string },
  ) => Promise<void> | void;
};

export type HostSessionConfig = {
  sessionId?: string;
  modelId?: string;
  metadata?: Record<string, unknown>;
  onPermissionRequest?: HostPermissionHandler;
  hooks?: HostSessionHooks;
};

export type HostSessionPromptRequest = {
  prompt: string;
  conversation?: AgentTurnRequest["conversation"];
  metadata?: Record<string, unknown>;
  permissionRequest?: HostPermissionRequest;
};

export type HostSessionHandle = {
  sessionId: string;
  sendAndWait: (request: HostSessionPromptRequest) => Promise<AgentTurnResult>;
  sendStream: (request: HostSessionPromptRequest) => Promise<AgentTurnStreamResult>;
  cancel: () => Promise<void>;
  disconnect: () => Promise<void>;
};

type ManagedSession<TRuntime extends AgentRuntime> = {
  runtime: TRuntime;
  session: AgentSession;
  context: AgentSessionContext;
  config: HostSessionConfig;
};

const asRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
};

const toAgentTurnRequest = (
  sessionId: string,
  request: HostSessionPromptRequest,
): AgentTurnRequest => ({
  sessionId,
  input: request.prompt,
  conversation: request.conversation,
  metadata: request.metadata,
});

const getDeclaredToolCalls = (
  metadata: Record<string, unknown> | undefined,
): Array<{ toolName: string; toolArgs?: Record<string, unknown>; toolCallId?: string }> => {
  const declared = metadata?.declaredToolCalls;
  if (!Array.isArray(declared)) {
    return [];
  }

  const parsed: Array<{ toolName: string; toolArgs?: Record<string, unknown>; toolCallId?: string }> = [];
  for (const item of declared) {
    const value = asRecord(item);
    const toolName = typeof value?.toolName === "string" ? value.toolName.trim() : "";
    if (!toolName) continue;

    const toolCallId = typeof value?.toolCallId === "string" ? value.toolCallId : undefined;
    const toolArgs = asRecord(value?.toolArgs);
    parsed.push({ toolName, toolCallId, toolArgs });
  }

  return parsed;
};

const extractFeedback = (
  result: HostPermissionRequestResult,
): string | undefined => {
  if ((result.kind === "reject" || result.kind === "ask") && typeof result.feedback === "string") {
    return result.feedback;
  }
  return undefined;
};

const enforceDeclaredToolHooks = async (
  hooks: HostSessionHooks | undefined,
  turnRequest: AgentTurnRequest,
  invocation: { sessionId: string },
): Promise<void> => {
  const declaredToolCalls = getDeclaredToolCalls(turnRequest.metadata);
  for (const declared of declaredToolCalls) {
    await turnRequest.onPreToolUse?.({
      toolName: declared.toolName,
      toolCallId: declared.toolCallId,
      toolArgs: declared.toolArgs,
    });
  }
};

const createPreToolUseHook = (
  hooks: HostSessionHooks | undefined,
  turnRequest: AgentTurnRequest,
  invocation: { sessionId: string },
): NonNullable<AgentTurnRequest["onPreToolUse"]> => {
  const hasArgumentDetails = (toolArgs: Record<string, unknown> | undefined): boolean =>
    Object.keys(toolArgs || {}).length > 0;
  const identifiedSignaturesByTool = new Map<string, Set<string>>();
  const getIdentifiedToolKey = (toolCallId: string, toolName: string): string =>
    `${toolCallId}:${toolName}`;
  const registerIdentifiedSignature = (
    toolName: string,
    toolCallId: string,
    toolArgs: Record<string, unknown> | undefined,
  ): void => {
    if (!hasArgumentDetails(toolArgs)) return;
    const toolKey = getIdentifiedToolKey(toolCallId, toolName);
    const signatures = identifiedSignaturesByTool.get(toolKey) || new Set<string>();
    signatures.add(getToolCallSignature(toolName, toolArgs || {}));
    identifiedSignaturesByTool.set(toolKey, signatures);
  };
  const getResolutionKeys = (
    toolName: string,
    toolCallId: string | undefined,
    toolArgs: Record<string, unknown> | undefined,
  ): string[] => {
    const signature = getToolCallSignature(toolName, toolArgs || {});
    if (!toolCallId) {
      return [`anonymous:${signature}`];
    }

    const genericKey = `${toolCallId}:${toolName}:generic`;
    if (hasArgumentDetails(toolArgs)) {
      registerIdentifiedSignature(toolName, toolCallId, toolArgs);
      return [`${toolCallId}:${signature}`, genericKey];
    }

    const signatures = identifiedSignaturesByTool.get(
      getIdentifiedToolKey(toolCallId, toolName),
    );
    if (signatures && signatures.size === 1) {
      const [onlySignature] = Array.from(signatures);
      return [`${toolCallId}:${onlySignature}`, genericKey];
    }

    return [genericKey];
  };

  for (const declared of getDeclaredToolCalls(turnRequest.metadata)) {
    if (declared.toolCallId) {
      registerIdentifiedSignature(
        declared.toolName,
        declared.toolCallId,
        declared.toolArgs,
      );
    }
  }

  const declaredRemainingByKey = new Map<string, number>();
  for (const declared of getDeclaredToolCalls(turnRequest.metadata)) {
    const [key] = getResolutionKeys(
      declared.toolName,
      declared.toolCallId,
      declared.toolArgs,
    );
    declaredRemainingByKey.set(key, (declaredRemainingByKey.get(key) || 0) + 1);
  }
  const declaredInvocationsByKey = new Map<string, number>();
  const reconciledRuntimeInvocationsByKey = new Map<string, number>();
  const approvedIdentifiedInvocations = new Set<string>();

  const invokeHook = async ({
    toolName,
    toolCallId,
    toolArgs,
  }: {
    toolName: string;
    toolCallId?: string;
    toolArgs?: Record<string, unknown>;
  }): Promise<void> => {
    const result = await Promise.resolve(
      hooks?.onPreToolUse?.(
        { toolName, toolCallId, toolArgs, turnRequest },
        invocation,
      ),
    );
    if (result && result.permissionDecision === "deny") {
      throw new Error(`Tool '${toolName}' denied by onPreToolUse hook`);
    }
    if (result && result.permissionDecision === "ask") {
      throw new Error(`Tool '${toolName}' requires external approval`);
    }
  };

  return async ({ toolName, toolCallId, toolArgs }) => {
    const keys = getResolutionKeys(toolName, toolCallId, toolArgs);
    const primaryKey = keys[0] as string;

    const declaredKeyToConsume = keys.find(
      (key) => (declaredRemainingByKey.get(key) || 0) > 0,
    );
    if (declaredKeyToConsume) {
      const declaredRemaining = declaredRemainingByKey.get(declaredKeyToConsume) || 0;
      declaredRemainingByKey.set(declaredKeyToConsume, declaredRemaining - 1);
      await invokeHook({ toolName, toolCallId, toolArgs });
      declaredInvocationsByKey.set(
        declaredKeyToConsume,
        (declaredInvocationsByKey.get(declaredKeyToConsume) || 0) + 1,
      );
      return;
    }

    const keyToReconcile = keys.find((key) => {
      const declaredInvocations = declaredInvocationsByKey.get(key) || 0;
      const reconciledInvocations =
        reconciledRuntimeInvocationsByKey.get(key) || 0;
      return reconciledInvocations < declaredInvocations;
    });
    if (keyToReconcile) {
      const reconciledInvocations =
        reconciledRuntimeInvocationsByKey.get(keyToReconcile) || 0;
      reconciledRuntimeInvocationsByKey.set(
        keyToReconcile,
        reconciledInvocations + 1,
      );
      return;
    }

    if (toolCallId && approvedIdentifiedInvocations.has(primaryKey)) {
      return;
    }

    await invokeHook({ toolName, toolCallId, toolArgs });
    if (toolCallId) {
      approvedIdentifiedInvocations.add(primaryKey);
    }
  };
};

const runPostToolHooks = async (
  hooks: HostSessionHooks | undefined,
  result: AgentTurnResult,
  invocation: { sessionId: string },
): Promise<void> => {
  const toolCalls = Array.isArray(result.toolCalls) ? result.toolCalls : [];
  const toolResults = Array.isArray(result.toolResults) ? result.toolResults : [];
  for (let index = 0; index < toolCalls.length; index += 1) {
    const toolCall = asRecord(toolCalls[index]);
    const toolName =
      typeof toolCall?.name === "string" && toolCall.name.trim().length > 0
        ? toolCall.name
        : "unknown_tool";
    const toolCallId =
      typeof toolCall?.toolCallId === "string" ? toolCall.toolCallId : undefined;

    await Promise.resolve(
      hooks?.onPostToolUse?.(
        {
          toolName,
          toolCallId,
          toolResult: index < toolResults.length ? toolResults[index] : undefined,
          turnResult: result,
        },
        invocation,
      ),
    );
  }
};

export class HostSessionManager<TRuntime extends AgentRuntime> {
  private readonly runtimeFactory: AgentRuntimeFactory<TRuntime>;
  private readonly baseContext: Omit<AgentSessionContext, "sessionId">;
  private readonly sessions = new Map<string, ManagedSession<TRuntime>>();
  private readonly pendingSessions = new Map<string, Promise<HostSessionHandle>>();
  private stopping = false;

  constructor(
    runtimeFactory: AgentRuntimeFactory<TRuntime>,
    baseContext: Omit<AgentSessionContext, "sessionId">,
  ) {
    this.runtimeFactory = runtimeFactory;
    this.baseContext = baseContext;
  }

  async createSession(config: HostSessionConfig = {}): Promise<HostSessionHandle> {
    const sessionId = config.sessionId?.trim() || randomUUID();
    return this.openSession(sessionId, config);
  }

  async resumeSession(
    sessionId: string,
    config: Omit<HostSessionConfig, "sessionId"> = {},
  ): Promise<HostSessionHandle> {
    const normalized = sessionId.trim();
    if (!normalized) {
      throw new Error("resumeSession requires a non-empty sessionId");
    }

    if (this.sessions.has(normalized)) {
      return this.toHandle(normalized);
    }

    return this.openSession(normalized, { ...config, sessionId: normalized });
  }

  private async openSession(
    sessionId: string,
    config: HostSessionConfig,
  ): Promise<HostSessionHandle> {
    if (this.stopping) {
      throw new Error("Host session manager is stopping");
    }

    if (this.sessions.has(sessionId)) {
      return this.toHandle(sessionId);
    }

    const pending = this.pendingSessions.get(sessionId);
    if (pending) {
      return pending;
    }

    const opening = this.startSession(sessionId, config);
    this.pendingSessions.set(sessionId, opening);
    try {
      return await opening;
    } finally {
      this.pendingSessions.delete(sessionId);
    }
  }

  private async startSession(
    sessionId: string,
    config: HostSessionConfig,
  ): Promise<HostSessionHandle> {
    const runtime = await Promise.resolve(this.runtimeFactory());
    const context: AgentSessionContext = {
      sessionId,
      workspacePath: this.baseContext.workspacePath,
      modelId: config.modelId || this.baseContext.modelId,
      metadata: {
        ...(this.baseContext.metadata || {}),
        ...(config.metadata || {}),
      },
    };

    const invocation = { sessionId };
    const session = await runtime.startSession(context);
    try {
      await Promise.resolve(config.hooks?.onSessionStart?.({ context }, invocation));
      this.sessions.set(sessionId, { runtime, session, context, config });
    } catch (error) {
      await runtime.endSession(sessionId).catch(() => undefined);
      throw error;
    }

    return this.toHandle(sessionId);
  }

  private toHandle(sessionId: string): HostSessionHandle {
    return {
      sessionId,
      sendAndWait: async (request) => this.sendAndWait(sessionId, request),
      sendStream: async (request) => this.sendStream(sessionId, request),
      cancel: async () => this.cancelSession(sessionId),
      disconnect: async () => this.disconnectSession(sessionId),
    };
  }

  private getManagedSession(sessionId: string): ManagedSession<TRuntime> {
    const managed = this.sessions.get(sessionId);
    if (!managed) {
      throw new Error(`Unknown session '${sessionId}'`);
    }
    return managed;
  }

  private async enforcePermission(
    sessionId: string,
    config: HostSessionConfig,
    request: HostPermissionRequest | undefined,
  ): Promise<void> {
    if (!request || !config.onPermissionRequest) {
      return;
    }

    const result = await Promise.resolve(
      config.onPermissionRequest(request, {
        sessionId,
      }),
    );

    if (result.kind === "reject" || result.kind === "user-not-available") {
      throw new Error(extractFeedback(result) || "Permission request rejected");
    }
    if (result.kind === "ask" || result.kind === "no-result") {
      throw new Error(
        extractFeedback(result) || "Permission request requires external resolution",
      );
    }
  }

  async sendAndWait(
    sessionId: string,
    request: HostSessionPromptRequest,
  ): Promise<AgentTurnResult> {
    const managed = this.getManagedSession(sessionId);
    const invocation = { sessionId };
    const turnRequest = toAgentTurnRequest(sessionId, request);
    turnRequest.onPreToolUse = createPreToolUseHook(
      managed.config.hooks,
      turnRequest,
      invocation,
    );

    await this.enforcePermission(sessionId, managed.config, request.permissionRequest);
    await Promise.resolve(managed.config.hooks?.onPreTurn?.({ request: turnRequest }, invocation));

    await enforceDeclaredToolHooks(managed.config.hooks, turnRequest, invocation);

    const result = await managed.runtime.runTurn(turnRequest);
    await runPostToolHooks(managed.config.hooks, result, invocation);

    await Promise.resolve(
      managed.config.hooks?.onPostTurn?.({ request: turnRequest, result }, invocation),
    );
    return result;
  }

  async sendStream(
    sessionId: string,
    request: HostSessionPromptRequest,
  ): Promise<AgentTurnStreamResult> {
    const managed = this.getManagedSession(sessionId);
    if (!managed.runtime.runTurnStream) {
      throw new Error(
        `Agent '${managed.runtime.descriptor.id}' does not support runTurnStream`,
      );
    }

    const invocation = { sessionId };
    const turnRequest = toAgentTurnRequest(sessionId, request);
    turnRequest.onPreToolUse = createPreToolUseHook(
      managed.config.hooks,
      turnRequest,
      invocation,
    );

    await this.enforcePermission(sessionId, managed.config, request.permissionRequest);
    await Promise.resolve(managed.config.hooks?.onPreTurn?.({ request: turnRequest }, invocation));
    await enforceDeclaredToolHooks(managed.config.hooks, turnRequest, invocation);

    const streamResult = await managed.runtime.runTurnStream(turnRequest);
    let finalizedResultPromise: Promise<AgentTurnResult> | undefined;
    return {
      ...(streamResult as Record<string, unknown>),
      stream: streamResult.stream,
      getFinalResult: async () => {
        if (!finalizedResultPromise) {
          finalizedResultPromise = (async () => {
            const finalResult = await streamResult.getFinalResult();
            await runPostToolHooks(managed.config.hooks, finalResult, invocation);
            await Promise.resolve(
              managed.config.hooks?.onPostTurn?.(
                { request: turnRequest, result: finalResult },
                invocation,
              ),
            );
            return finalResult;
          })();
        }

        return finalizedResultPromise;
      },
    };
  }

  async disconnectSession(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId);
    if (!managed) {
      return;
    }

    this.sessions.delete(sessionId);
    try {
      await Promise.resolve(
        managed.config.hooks?.onSessionEnd?.({ sessionId }, { sessionId }),
      );
    } finally {
      await managed.runtime.endSession(sessionId);
    }
  }

  async cancelSession(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId);
    if (managed?.runtime.cancelTurn) {
      await managed.runtime.cancelTurn(sessionId);
    }
  }

  async stopAll(): Promise<void> {
    this.stopping = true;
    for (const [sessionId, pending] of this.pendingSessions) {
      void pending
        .then(() => this.disconnectSession(sessionId))
        .catch((error: unknown) => {
          console.error(
            `Failed to clean up host session '${sessionId}' during shutdown:`,
            error,
          );
        });
    }

    const sessionIds = Array.from(this.sessions.keys());
    const results = await Promise.allSettled(
      sessionIds.map((sessionId) => this.disconnectSession(sessionId)),
    );
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (errors.length > 0) {
      throw new AggregateError(errors, "Failed to stop one or more host sessions");
    }
  }
}
