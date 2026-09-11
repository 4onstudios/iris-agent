import express from "express";
import type { Request, Response, NextFunction } from "express";
import os from "os";
import { randomUUID } from "node:crypto";
import fsNative from "fs";
import fs from "fs/promises";
import path from "path";
import { truncateEnvironmentResponse } from "./helpers/agentUtils";
import {
  getEnvironmentSnapshot,
  formatSnapshotAsMarkdown,
} from "./core/agent/utils/environmentSnapshot";
import {
  sanitizeMcpServers,
  toStableMcpFingerprint,
  type McpServerConfig,
} from "./core/library/mcpSettings";
import {
  getTerminalAutoApproveRulesFingerprint,
  sanitizeTerminalAutoApproveRules,
  type TerminalAutoApproveRules,
} from "./core/library/terminalAutoApproveSettings";
import {
  executeMcpToolByKey,
  listMcpServerTools,
} from "./core/agent/tools/mcpTools";
import {
  initializeLanguageModelTools,
  getAvailableTools,
} from "./core/agent/tools/languageModelToolsIntegration";
import { executeCommand } from "./core/agent/tools/executeCommand";
import {
  countUniqueToolCalls,
  getToolCallSignature,
  normalizeToolLifecycle,
  resolveToolExecutionStatus,
  type PendingToolCall,
  type ToolExecutionStatus,
} from "./core/agent/utils/toolLifecycle";
import { redactToolResult } from "./core/agent/utils/toolResultSafetyProcessor";
import type { ToolCallBudget } from "./core/agent/utils/toolCallBudget";
import { serializeToolResultsForContinuation } from "./core/containers/chat/toolResultSerialization";
import {
  type AgentRuntime,
  type AgentStreamEvent,
  type AgentTurnStreamResult,
  type HostSessionHandle,
  createDefaultAgentRegistry,
  ExternalAgentLifecycleManager,
  HostSessionManager,
} from "./core/agent/host";
import {
  truncateText,
  buildPromptWithinTokenBudget,
  resolveModelInputTokenLimit,
  resolveModelSupportsVision,
} from "./helpers/promptBudget";
import {
  isLikelyImageFile,
  resolveImageMessageParts,
} from "./helpers/resolveImageMessageParts";
import {
  parseSlashCommandRequest,
  getSlashCommandDescriptors,
  executeRegisteredSlashCommand,
  isSlashCommandsFeatureEnabled,
} from "./helpers/slashCommands";
import {
  normalizeTokenUsage,
  mergeTokenUsage,
  extractTokenUsageFromChunkPayload,
  logTokenUsageSource,
  buildTokenUsageDebug,
  type TokenUsageSummary,
} from "./helpers/tokenUsage";
import {
  sanitizeObservationalMemorySettings,
  type ObservationalMemorySettingsPayload,
} from "./helpers/observationalMemory";
import { registerFileRoutes } from "./routes/fileRoutes";
import { registerLspDocumentRoutes } from "./routes/lspDocumentRoutes";
import { registerLspHierarchyRoutes } from "./routes/lspHierarchyRoutes";
import { registerLspPositionRoutes } from "./routes/lspPositionRoutes";
import { registerLspQueryRoutes } from "./routes/lspQueryRoutes";
import { registerLspResolveRoutes } from "./routes/lspResolveRoutes";
import { registerLspSemanticDocumentRoutes } from "./routes/lspSemanticDocumentRoutes";
import { registerSemanticRoutes } from "./routes/semanticRoutes";
import {
  asRunLifecycleState,
  clearRunCancellationRequest,
  deleteRunDataBatch,
  getRunSnapshot,
  isRunCancellationRequested,
  isSafeRunId,
  listRunEvents,
  requestRunCancellation,
  safePersistRunLifecycleEvent,
  type RunLifecycleState,
  type RunStopReason,
} from "./data/runStore";

const router = express.Router();
const activeChatSessionTurns = new Set<string>();

type ChatRole = "user" | "assistant" | "system" | "tool";

type ConversationMessage = {
  role: ChatRole;
  content: string;
  continuationType?: "tool_results" | "final_synthesis";
};

type MultimodalContentPart =
  | { type: "text"; text: string }
  | { type: "image"; image: string; mediaType?: string };

type MultimodalMessage = {
  role: "user" | "assistant" | "system";
  content: MultimodalContentPart[];
};

type WorkspaceTreeNode = {
  name: string;
  type: "file" | "directory";
  children?: WorkspaceTreeNode[];
};

type StreamErrorRetryRequest = {
  enabled?: boolean;
  maxRetries?: number;
  retryUnknownErrors?: boolean;
  baseDelayMs?: number;
  maxDelayMs?: number;
};

type WorkspaceAirisConfig = {
  agent?: {
    streamErrorRetry?: StreamErrorRetryRequest;
  };
};

type AgentChatRequestBody = {
  message: string;
  chatSessionId?: string;
  runId?: string;
  conversationHistory?: ConversationMessage[];
  toolResults?: Array<Record<string, unknown>>;
  modelId?: string;
  filesInContext?: Array<Record<string, any>>;
  workspaceRoot?: string;
  workspaceStructure?: WorkspaceTreeNode;
  isTauri?: boolean;
  contextSummary?: Array<{ id: string; preview: string }>;
  maxSteps?: number;
  maxOutputTokens?: number;
  stream?: boolean;
  enableSlashCommands?: boolean;
  enabledSkills?: string[];
  approvalMode?:
  "Default Approvals" | "Bypass Approvals" | "Autopilot (Preview)";
  preferredAgentId?: string;
  mcpServers?: McpServerConfig[];
  terminalAutoApproveRules?: TerminalAutoApproveRules;
  useMastraObservationalMemory?: boolean;
  observationalMemorySettings?: ObservationalMemorySettingsPayload;
  streamErrorRetry?: StreamErrorRetryRequest;
};

type CommandConfirmationRequestBody = {
  confirmationId?: string;
  approved?: boolean;
  toolArgs?: Record<string, unknown>;
  workspaceRoot?: string;
};

type McpCallRequestBody = {
  toolName?: string;
  args?: Record<string, unknown>;
  workspaceRoot?: string;
  mcpServers?: McpServerConfig[];
};

type AgentStepContentItem = {
  type?: string;
  toolName?: string;
  toolCallId?: string;
  args?: Record<string, unknown>;
  input?: Record<string, unknown>;
  suspendPayload?: Record<string, unknown>;
  result?: unknown;
  output?: unknown;
  content?: unknown;
  data?: unknown;
};

type AgentToolCall = {
  toolName?: string;
  args?: Record<string, unknown>;
  toolCallId?: string;
  result?: unknown;
};

type AgentStep = {
  content?: AgentStepContentItem[];
  toolCalls?: AgentToolCall[];
};

type AgentGenerateResult = {
  text?: string;
  steps?: AgentStep[];
  toolCalls?: AgentToolCall[];
  usage?: unknown;
};

type NativeAgentStreamChunk = {
  type?: string;
  payload?: Record<string, unknown>;
};

type NativeAgentStreamResult = {
  fullStream: ReadableStream<NativeAgentStreamChunk>;
  text: Promise<string>;
  toolCalls: Promise<
    Array<{
      toolName?: string;
      args?: Record<string, unknown>;
      toolCallId?: string;
    }>
  >;
  usage?: Promise<unknown> | unknown;
  steps?: Promise<StreamStep[]> | StreamStep[];
};

type GeneratedAgentTurnStreamResult = AgentTurnStreamResult & {
  rawStreamResult: NativeAgentStreamResult;
};

type GeneratedAgent = {
  // eslint-disable-next-line no-unused-vars
  generate: (
    ...args: [
      string | MultimodalMessage[],
      (Record<string, unknown> | undefined)?,
    ]
  ) => Promise<AgentGenerateResult>;
  setObjective?: (
    objective: string,
    options: {
      threadId: string;
      resourceId?: string;
      maxRuns?: number;
    },
  ) => Promise<unknown>;
  takeProcessedWorkspaceResults?: (
    generationId: string,
    toolCallIds: string[],
  ) => Array<{
    toolCallId: string;
    result: Record<string, unknown>;
  }>;
  clearProcessedWorkspaceResults?: (generationId: string) => void;
  stream?: (
    ...args: [string | MultimodalMessage[], Record<string, unknown>]
  ) => Promise<NativeAgentStreamResult>;
};

/**
 * Safely extract error message from any thrown value.
 * Handles Error objects, strings, null/undefined, and other values.
 */
const getErrorMessage = (err: unknown): string => {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  if (err === null || err === undefined) {
    return String(err);
  }
  return String(err);
};

const sanitizeToolArgsForWorkspace = (
  toolName: string,
  args: Record<string, unknown> | undefined,
  isWebWorkspace: boolean,
): Record<string, unknown> => {
  const normalizedArgs = args || {};
  if (!isWebWorkspace || toolName !== "getWorkspaceInfo") {
    return normalizedArgs;
  }

  const sanitizedArgs = { ...normalizedArgs };
  delete sanitizedArgs.workspacePath;
  return sanitizedArgs;
};

type ExecutedToolResult = {
  name: string;
  args: Record<string, unknown>;
  result: any;
  toolCallId?: string;
  lifecycleStepIndex?: number;
};

type PersistedToolAction = {
  eventType: "tool_call" | "tool_result";
  name: string;
  args: Record<string, unknown>;
  result?: unknown;
  toolCallId?: string;
  status: ToolExecutionStatus;
};

type AnonymousToolCallArgs = {
  toolName: string;
  args: Record<string, unknown>;
  consumed: boolean;
};

const isRecordValue = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const resolveToolResultArgs = (
  toolName: string,
  toolCallId: string | undefined,
  explicitArgs: unknown,
  argsByCallId: Map<string, Record<string, unknown>>,
  anonymousCallArgs: AnonymousToolCallArgs[],
): Record<string, unknown> => {
  const explicitRecord = isRecordValue(explicitArgs)
    ? explicitArgs
    : undefined;

  if (toolCallId) {
    const mappedArgs = argsByCallId.get(toolCallId);
    if (
      explicitRecord &&
      (!mappedArgs ||
        getToolCallSignature(toolName, explicitRecord) !==
          getToolCallSignature(toolName, mappedArgs))
    ) {
      return explicitRecord;
    }

    return mappedArgs || explicitRecord || {};
  }

  if (explicitRecord) {
    const explicitSignature = getToolCallSignature(toolName, explicitRecord);
    const matchingAnonymousCall = anonymousCallArgs.find(
      (call) =>
        !call.consumed &&
        call.toolName === toolName &&
        getToolCallSignature(call.toolName, call.args || {}) ===
          explicitSignature,
    );
    if (matchingAnonymousCall) {
      matchingAnonymousCall.consumed = true;
      return matchingAnonymousCall.args || {};
    }

    return explicitRecord;
  }

  const matchingAnonymousCall = anonymousCallArgs.find(
    (call) => !call.consumed && call.toolName === toolName,
  );
  if (!matchingAnonymousCall) return {};

  matchingAnonymousCall.consumed = true;
  return matchingAnonymousCall.args || {};
};

type StreamStep = {
  content?: Array<{
    type?: string;
    toolName?: string;
    toolCallId?: string;
    args?: Record<string, unknown>;
    input?: Record<string, unknown>;
    result?: unknown;
    output?: unknown;
    content?: unknown;
    data?: unknown;
  }>;
  toolCalls?: unknown[];
};

const unwrapProcessedToolResult = (result: unknown): unknown => {
  let current = result;

  while (
    current &&
    typeof current === "object" &&
    "value" in current &&
    typeof (current as { type?: unknown }).type === "string"
  ) {
    current = (current as { value: unknown }).value;
  }

  return current;
};

const extractProcessedToolResults = (
  steps: StreamStep[],
): ExecutedToolResult[] => {
  const argsByCallId = new Map<string, Record<string, unknown>>();
  const anonymousCallArgs: AnonymousToolCallArgs[] = [];
  const results: ExecutedToolResult[] = [];

  for (const step of steps) {
    for (const item of step.content || []) {
      if (item.type !== "tool-call" || !item.toolName) continue;
      const args = item.args || item.input || {};
      if (item.toolCallId) {
        argsByCallId.set(item.toolCallId, args);
      } else {
        anonymousCallArgs.push({
          toolName: item.toolName,
          args,
          consumed: false,
        });
      }
    }

    for (const item of step.content || []) {
      if (item.type !== "tool-result" || !item.toolName) continue;

      const result = unwrapProcessedToolResult(
        item.result ?? item.output ?? item.content ?? item.data,
      );
      results.push({
        name: item.toolName,
        args: resolveToolResultArgs(
          item.toolName,
          item.toolCallId,
          item.args || item.input,
          argsByCallId,
          anonymousCallArgs,
        ),
        result: redactToolResult(result).result,
        toolCallId: item.toolCallId,
      });
    }
  }

  return results;
};

const buildOrderedPersistedToolActions = (
  steps: Array<{ content?: AgentStepContentItem[] }> | undefined,
  pendingToolCalls: Array<{
    name: string;
    args: Record<string, unknown>;
    toolCallId?: string;
    status: ToolExecutionStatus;
  }>,
  executedToolResults: Array<{
    name: string;
    args: Record<string, unknown>;
    result: unknown;
    toolCallId?: string;
    status: ToolExecutionStatus;
  }>,
  sanitizeArgs: (
    toolName: string,
    args: Record<string, unknown> | undefined,
  ) => Record<string, unknown>,
): PersistedToolAction[] => {
  const pendingEntries = pendingToolCalls.map((action) => ({
    action,
    consumed: false,
  }));
  const executedEntries = executedToolResults.map((action) => ({
    action,
    consumed: false,
  }));
  const actions: PersistedToolAction[] = [];

  const takeById = <T extends { action: { toolCallId?: string } }>(
    entries: Array<T & { consumed: boolean }>,
    toolCallId: string | undefined,
  ): (T & { consumed: boolean }) | undefined => {
    if (!toolCallId) return undefined;
    const entry = entries.find(
      (candidate) =>
        !candidate.consumed && candidate.action.toolCallId === toolCallId,
    );
    if (entry) entry.consumed = true;
    return entry;
  };

  const takeBySignature = <
    T extends { action: { name: string; args: Record<string, unknown> } },
  >(
    entries: Array<T & { consumed: boolean }>,
    toolName: string,
    args: Record<string, unknown>,
  ): (T & { consumed: boolean }) | undefined => {
    const signature = getToolCallSignature(toolName, args);
    const entry = entries.find(
      (candidate) =>
        !candidate.consumed &&
        getToolCallSignature(
          candidate.action.name,
          candidate.action.args || {},
        ) === signature,
    );
    if (entry) entry.consumed = true;
    return entry;
  };

  const takeByName = <
    T extends { action: { name: string } },
  >(
    entries: Array<T & { consumed: boolean }>,
    toolName: string,
  ): (T & { consumed: boolean }) | undefined => {
    const entry = entries.find(
      (candidate) => !candidate.consumed && candidate.action.name === toolName,
    );
    if (entry) entry.consumed = true;
    return entry;
  };

  for (const step of steps || []) {
    for (const item of step.content || []) {
      if (!item.toolName) continue;

      if (item.type === "tool-call") {
        const args = sanitizeArgs(item.toolName, item.input || item.args);
        const entry =
          takeById(pendingEntries, item.toolCallId) ||
          takeBySignature(pendingEntries, item.toolName, args);
        if (!entry) continue;
        actions.push({
          eventType: "tool_call",
          ...entry.action,
        });
        continue;
      }

      if (item.type === "tool-result") {
        const explicitArgs = item.args || item.input;
        const hasExplicitArgs = isRecordValue(explicitArgs);
        const args = sanitizeArgs(item.toolName, explicitArgs);
        const entry =
          takeById(executedEntries, item.toolCallId) ||
          (hasExplicitArgs
            ? takeBySignature(executedEntries, item.toolName, args)
            : undefined) ||
          takeByName(executedEntries, item.toolName);
        if (!entry) continue;
        actions.push({
          eventType: "tool_result",
          ...entry.action,
        });
      }
    }
  }

  for (const entry of pendingEntries) {
    if (!entry.consumed) {
      actions.push({ eventType: "tool_call", ...entry.action });
    }
  }
  for (const entry of executedEntries) {
    if (!entry.consumed) {
      actions.push({ eventType: "tool_result", ...entry.action });
    }
  }

  return actions;
};

const reconcileToolLifecycleSnapshots = (
  streamedPending: PendingToolCall[],
  snapshotPending: PendingToolCall[],
  streamedResults: ExecutedToolResult[],
  snapshotResults: ExecutedToolResult[],
): {
  pendingToolCalls: PendingToolCall[];
  executedToolResults: ExecutedToolResult[];
} => {
  const reconcile = <T extends PendingToolCall | ExecutedToolResult>(
    streamed: T[],
    snapshot: T[],
  ): T[] => {
    const merged = [...streamed];
    const claimedStreamedIndexes = new Set<number>();
    const streamedById = new Map(
      streamed
        .map((entry, index) =>
          entry.toolCallId
            ? [
                `${entry.toolCallId}:${getToolCallSignature(
                  entry.name,
                  entry.args || {},
                )}`,
                index,
              ]
            : undefined,
        )
        .filter((entry): entry is [string, number] => entry !== undefined),
    );

    for (const entry of snapshot) {
      if (entry.toolCallId) {
        const matchingIndex = streamedById.get(
          `${entry.toolCallId}:${getToolCallSignature(
            entry.name,
            entry.args || {},
          )}`,
        );
        if (matchingIndex !== undefined) {
          merged[matchingIndex] = entry;
          claimedStreamedIndexes.add(matchingIndex);
          continue;
        }
      }

      const matchingIndex = streamed.findIndex(
        (streamedEntry, index) =>
          !claimedStreamedIndexes.has(index) &&
          (!streamedEntry.toolCallId || !entry.toolCallId) &&
          getToolCallSignature(streamedEntry.name, streamedEntry.args || {}) ===
          getToolCallSignature(entry.name, entry.args || {}),
      );
      if (matchingIndex === -1) {
        merged.push(entry);
        continue;
      }

      claimedStreamedIndexes.add(matchingIndex);
      merged[matchingIndex] = {
        ...merged[matchingIndex],
        ...entry,
        toolCallId: entry.toolCallId ?? merged[matchingIndex].toolCallId,
      };
    }

    return merged;
  };

  return {
    pendingToolCalls: reconcile(streamedPending, snapshotPending),
    executedToolResults: reconcile(streamedResults, snapshotResults),
  };
};

type SuspendedToolCall = {
  name: string;
  toolCallId?: string;
  suspendPayload?: Record<string, unknown>;
};

type ValidationFailure = {
  phase: "lint" | "test";
  command?: string;
  error?: string;
  stdout?: string;
  stderr?: string;
};

type ToolExecutionFailure = {
  toolName: string;
  args?: Record<string, unknown>;
  error?: string;
  status: ToolExecutionStatus;
};

type ReflectionStopReason =
  "none" | "resolved" | "max_attempts" | "no_progress";

type ModelExecutionProfile = {
  generateRetryAttempts: number;
  reflectionMaxAttempts: number;
  reflectionRetryAttempts: number;
  reflectionMaxSteps: number;
  maxStepsCapDesktop: number;
  // Upper bound on completion tokens per model call. Leaving this unset makes
  // providers (e.g. OpenRouter) default to the model's maximum context, which
  // can exceed a low credit budget and trigger 402 errors.
  maxOutputTokens: number;
};

type GitSafetyMetadata = {
  enabled: boolean;
  gitDetected: boolean;
  policyMode: "off" | "suggest" | "enforce";
  undoHint?: string;
  checkpointHint?: string;
};

type McpDiscoverySummary = {
  name: string;
  command: string;
  toolNames: string[];
  error?: string;
};

type RemoteChatSessionBody = {
  id?: string;
  title?: string;
  createdAt?: number;
  updatedAt?: number;
  messages?: Record<string, unknown>[];
};

// Cache environment snapshots per workspace to avoid regenerating
const envSnapshotCache = new Map<
  string,
  Awaited<ReturnType<typeof getEnvironmentSnapshot>>
>();

// Cache agent instances keyed by "modelId:workspacePath" to avoid repeating
// workspace.init on every request.  Keyed by "modelId:workspacePath" only —
// enabled-skill filtering is applied per-request (injected into contextInfo)
// so it never inflates the key space.
//
// ── Cache contract ────────────────────────────────────────────────────────────
// A cached agent MUST be safe to reuse across distinct requests that share the
// same (modelId, workspacePath) tuple.  This means:
//
//  SAFE to capture at construction time (part of the key or truly static):
//    • modelId          – part of the cache key
//    • workspacePath    – part of the cache key; baked into tool path-resolvers
//    • Mastra Workspace instance (LocalFilesystem + BM25 index)
//    • Wrapped tool implementations (path already resolved via closure)
//    • Static system-prompt instructions
//
//  MUST NOT be captured at construction time (varies per-request/per-user):
//    • Enabled-skills list  → inject via contextInfo prefix
//    • Auth tokens / API keys → read from env at request time, not constructor
//    • Per-session or per-user identity
//    • Anything derived from the HTTP request (headers, body, caller context)
//
// If future code needs to vary any of the "MUST NOT" items, inject it through
// the `contextInfo` argument of agent.generate() rather than expanding the
// constructor or the cache key.
// ─────────────────────────────────────────────────────────────────────────────
const AGENT_CACHE_MAX_SIZE = 50;
const MAX_INLINE_FILE_CONTENT_CHARS = 6000;
const MAX_CONVERSATION_MESSAGES = 12;
const MAX_CONVERSATION_MESSAGE_CHARS = 4000;
const MAX_CONVERSATION_MESSAGE_TOKENS = 1200;
const MAX_CONTEXT_FILES = 8;
const DEFAULT_PROMPT_TOKEN_BUDGET_RATIO = 0.55;
const MIN_PROMPT_TOKEN_BUDGET = 4096;
const PROMPT_TOKEN_RESERVE = 6144;
const agentCache = new Map<string, GeneratedAgent>();
type AgentCoreModule = typeof import("./core/agent/index");
let agentCoreModulePromise: Promise<AgentCoreModule> | undefined;
const loadAgentCoreModule = (): Promise<AgentCoreModule> => {
  if (!agentCoreModulePromise) {
    agentCoreModulePromise = import("./core/agent/index");
  }
  return agentCoreModulePromise;
};
const REMOTE_CHAT_SESSIONS_DIR = path.join(
  os.homedir(),
  ".iris",
  "chat-sessions",
);

const EDIT_TOOL_NAMES = new Set(["writeFile", "editFile", "applyDiff"]);

const toRunStopReasonFromReflection = (
  reflectionStopReason: ReflectionStopReason,
): RunStopReason => {
  if (reflectionStopReason === "resolved") return "completed";
  if (reflectionStopReason === "no_progress") return "no_progress";
  if (reflectionStopReason === "max_attempts") return "max_attempts";
  return "none";
};

const parsePositiveIntQuery = (
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number => {
  const first = Array.isArray(value) ? value[0] : value;
  if (typeof first !== "string") {
    return fallback;
  }

  const parsed = Number.parseInt(first, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, parsed));
};

const isSafeSessionId = (sessionId: string) =>
  /^[A-Za-z0-9._:-]+$/.test(sessionId);

const getRemoteChatSessionPath = (sessionId: string) =>
  path.join(REMOTE_CHAT_SESSIONS_DIR, `${sessionId}.json`);

const extractRunIdsFromRemoteSession = (
  session: RemoteChatSessionBody | null | undefined,
): string[] => {
  if (!session || !Array.isArray(session.messages)) {
    return [];
  }

  const collected = new Set<string>();

  const visit = (value: unknown, depth: number): void => {
    if (depth > 12 || value === null || value === undefined) {
      return;
    }

    if (typeof value === "string") {
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, depth + 1));
      return;
    }

    if (typeof value !== "object") {
      return;
    }

    const record = value as Record<string, unknown>;
    const candidateRunId =
      typeof record.runId === "string"
        ? record.runId.trim()
        : typeof record.run_id === "string"
          ? record.run_id.trim()
          : "";

    if (candidateRunId && isSafeRunId(candidateRunId)) {
      collected.add(candidateRunId);
    }

    Object.values(record).forEach((entry) => visit(entry, depth + 1));
  };

  session.messages.forEach((message) => visit(message, 0));
  return Array.from(collected);
};

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const isSynthesisOnlyContinuationMessage = (
  message: ConversationMessage | undefined,
): boolean => {
  if (!message || message.role !== "user") {
    return false;
  }

  return (
    message.continuationType === "tool_results" ||
    message.continuationType === "final_synthesis"
  );
};

const normalizeEnabledSkills = (input: unknown): string[] => {
  if (!Array.isArray(input)) {
    return [];
  }

  const normalized = input
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value) => /^[a-zA-Z0-9._-]{1,80}$/.test(value));

  return Array.from(new Set(normalized));
};

const isRetryableModelError = (error: unknown): boolean => {
  const err = error as {
    isRetryable?: boolean;
    statusCode?: number;
    data?: { error?: { code?: string; type?: string } };
  };

  if (err?.isRetryable) return true;

  const statusCode = err?.statusCode;
  const code = err?.data?.error?.code;
  const type = err?.data?.error?.type;

  return Boolean(
    (typeof statusCode === "number" && statusCode >= 500) ||
    code === "server_error" ||
    type === "server_error",
  );
};

const serializeToolResultsForConversation = (
  toolResults?: AgentChatRequestBody["toolResults"],
): string | null => {
  if (!Array.isArray(toolResults) || toolResults.length === 0) {
    return null;
  }

  const body = serializeToolResultsForContinuation(toolResults, "unknown_tool");

  return `Tool execution results:\n\n${body}`;
};

const isSlashCommandExecutionAllowed = (
  req: Request,
  isTauri: boolean | undefined,
  enableSlashCommands: boolean,
): boolean => {
  if (!enableSlashCommands) return false;
  if (!isSlashCommandsFeatureEnabled()) return false;
  return Boolean(isTauri && hasDesktopAuth(req));
};

router.get("/slash-commands", (req: Request, res: Response) => {
  const enableSlashCommandsRaw = String(
    req.query.enableSlashCommands || "true",
  );
  const clientEnabled = !["0", "false", "off", "no"].includes(
    enableSlashCommandsRaw.trim().toLowerCase(),
  );

  if (!clientEnabled || !isSlashCommandsFeatureEnabled()) {
    return res.json({
      success: true,
      enabled: false,
      commands: [],
    });
  }

  return res.json({
    success: true,
    enabled: true,
    commands: getSlashCommandDescriptors(),
  });
});

const generateWithRetry = async (
  agent: GeneratedAgent,
  prompt: string | MultimodalMessage[],
  generateOptions: Record<string, unknown>,
  abortSignal: AbortSignal,
  maxAttempts = 3,
): Promise<AgentGenerateResult> => {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (abortSignal.aborted) {
      throw new Error("Run cancelled");
    }
    try {
      return await agent.generate(prompt, generateOptions);
    } catch (error) {
      lastError = error;
      if (abortSignal.aborted) {
        throw error;
      }
      const shouldRetry = isRetryableModelError(error) && attempt < maxAttempts;

      if (!shouldRetry) {
        throw error;
      }

      const backoffMs = 600 * 2 ** (attempt - 1);
      console.warn(
        `[agent] transient model error (attempt ${attempt}/${maxAttempts}); retrying in ${backoffMs}ms`,
      );
      await sleep(backoffMs);
    }
  }

  throw lastError;
};

const asGenerateResultFromTurn = (turnResult: {
  text: string;
  raw?: unknown;
}): AgentGenerateResult => {
  if (turnResult.raw && typeof turnResult.raw === "object") {
    return turnResult.raw as AgentGenerateResult;
  }

  return {
    text: turnResult.text,
  };
};

const createGeneratedAgentRuntimeAdapter = (
  agent: GeneratedAgent,
): AgentRuntime => {
  const turnAbortControllers = new Map<string, AbortController>();

  const createTurnAbortController = (sessionId: string): AbortController => {
    const controller = new AbortController();
    turnAbortControllers.set(sessionId, controller);
    return controller;
  };

  const clearTurnAbortController = (
    sessionId: string,
    controller: AbortController,
  ): void => {
    const active = turnAbortControllers.get(sessionId);
    if (active === controller) {
      turnAbortControllers.delete(sessionId);
    }
  };

  return {
    descriptor: {
      id: "generated-agent-runtime",
      name: "Generated Agent Runtime",
      version: "0.1.0",
      source: "external",
    },
    async startSession(context) {
      return {
        sessionId: context.sessionId,
        agentId: "generated-agent-runtime",
        createdAt: Date.now(),
      };
    },
    async runTurn(request) {
      const metadata =
        request.metadata && typeof request.metadata === "object"
          ? (request.metadata as Record<string, unknown>)
          : {};

      const modelInput =
        metadata.modelInput !== undefined
          ? (metadata.modelInput as string | MultimodalMessage[])
          : request.input;
      const generateOptions =
        metadata.generateOptions && typeof metadata.generateOptions === "object"
          ? (metadata.generateOptions as Record<string, unknown>)
          : {};
      const requestContext = generateOptions.requestContext as {
        set?: (key: string, value: unknown) => void;
      } | undefined;
      requestContext?.set?.("onPreToolUse", request.onPreToolUse);
      const turnAbortController = createTurnAbortController(request.sessionId);
      const generateOptionsWithAbort = {
        ...generateOptions,
        abortSignal: turnAbortController.signal,
      };
      let result: AgentGenerateResult;
      try {
        result = await agent.generate(modelInput, generateOptionsWithAbort);
      } finally {
        clearTurnAbortController(request.sessionId, turnAbortController);
      }

      return {
        text: result.text || "",
        toolCalls: Array.isArray(result.toolCalls)
          ? (result.toolCalls as Array<Record<string, unknown>>)
          : undefined,
        raw: result,
      };
    },
    async runTurnStream(request) {
      const metadata =
        request.metadata && typeof request.metadata === "object"
          ? (request.metadata as Record<string, unknown>)
          : {};
      const modelInput =
        metadata.modelInput !== undefined
          ? (metadata.modelInput as string | MultimodalMessage[])
          : request.input;
      const generateOptions =
        metadata.generateOptions && typeof metadata.generateOptions === "object"
          ? (metadata.generateOptions as Record<string, unknown>)
          : {};
      const requestContext = generateOptions.requestContext as {
        set?: (key: string, value: unknown) => void;
      } | undefined;
      requestContext?.set?.("onPreToolUse", request.onPreToolUse);

      if (typeof agent.stream !== "function") {
        throw new Error("Generated agent runtime does not support streaming");
      }

      const turnAbortController = createTurnAbortController(request.sessionId);
      const generateOptionsWithAbort = {
        ...generateOptions,
        abortSignal: turnAbortController.signal,
      };
      let rawStreamResult: NativeAgentStreamResult;
      try {
        rawStreamResult = await agent.stream(modelInput, generateOptionsWithAbort);
      } catch (error) {
        clearTurnAbortController(request.sessionId, turnAbortController);
        throw error;
      }
    const tee = (
      rawStreamResult.fullStream as ReadableStream<NativeAgentStreamChunk> & {
        tee?: () => [
          ReadableStream<NativeAgentStreamChunk>,
          ReadableStream<NativeAgentStreamChunk>,
        ];
      }
    ).tee;
    const [hostEventSource, transportSource] =
      typeof tee === "function"
        ? tee.call(rawStreamResult.fullStream)
        : [
          new ReadableStream<NativeAgentStreamChunk>({
            start(controller) {
              controller.close();
            },
          }),
          rawStreamResult.fullStream,
        ];
    const mappedStream = hostEventSource.pipeThrough(
      new TransformStream<NativeAgentStreamChunk, AgentStreamEvent>({
        transform(chunk, controller) {
          if (!chunk?.type) return;

          if (chunk.type === "text-delta" || chunk.type === "reasoning-delta") {
            const text = String(chunk.payload?.text || "");
            if (text) controller.enqueue({ type: "text-delta", text });
            return;
          }

          if (chunk.type === "tool-call") {
            const toolName =
              typeof chunk.payload?.toolName === "string"
                ? chunk.payload.toolName
                : "unknown_tool";
            controller.enqueue({
              type: "tool-call",
              name: toolName,
              args:
                chunk.payload?.args && typeof chunk.payload.args === "object"
                  ? (chunk.payload.args as Record<string, unknown>)
                  : undefined,
            });
            return;
          }

          if (chunk.type === "tool-result") {
            const toolName =
              typeof chunk.payload?.toolName === "string"
                ? chunk.payload.toolName
                : "unknown_tool";
            controller.enqueue({
              type: "tool-result",
              name: toolName,
              result:
                chunk.payload?.result ??
                chunk.payload?.output ??
                chunk.payload?.content ??
                chunk.payload?.data,
            });
            return;
          }

          if (chunk.type === "tool-suspended" || chunk.type === "tool_suspended") {
            controller.enqueue({
              type: "approval-required",
              reason: "Tool suspended and awaiting user input",
              payload: chunk.payload,
            });
          }
        },
        flush(controller) {
          controller.enqueue({ type: "done" });
        },
      }),
    );
      const transportStreamResult: NativeAgentStreamResult = {
        ...rawStreamResult,
        fullStream: transportSource,
      };

      const result: GeneratedAgentTurnStreamResult = {
        stream: mappedStream,
        getFinalResult: async () => {
          const [text, toolCalls, usage, steps] = await Promise.all([
            rawStreamResult.text,
            rawStreamResult.toolCalls,
            Promise.resolve(rawStreamResult.usage).catch(() => undefined),
            Promise.resolve(rawStreamResult.steps).catch(() => undefined),
          ]);

          return {
            text: text || "",
            toolCalls: Array.isArray(toolCalls)
              ? toolCalls
                .filter((item) => typeof item?.toolName === "string")
                .map((item) => ({
                  name: item.toolName as string,
                  args: item.args || {},
                  toolCallId: item.toolCallId,
                }))
              : undefined,
            raw: {
              text,
              toolCalls,
              usage,
              steps,
              streamResult: rawStreamResult,
            },
          };
        },
        rawStreamResult: transportStreamResult,
      };
      return {
        ...result,
        getFinalResult: async () => {
          try {
            return await result.getFinalResult();
          } finally {
            clearTurnAbortController(request.sessionId, turnAbortController);
          }
        },
      };
    },
    async cancelTurn(sessionId) {
      const controller = turnAbortControllers.get(sessionId);
      if (!controller) return;
      controller.abort();
      turnAbortControllers.delete(sessionId);
    },
    async endSession(sessionId) {
      // No-op: GeneratedAgent lifecycle is managed by agent cache.
      turnAbortControllers.delete(sessionId);
    },
  };
};

const generateWithSessionRetry = async (
  session: HostSessionHandle,
  prompt: string | MultimodalMessage[],
  generateOptions: Record<string, unknown>,
  abortSignal: AbortSignal,
  maxAttempts = 3,
): Promise<AgentGenerateResult> => {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (abortSignal.aborted) {
      throw new Error("Run cancelled");
    }
    try {
      const turnResult = await session.sendAndWait({
        prompt: typeof prompt === "string" ? prompt : "[multimodal-prompt]",
        metadata: {
          modelInput: prompt,
          generateOptions,
        },
      });
      return asGenerateResultFromTurn(turnResult);
    } catch (error) {
      lastError = error;
      if (abortSignal.aborted) {
        throw error;
      }
      const shouldRetry = isRetryableModelError(error) && attempt < maxAttempts;

      if (!shouldRetry) {
        throw error;
      }

      const backoffMs = 600 * 2 ** (attempt - 1);
      console.warn(
        `[agent] transient model error (attempt ${attempt}/${maxAttempts}); retrying in ${backoffMs}ms`,
      );
      await sleep(backoffMs);
    }
  }

  throw lastError;
};

async function getOrCreateAgent(
  modelId: string,
  workspacePath: string,
  mcpServers: McpServerConfig[] = [],
  preferredAgentId?: string,
  terminalAutoApproveRules?: TerminalAutoApproveRules,
  useMastraObservationalMemory?: boolean,
  observationalMemorySettings?: ObservationalMemorySettingsPayload,
  streamErrorRetry?: StreamErrorRetryRequest,
) {
  // Initialize Language Model Tools system with MCP servers
  try {
    await initializeLanguageModelTools(mcpServers, workspacePath);
    console.log("✅ Language Model Tools initialized");
  } catch (error) {
    console.warn("⚠️ Failed to initialize Language Model Tools:", error);
  }

  const mcpFingerprint = toStableMcpFingerprint(mcpServers);
  const normalizedPreferredAgentId = preferredAgentId?.trim() || "";
  const terminalRulesFingerprint = getTerminalAutoApproveRulesFingerprint(
    terminalAutoApproveRules,
  );
  const memorySettingsFingerprint = JSON.stringify(
    observationalMemorySettings || {},
  );
  const streamErrorRetryFingerprint = JSON.stringify(streamErrorRetry || {});
  const memoryFingerprint = useMastraObservationalMemory
    ? `om:on:${memorySettingsFingerprint}`
    : "om:off";
  const key = `${modelId}:${workspacePath}:${mcpFingerprint}:${normalizedPreferredAgentId}:${terminalRulesFingerprint}:${memoryFingerprint}:retry:${streamErrorRetryFingerprint}`;
  if (agentCache.has(key)) {
    // Move to end to mark as recently used (LRU semantics via Map insertion order).
    const existing = agentCache.get(key)!;
    agentCache.delete(key);
    agentCache.set(key, existing);
    return existing;
  }
  let manifestExternalRegistration:
    | {
      id?: string;
      name?: string;
      description?: string;
      runtimeFactory: () => Promise<GeneratedAgent>;
    }
    | undefined;

  const externalManifestPath =
    process.env.IRIS_AGENT_EXTERNAL_AGENT_MANIFEST_PATH?.trim();
  if (externalManifestPath) {
    try {
      const lifecycle = new ExternalAgentLifecycleManager<GeneratedAgent>(
        externalManifestPath,
      );
      const externalRegistration = await lifecycle.createRegistration({
        modelId,
        workspacePath,
        mcpServers,
      });
      manifestExternalRegistration = {
        id: externalRegistration.descriptor.id,
        name: externalRegistration.descriptor.name,
        description:
          externalRegistration.descriptor.description ||
          "Manifest-based external agent runtime.",
        runtimeFactory: () =>
          Promise.resolve(externalRegistration.runtimeFactory()),
      };
    } catch (error) {
      const err = error as Error;
      console.warn(
        "[api] external manifest runtime unavailable, falling back to iris:",
        err.message,
      );
    }
  }
  const agentCore = await loadAgentCoreModule();

  const registry = createDefaultAgentRegistry<GeneratedAgent>({
    irisFactory: () =>
      agentCore.createCodingAgent(modelId, workspacePath, {
        mcpServers,
        terminalAutoApproveRules,
        // Non-observational requests already include the bounded conversation
        // history in the prompt. Enabling Mastra memory there would replay it
        // a second time and can exceed provider context windows.
        enableMemory: useMastraObservationalMemory === true,
        goalMaxRuns: 12,
        useMastraObservationalMemory,
        observationalMemorySettings,
        streamErrorRetry,
      }) as Promise<GeneratedAgent>,
    externalRegistration: manifestExternalRegistration,
  });

  const agent = await registry.createRuntime(
    normalizedPreferredAgentId || undefined,
    {
      requiredCapabilities: ["tool_calling", "streaming"],
      requiredPermissions: ["workspace_read"],
    },
  );
  if (agentCache.size >= AGENT_CACHE_MAX_SIZE) {
    // Evict the least-recently-used entry (first key in insertion order).
    const firstKey = agentCache.keys().next().value;
    if (firstKey !== undefined) {
      agentCache.delete(firstKey);
    }
  }
  agentCache.set(key, agent);
  return agent;
}

const inspectMcpServersForChat = async (
  servers: McpServerConfig[],
  workspacePath: string,
): Promise<McpDiscoverySummary[]> => {
  const summaries: McpDiscoverySummary[] = [];

  for (const server of servers) {
    try {
      const tools = await listMcpServerTools(server, workspacePath);
      summaries.push({
        name: server.name,
        command: server.command,
        toolNames: tools.map((tool) => tool.name),
      });
    } catch (error) {
      const err = error as Error;
      summaries.push({
        name: server.name,
        command: server.command,
        toolNames: [],
        error: err.message || "Failed to inspect MCP server",
      });
    }
  }

  return summaries;
};

const formatMcpContext = (summaries: McpDiscoverySummary[]): string => {
  if (summaries.length === 0) return "";

  const lines = ["", "**MCP SERVER STATUS:**"];

  for (const summary of summaries) {
    if (summary.error) {
      lines.push(
        `- **${summary.name}** (${summary.command}): unavailable - ${summary.error}`,
      );
      continue;
    }

    if (summary.toolNames.length === 0) {
      lines.push(
        `- **${summary.name}** (${summary.command}): connected but exposed no tools`,
      );
      continue;
    }

    lines.push(
      `- **${summary.name}** (${summary.command}): ${summary.toolNames.length} tool(s) available - ${summary.toolNames.join(", ")}`,
    );
  }

  lines.push(
    "- If the user asks why an MCP action failed, explain using the status above before suggesting a retry.",
  );

  return lines.join("\n");
};

const hasTerminalToolResults = (
  toolResults: Array<{ result: unknown }>,
): boolean =>
  toolResults.some((toolResult) => {
    const status = resolveToolExecutionStatus(toolResult.result);
    return status === "completed" || status === "failed";
  });

const hasNonterminalToolResults = (
  toolResults: Array<{ result: unknown }>,
): boolean =>
  toolResults.some((toolResult) => {
    const status = resolveToolExecutionStatus(toolResult.result);
    return (
      status === "pending" ||
      status === "in_progress" ||
      status === "unknown"
    );
  });

const getToolResultPayload = (
  result: unknown,
): Record<string, unknown> | null => {
  if (!result || typeof result !== "object") {
    return null;
  }

  const direct = result as Record<string, unknown>;
  const nestedValue = direct.value;
  if (nestedValue && typeof nestedValue === "object") {
    return nestedValue as Record<string, unknown>;
  }

  return direct;
};

const extractValidationFailures = (
  executedToolResults: Array<{ result: unknown }>,
): ValidationFailure[] => {
  const failures: ValidationFailure[] = [];

  for (const toolResult of executedToolResults) {
    const payload = getToolResultPayload(toolResult.result);
    if (!payload) continue;

    const validation = payload.validation;
    if (!validation || typeof validation !== "object") continue;

    for (const phase of ["lint", "test"] as const) {
      const phaseResult = (validation as Record<string, unknown>)[phase];
      if (!phaseResult || typeof phaseResult !== "object") continue;

      const record = phaseResult as Record<string, unknown>;
      if (record.enabled !== true || record.success !== false) continue;

      failures.push({
        phase,
        command:
          typeof record.command === "string" ? record.command : undefined,
        error: typeof record.error === "string" ? record.error : undefined,
        stdout: typeof record.stdout === "string" ? record.stdout : undefined,
        stderr: typeof record.stderr === "string" ? record.stderr : undefined,
      });
    }
  }

  return failures;
};

const isAutoFixValidationEnabled = (): boolean => {
  const raw = process.env.IRIS_AGENT_AUTO_FIX_VALIDATION;
  if (!raw) return true;

  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return true;
};

const asPositiveInt = (
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number => {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
};

const sanitizeStreamErrorRetryRequest = (
  value: unknown,
): StreamErrorRetryRequest | undefined => {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const input = value as Record<string, unknown>;
  const normalized: StreamErrorRetryRequest = {};

  if (typeof input.enabled === "boolean") {
    normalized.enabled = input.enabled;
  }

  if (typeof input.retryUnknownErrors === "boolean") {
    normalized.retryUnknownErrors = input.retryUnknownErrors;
  }

  if (
    typeof input.maxRetries === "number" &&
    Number.isFinite(input.maxRetries)
  ) {
    normalized.maxRetries = Math.max(
      0,
      Math.min(10, Math.floor(input.maxRetries)),
    );
  }

  if (
    typeof input.baseDelayMs === "number" &&
    Number.isFinite(input.baseDelayMs)
  ) {
    normalized.baseDelayMs = Math.max(
      50,
      Math.min(30_000, Math.floor(input.baseDelayMs)),
    );
  }

  if (
    typeof input.maxDelayMs === "number" &&
    Number.isFinite(input.maxDelayMs)
  ) {
    normalized.maxDelayMs = Math.max(
      50,
      Math.min(120_000, Math.floor(input.maxDelayMs)),
    );
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
};

const readWorkspaceAirisConfigForAgent = async (
  workspaceRoot: string,
): Promise<WorkspaceAirisConfig | null> => {
  const normalizedRoot = workspaceRoot.trim();
  if (!normalizedRoot) {
    return null;
  }

  const airisDirPath = path.join(normalizedRoot, ".airis");
  const settingsPath = path.join(airisDirPath, "settings.json");

  let airisStat: fsNative.Stats | null = null;
  try {
    airisStat = await fs.stat(airisDirPath);
  } catch (error) {
    const fsError = error as NodeJS.ErrnoException;
    if (!fsError || fsError.code !== "ENOENT") {
      throw error;
    }
  }

  let raw = "";
  if (airisStat?.isDirectory()) {
    raw = await fs.readFile(settingsPath, "utf8").catch((error) => {
      const fsError = error as NodeJS.ErrnoException;
      if (fsError && fsError.code === "ENOENT") {
        return "";
      }
      throw error;
    });
  } else if (airisStat?.isFile()) {
    // Backward compatibility: old installs used a single .airis JSON file.
    raw = await fs.readFile(airisDirPath, "utf8");
  } else {
    return null;
  }

  if (!raw) {
    return null;
  }

  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  return parsed as WorkspaceAirisConfig;
};

const shouldUseMastraManagedContextMode = (
  useMastraObservationalMemory?: boolean,
): boolean => {
  return useMastraObservationalMemory === true;
};

const isCodingObjectiveRequest = (
  message: string,
  hasToolResults: boolean,
  isSynthesisOnlyContinuation: boolean,
): boolean => {
  if (hasToolResults || isSynthesisOnlyContinuation) return false;
  return /\b(add|build|change|create|debug|edit|fix|implement|integrate|migrate|modify|refactor|remove|replace|test|update)\b/i.test(
    message,
  );
};

const asBoundedFloat = (
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number => {
  if (!value) return fallback;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
};

const getModelExecutionProfile = (modelId: string): ModelExecutionProfile => {
  const normalized = modelId.toLowerCase();

  const baseProfile: ModelExecutionProfile = {
    generateRetryAttempts: 3,
    reflectionMaxAttempts: 2,
    reflectionRetryAttempts: 2,
    reflectionMaxSteps: 8,
    maxStepsCapDesktop: 50,
    maxOutputTokens: 8192,
  };

  if (
    normalized.includes("gpt-5") ||
    normalized.includes("o3") ||
    normalized.includes("o4")
  ) {
    baseProfile.reflectionMaxAttempts = 3;
    baseProfile.reflectionMaxSteps = 10;
  } else if (normalized.includes("claude")) {
    baseProfile.reflectionMaxAttempts = 2;
    baseProfile.reflectionMaxSteps = 8;
  } else if (normalized.includes("gemini")) {
    baseProfile.reflectionMaxAttempts = 2;
    baseProfile.reflectionMaxSteps = 7;
  }

  baseProfile.generateRetryAttempts = asPositiveInt(
    process.env.IRIS_AGENT_MODEL_RETRY_ATTEMPTS,
    baseProfile.generateRetryAttempts,
    1,
    5,
  );
  baseProfile.reflectionMaxAttempts = asPositiveInt(
    process.env.IRIS_AGENT_REFLECTION_MAX,
    baseProfile.reflectionMaxAttempts,
    1,
    4,
  );
  baseProfile.reflectionRetryAttempts = asPositiveInt(
    process.env.IRIS_AGENT_REFLECTION_RETRY_ATTEMPTS,
    baseProfile.reflectionRetryAttempts,
    1,
    4,
  );
  baseProfile.reflectionMaxSteps = asPositiveInt(
    process.env.IRIS_AGENT_REFLECTION_MAX_STEPS,
    baseProfile.reflectionMaxSteps,
    1,
    20,
  );
  baseProfile.maxOutputTokens = asPositiveInt(
    process.env.IRIS_AGENT_MAX_OUTPUT_TOKENS,
    baseProfile.maxOutputTokens,
    256,
    65536,
  );

  return baseProfile;
};

const isHuggingFaceModelId = (candidateModelId: string): boolean => {
  const normalized = (candidateModelId || "").toLowerCase();
  if (!normalized) return false;
  if (normalized.startsWith("huggingface/")) return true;
  return normalized.endsWith(":fireworks-ai");
};

const isOpenRouterModelId = (candidateModelId: string): boolean => {
  const normalized = (candidateModelId || "").toLowerCase();
  if (!normalized) return false;
  if (normalized.startsWith("openrouter/")) return true;
  if (!normalized.includes("/")) return false;
  if (isHuggingFaceModelId(normalized)) return false;
  if (normalized.startsWith("google/")) return false;
  if (normalized.startsWith("ollama/")) return false;
  if (normalized.startsWith("local/")) return false;
  return true;
};

const extractProviderErrorDetails = (
  error: unknown,
): { code?: string; message: string } => {
  const errorRecord = error as Record<string, unknown>;
  const providerError = (errorRecord?.data as Record<string, unknown>)
    ?.error as
    | {
      code?: string | number;
      type?: string;
      message?: string;
      metadata?: { raw?: string };
    }
    | undefined;
  const code = providerError?.code ?? providerError?.type;
  const message =
    providerError?.metadata?.raw ||
    providerError?.message ||
    (errorRecord instanceof Error ? errorRecord.message : "") ||
    "Failed to generate response";

  return {
    code: code === undefined ? undefined : String(code),
    message,
  };
};

const getRateLimitErrorMessage = (modelId: string): string =>
  isOpenRouterModelId(modelId)
    ? "⚠️ OpenRouter rate limit reached. Please wait a moment and try again, or switch models/providers."
    : "⚠️ Provider rate limit reached. Please wait a moment and try again, or switch providers.";

const normalizeProviderRequestError = (
  modelId: string,
  message: string,
  code?: string,
): string => {
  const normalizedMessage = (message || "").trim();
  const lowerMessage = normalizedMessage.toLowerCase();
  const lowerCode = (code || "").toLowerCase();
  const isRateLimitError =
    lowerCode === "429" ||
    lowerCode.includes("rate_limit") ||
    lowerCode.includes("rate limit") ||
    lowerMessage.includes("rate_limit") ||
    lowerMessage.includes("rate limit") ||
    lowerMessage.includes("rate-limited") ||
    lowerMessage.includes("too many requests");
  const looksLikeProviderAuthFailure =
    lowerMessage.includes("user not found") ||
    lowerMessage.includes("invalid api key") ||
    lowerMessage.includes("unauthorized") ||
    lowerCode.includes("401");

  if (isRateLimitError) {
    return getRateLimitErrorMessage(modelId);
  }

  if (!looksLikeProviderAuthFailure) {
    return normalizedMessage || "Failed to generate response";
  }

  if (isOpenRouterModelId(modelId)) {
    return "OpenRouter rejected the configured API key. Replace OPENROUTER_API_KEY in Settings and click Save & Activate Keys.";
  }

  if (isHuggingFaceModelId(modelId)) {
    return "HuggingFace rejected the configured token. Replace HF_TOKEN in Settings and click Save & Activate Keys.";
  }

  return normalizedMessage || "Failed to generate response";
};

const extractToolExecutionFailures = (
  executedToolResults: Array<{
    name: string;
    args: Record<string, unknown>;
    result: unknown;
    status: ToolExecutionStatus;
  }>,
): ToolExecutionFailure[] => {
  const failures: ToolExecutionFailure[] = [];

  for (const toolResult of executedToolResults) {
    if (toolResult.status !== "failed") continue;

    const payload = getToolResultPayload(toolResult.result) || {};
    const error =
      typeof payload.error === "string"
        ? payload.error
        : typeof (toolResult.result as { error?: unknown })?.error === "string"
          ? (toolResult.result as { error?: string }).error || ""
          : undefined;

    failures.push({
      toolName: toolResult.name,
      args: toolResult.args,
      error,
      status: toolResult.status,
    });
  }

  return failures;
};

const buildFailureSignature = (
  validationFailures: ValidationFailure[],
  toolFailures: ToolExecutionFailure[],
): string => {
  const validation = validationFailures
    .map((failure) => ({
      phase: failure.phase,
      command: failure.command || "",
      error: failure.error || "",
      stderr: failure.stderr || "",
    }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

  const tools = toolFailures
    .map((failure) => ({
      toolName: failure.toolName,
      status: failure.status,
      error: failure.error || "",
    }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

  return JSON.stringify({ validation, tools });
};

const resolveGitSafetyMode = (): "off" | "suggest" | "enforce" => {
  const raw = (process.env.IRIS_AGENT_GIT_SAFETY_MODE || "suggest")
    .trim()
    .toLowerCase();
  if (raw === "off") return "off";
  if (raw === "enforce") return "enforce";
  return "suggest";
};

const getReflectionNoProgressRepeatThreshold = (): number =>
  asPositiveInt(process.env.IRIS_AGENT_REFLECTION_NO_PROGRESS_REPEATS, 1, 1, 5);

const detectGitRepo = async (workspacePath: string): Promise<boolean> => {
  try {
    await fs.access(path.join(workspacePath, ".git"));
    return true;
  } catch {
    return false;
  }
};

const hasSuccessfulEditExecution = (
  executedToolResults: Array<{ name: string; status: ToolExecutionStatus }>,
): boolean =>
  executedToolResults.some(
    (result) =>
      EDIT_TOOL_NAMES.has(result.name) && result.status === "completed",
  );

const MAX_PERSISTED_TOOL_RESULT_BYTES = 16 * 1024;
const PERSISTED_TOOL_RESULT_PREVIEW_CHARS = 4 * 1024;
const PERSISTED_TOOL_RESULT_SUMMARY_FIELD_CHARS = 1024;

const truncatePersistedSummaryString = (value: string): string => {
  if (value.length <= PERSISTED_TOOL_RESULT_SUMMARY_FIELD_CHARS) {
    return value;
  }

  return value.slice(0, PERSISTED_TOOL_RESULT_SUMMARY_FIELD_CHARS);
};

const getJsonByteLength = (value: unknown): number | null => {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return null;
  return Buffer.byteLength(serialized, "utf8");
};

const enforcePersistedSummaryByteLimit = (
  summary: Record<string, unknown>,
): Record<string, unknown> => {
  const bounded = { ...summary };
  const currentByteLength = (): number => getJsonByteLength(bounded) ?? 0;

  const shrinkStringField = (key: string): void => {
    const value = bounded[key];
    if (typeof value !== "string" || value.length === 0) return;

    while (currentByteLength() > MAX_PERSISTED_TOOL_RESULT_BYTES) {
      const current = bounded[key];
      if (typeof current !== "string" || current.length === 0) break;
      const overage =
        currentByteLength() - MAX_PERSISTED_TOOL_RESULT_BYTES;
      const nextLength = Math.max(0, current.length - Math.max(1, overage));
      bounded[key] = current.slice(0, nextLength);
      if (nextLength === 0) break;
    }
  };

  shrinkStringField("preview");
  const stringKeys = Object.keys(bounded)
    .filter((key) => key !== "preview" && typeof bounded[key] === "string")
    .sort(
      (a, b) =>
        String(bounded[b]).length - String(bounded[a]).length,
    );
  for (const key of stringKeys) {
    if (currentByteLength() <= MAX_PERSISTED_TOOL_RESULT_BYTES) break;
    shrinkStringField(key);
  }

  if (currentByteLength() > MAX_PERSISTED_TOOL_RESULT_BYTES) {
    for (const key of ["preview", ...stringKeys]) {
      if (currentByteLength() <= MAX_PERSISTED_TOOL_RESULT_BYTES) break;
      delete bounded[key];
    }
  }

  return bounded;
};

const summarizeToolResultForPersistence = (result: unknown): unknown => {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(result);
  } catch {
    return {
      truncated: true,
      reason: "Tool result could not be serialized for persistence",
    };
  }

  if (serialized === undefined) {
    return {
      truncated: true,
      reason: "Tool result has no JSON representation for persistence",
    };
  }

  const originalByteLength = Buffer.byteLength(serialized, "utf8");
  if (originalByteLength <= MAX_PERSISTED_TOOL_RESULT_BYTES) {
    return result;
  }

  const summary: Record<string, unknown> = {
    truncated: true,
    originalByteLength,
    preview: serialized.slice(0, PERSISTED_TOOL_RESULT_PREVIEW_CHARS),
  };
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return enforcePersistedSummaryByteLimit(summary);
  }

  const record = result as Record<string, unknown>;
  for (const key of [
    "success",
    "status",
    "error",
    "exitCode",
    "filePath",
    "path",
    "totalFiles",
    "filesWithMatches",
    "totalMatches",
  ]) {
    const value = record[key];
    if (typeof value === "string") {
      summary[key] = truncatePersistedSummaryString(value);
    } else if (typeof value === "number" || typeof value === "boolean") {
      summary[key] = value;
    }
  }

  return enforcePersistedSummaryByteLimit(summary);
};

const PERSISTED_TOOL_ARG_METADATA_KEYS = [
  "filePath",
  "path",
  "targetPath",
  "oldPath",
  "newPath",
  "startLine",
  "endLine",
  "line",
  "limit",
  "query",
  "pattern",
  "command",
  "cwd",
  "replaceAll",
] as const;

const summarizeToolArgsForPersistence = (args: unknown): unknown => {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(args);
  } catch {
    return {
      truncated: true,
      reason: "Tool arguments could not be serialized for persistence",
    };
  }

  if (serialized === undefined) {
    return {
      truncated: true,
      reason: "Tool arguments have no JSON representation for persistence",
    };
  }

  const originalByteLength = Buffer.byteLength(serialized, "utf8");
  if (originalByteLength <= MAX_PERSISTED_TOOL_RESULT_BYTES) {
    return args;
  }

  const summary: Record<string, unknown> = {
    truncated: true,
    originalByteLength,
    preview: serialized.slice(0, PERSISTED_TOOL_RESULT_PREVIEW_CHARS),
  };
  if (!isRecordValue(args)) {
    return enforcePersistedSummaryByteLimit(summary);
  }

  for (const key of PERSISTED_TOOL_ARG_METADATA_KEYS) {
    const value = args[key];
    if (typeof value === "string") {
      summary[key] = truncatePersistedSummaryString(value);
    } else if (typeof value === "number" || typeof value === "boolean") {
      summary[key] = value;
    }
  }

  return enforcePersistedSummaryByteLimit(summary);
};

const normalizeToolActionPayload = (
  eventType: string,
  payload: Record<string, unknown> | null,
): Record<string, unknown> | null => {
  if (
    !payload ||
    (eventType !== "tool_call" && eventType !== "tool_result")
  ) {
    return payload;
  }

  const name =
    typeof payload.name === "string"
      ? payload.name
      : typeof payload.toolName === "string"
        ? payload.toolName
        : undefined;
  if (!name) return payload;

  return {
    ...payload,
    name,
    toolName:
      typeof payload.toolName === "string" ? payload.toolName : name,
  };
};

/**
 * Format directory tree for display
 */
function formatDirectoryTree(
  tree: WorkspaceTreeNode | undefined,
  prefix = "",
  isLast = true,
): string {
  if (!tree) return "";

  let result = "";
  const connector = isLast ? "└── " : "├── ";
  const extension = isLast ? "    " : "│   ";

  result += prefix + connector + tree.name;
  if (tree.type === "directory") {
    result += "/";
  }
  result += "\n";

  if (tree.children && tree.children.length > 0) {
    // Sort: directories first, then files
    const sorted = [...tree.children].sort((a, b) => {
      if (a.type === b.type) return a.name.localeCompare(b.name);
      return a.type === "directory" ? -1 : 1;
    });

    sorted.forEach((child, index) => {
      const childIsLast = index === sorted.length - 1;
      result += formatDirectoryTree(child, prefix + extension, childIsLast);
    });
  }

  return result;
}

// POST /api/agent/chat - Send a message to the agent
router.post(
  "/chat",
  async (req: Request<{}, {}, AgentChatRequestBody>, res: Response) => {
    console.log("🔍 === REQUEST RECEIVED ===");
    console.log("Body keys:", Object.keys(req.body));
    console.log("Message:", req.body.message?.substring(0, 100));
    console.log("FilesInContext:", req.body.filesInContext);

    let requestedModelId = "gpt-4o";
    let activeRunId: string | undefined;
    let activeHostSession: HostSessionHandle | undefined;
    let activeHostSessionManager: HostSessionManager<AgentRuntime> | undefined;

    // Set longer timeout for this specific route (5 minutes)
    req.setTimeout(5 * 60 * 1000);
    res.setTimeout(5 * 60 * 1000);

    try {
      const {
        message,
        chatSessionId: rawChatSessionId,
        runId,
        conversationHistory,
        toolResults,
        modelId = "gpt-4o",
        filesInContext,
        workspaceRoot,
        workspaceStructure,
        isTauri,
        contextSummary, // Accumulated context from previous interactions
        enabledSkills: rawEnabledSkills,
        enableSlashCommands = true,
        approvalMode,
        preferredAgentId,
        mcpServers: rawMcpServers,
        terminalAutoApproveRules: rawTerminalAutoApproveRules,
        useMastraObservationalMemory: rawUseMastraObservationalMemory,
        observationalMemorySettings: rawObservationalMemorySettings,
        streamErrorRetry: rawStreamErrorRetry,
        stream = false,
      } = req.body;

      requestedModelId = modelId;
      if (
        typeof runId === "string" &&
        runId.trim().length > 0 &&
        !isSafeRunId(runId.trim())
      ) {
        return res
          .status(400)
          .json({ success: false, error: "Invalid run id" });
      }

      const chatSessionId =
        typeof rawChatSessionId === "string" ? rawChatSessionId.trim() : "";
      if (chatSessionId && !isSafeSessionId(chatSessionId)) {
        return res
          .status(400)
          .json({ success: false, error: "Invalid chat session id" });
      }

      const resolvedRunId =
        typeof runId === "string" && runId.trim().length > 0
          ? runId.trim()
          : `run_${randomUUID()}`;
      const workspaceMutationGenerationId = randomUUID();
      activeRunId = resolvedRunId;
      const mastraThreadId = chatSessionId || resolvedRunId;
      if (chatSessionId) {
        const activeTurnKey = `chat:${mastraThreadId}`;
        if (activeChatSessionTurns.has(activeTurnKey)) {
          return res.status(409).json({
            success: false,
            runId: resolvedRunId,
            lifecycleState: "queued",
            stopReason: "none",
            error:
              "Another prompt is already running for this chat session. Wait for it to finish before starting a new turn.",
          });
        }
        activeChatSessionTurns.add(activeTurnKey);
        const releaseActiveTurn = () => {
          activeChatSessionTurns.delete(activeTurnKey);
        };
        res.once("finish", releaseActiveTurn);
        res.once("close", releaseActiveTurn);
      }
      const mastraMemoryScope =
        rawUseMastraObservationalMemory === true
          ? {
            thread: mastraThreadId,
            resource: `iris-chat:${mastraThreadId}`,
          }
          : undefined;
      let lifecycleState: RunLifecycleState = "queued";
      let stopReason: RunStopReason = "none";

      const persistLifecycle = async (
        nextState: RunLifecycleState,
        nextStopReason: RunStopReason,
        eventType: string,
        payload?: Record<string, unknown>,
      ): Promise<void> => {
        lifecycleState = nextState;
        stopReason = nextStopReason;
        await safePersistRunLifecycleEvent({
          runId: resolvedRunId,
          lifecycleState: nextState,
          stopReason: nextStopReason,
          eventType,
          payload,
          objective: typeof message === "string" ? message.slice(0, 2000) : "",
          workspacePath: workspaceRoot || process.cwd(),
          modelId,
        });
      };

      let isWebWorkspaceForPersistence = false;
      const persistToolEvent = async (
        eventType: "tool_call" | "tool_result",
        payload: Record<string, unknown>,
        eventLifecycleState = lifecycleState,
      ): Promise<void> => {
        const toolName =
          typeof payload.name === "string"
            ? payload.name
            : typeof payload.toolName === "string"
              ? payload.toolName
              : "";
        const effectiveArgs =
          "args" in payload && isRecordValue(payload.args)
            ? sanitizeToolArgsForWorkspace(
                toolName,
                payload.args,
                isWebWorkspaceForPersistence,
              )
            : payload.args;
        const args =
          "args" in payload
            ? summarizeToolArgsForPersistence(
                redactToolResult(effectiveArgs).result,
              )
            : undefined;
        const result =
          "result" in payload
            ? summarizeToolResultForPersistence(payload.result)
            : undefined;
        const persistedPayload = {
          ...payload,
          ...("args" in payload ? { args } : {}),
          ...("result" in payload ? { result } : {}),
        };
        await safePersistRunLifecycleEvent({
          runId: resolvedRunId,
          lifecycleState: eventLifecycleState,
          stopReason,
          eventType,
          payload: persistedPayload,
          objective: typeof message === "string" ? message.slice(0, 2000) : "",
          workspacePath: workspaceRoot || process.cwd(),
          modelId,
        });
      };

      const transitionToCancelled = async (phase: string): Promise<void> => {
        await persistLifecycle("cancelled", "cancelled", "cancelled", {
          phase,
        });
      };

      const isCancelled = async (): Promise<boolean> => {
        try {
          return await isRunCancellationRequested(resolvedRunId);
        } catch (error) {
          const err = error as Error;
          // Fail-closed: if we can't confirm the cancellation state, treat the
          // run as cancelled rather than letting it continue (fail-open) or
          // throwing (which would abort the whole in-flight stream/response
          // with an unhandled 500 on every per-chunk check).
          console.warn(
            "[agent] Failed to read run cancellation state, treating run as cancelled:",
            err.message,
          );
          return true;
        }
      };
      const turnAbortController = new AbortController();
      let turnCancellationForwarded = false;
      const requestTurnCancellation = async (): Promise<void> => {
        if (!turnAbortController.signal.aborted) {
          turnAbortController.abort();
        }

        if (turnCancellationForwarded) {
          return;
        }
        turnCancellationForwarded = true;

        if (!activeHostSession) {
          return;
        }

        try {
          await activeHostSession.cancel();
        } catch (error) {
          console.warn(
            "[agent] Failed to propagate turn cancellation to host session:",
            getErrorMessage(error),
          );
        }
      };
      type CancelledDuringWait = { __cancelledDuringWait: true };
      const cancelledDuringWait: CancelledDuringWait = {
        __cancelledDuringWait: true,
      };
      const isCancelledWaitResult = (
        value: unknown,
      ): value is CancelledDuringWait =>
        Boolean(
          value &&
          typeof value === "object" &&
          "__cancelledDuringWait" in value &&
          (value as { __cancelledDuringWait?: unknown })
            .__cancelledDuringWait === true,
        );
      const waitForResultOrCancellation = async <T>(
        work: Promise<T>,
      ): Promise<T | CancelledDuringWait> => {
        let stopped = false;
        const waitForCancellation: Promise<CancelledDuringWait> = (async () => {
          while (!stopped) {
            if (await isCancelled()) {
              await requestTurnCancellation();
              return cancelledDuringWait;
            }
            await sleep(75);
          }
          return cancelledDuringWait;
        })();

        try {
          const settled = await Promise.race([work, waitForCancellation]);
          return settled;
        } finally {
          stopped = true;
        }
      };

      await persistLifecycle("queued", "none", "request_received", {
        hasConversationHistory:
          Array.isArray(conversationHistory) && conversationHistory.length > 0,
        hasToolResults: Array.isArray(toolResults) && toolResults.length > 0,
      });

      const enabledSkills = normalizeEnabledSkills(rawEnabledSkills);

      if (isTauri && approvalMode && approvalMode !== "Default Approvals") {
        return res.status(400).json({
          success: false,
          error:
            "Invalid approval mode for Tauri: only 'Default Approvals' is allowed",
          toolCalls: [],
          executedToolResults: [],
        });
      }

      const requestedMcpServers = sanitizeMcpServers(rawMcpServers);
      const terminalAutoApproveRules = sanitizeTerminalAutoApproveRules(
        rawTerminalAutoApproveRules,
      );
      const useMastraObservationalMemory =
        typeof rawUseMastraObservationalMemory === "boolean"
          ? rawUseMastraObservationalMemory
          : undefined;
      const observationalMemorySettings = sanitizeObservationalMemorySettings(
        rawObservationalMemorySettings,
      );
      const streamErrorRetry =
        sanitizeStreamErrorRetryRequest(rawStreamErrorRetry);
      const allowMcp = Boolean(isTauri && hasDesktopAuth(req));
      const mcpServers = allowMcp ? requestedMcpServers : [];

      if (!allowMcp && requestedMcpServers.length > 0) {
        console.warn("[mcp] Ignoring MCP servers without desktop auth");
      }

      console.log("📨 Request:", {
        messageLength: message?.length,
        hasHistory: !!conversationHistory,
        historyLength: conversationHistory?.length || 0,
        hasToolResults: Array.isArray(toolResults) && toolResults.length > 0,
        enabledSkillsCount: enabledSkills.length,
        isTauri,
      });

      // Build messages array with optional structured tool-result continuation.
      let messages = Array.isArray(conversationHistory)
        ? [...conversationHistory]
        : [];

      if (
        messages.length === 0 &&
        typeof message === "string" &&
        message.length > 0
      ) {
        messages.push({ role: "user", content: message });
      }

      const toolResultsContinuationMessage =
        serializeToolResultsForConversation(toolResults);
      if (toolResultsContinuationMessage) {
        messages.push({
          role: "user",
          content: toolResultsContinuationMessage,
          continuationType: "tool_results",
        });
      }

      // If Tauri mode, add note about tool execution
      if (isTauri) {
        console.log("🖥️ Tauri mode - tools will be executed in frontend");
      }

      if (messages.length === 0) {
        return res.status(400).json({ error: "Message is required" });
      }

      const effectiveMessage =
        typeof message === "string" && message.length > 0
          ? message
          : messages[messages.length - 1]?.content || "";

      // Use provided workspace root or default to current directory
      const workspacePath = workspaceRoot || process.cwd();
      const workspaceAirisConfig = await readWorkspaceAirisConfigForAgent(
        workspacePath,
      ).catch((error) => {
        const err = error as Error;
        console.warn(
          "[agent] failed to read workspace AIRIS config:",
          err.message,
        );
        return null;
      });
      const workspaceStreamErrorRetry = sanitizeStreamErrorRetryRequest(
        workspaceAirisConfig?.agent?.streamErrorRetry,
      );
      const effectiveStreamErrorRetry =
        streamErrorRetry ?? workspaceStreamErrorRetry;
      await persistLifecycle("running", "none", "run_started", {
        workspacePath,
        modelId,
      });

      if (await isCancelled()) {
        if (!stream) {
          await transitionToCancelled("run_started");
          return res.status(409).json({
            success: false,
            runId: resolvedRunId,
            lifecycleState,
            stopReason,
            error: "Run was cancelled",
          });
        }
      }

      const modelProfile = getModelExecutionProfile(modelId);
      const gitSafetyMode = resolveGitSafetyMode();
      const gitDetected = await detectGitRepo(workspacePath);

      const parsedSlashCommand = parseSlashCommandRequest(effectiveMessage);
      if (parsedSlashCommand) {
        if (!enableSlashCommands) {
          // User disabled slash command execution in settings; treat this as normal chat input.
        } else if (
          !isSlashCommandExecutionAllowed(req, isTauri, enableSlashCommands)
        ) {
          return res.status(403).json({
            success: false,
            error:
              "Slash command execution is disabled or not allowed in this context",
            toolCalls: [],
            executedToolResults: [],
          });
        } else {
          const builtInSlashResult = executeRegisteredSlashCommand({
            parsedCommand: parsedSlashCommand,
            conversationHistory,
            contextSummary,
          });

          if (builtInSlashResult) {
            return res.json(builtInSlashResult);
          }

          const slashCommand = parsedSlashCommand.shellCommand;
          if (!slashCommand) {
            return res.status(400).json({
              success: false,
              error: `Slash command '/${parsedSlashCommand.name}' requires a shell command argument`,
              toolCalls: [],
              executedToolResults: [],
            });
          }

          const toolArgs = {
            command: slashCommand,
            cwd: workspacePath,
            description: `Slash command: ${slashCommand}`,
          };

          const commandResult = await executeCommand({
            ...toolArgs,
            workspaceRoot: workspacePath,
          });
          const status = resolveToolExecutionStatus(commandResult);

          if (status === "pending_confirmation") {
            const confirmationId =
              (commandResult as { confirmationId?: string }).confirmationId ||
              "";

            if (!confirmationId) {
              return res.status(500).json({
                success: false,
                error:
                  "Command entered pending confirmation state without confirmationId",
                toolCalls: [],
                executedToolResults: [
                  {
                    name: "executeCommand",
                    args: toolArgs,
                    result: commandResult,
                    status,
                  },
                ],
              });
            }

            return res.json({
              success: true,
              response: `Pending approval for command: ${slashCommand}`,
              requiresConfirmation: true,
              pendingConfirmations: [
                {
                  confirmationId,
                  command:
                    (commandResult as { command?: string }).command ||
                    slashCommand,
                  action: (commandResult as { action?: string }).action,
                  target: (commandResult as { target?: string }).target,
                  toolName: "executeCommand",
                  toolArgs,
                },
              ],
              toolCalls: [],
              executedToolResults: [
                {
                  name: "executeCommand",
                  args: toolArgs,
                  result: commandResult,
                  status,
                },
              ],
            });
          }

          if (status === "pending" || status === "in_progress") {
            return res.json({
              success: false,
              response:
                status === "in_progress"
                  ? "Command is still running"
                  : "Command is pending",
              status,
              taskId:
                typeof (commandResult as { taskId?: unknown }).taskId ===
                  "string"
                  ? (commandResult as { taskId?: string }).taskId
                  : undefined,
              toolCalls: [],
              executedToolResults: [
                {
                  name: "executeCommand",
                  args: toolArgs,
                  result: commandResult,
                  status,
                },
              ],
            });
          }

          const commandSucceeded = status === "completed";
          const commandError =
            (commandResult as { error?: unknown }).error &&
              typeof (commandResult as { error?: unknown }).error === "string"
              ? (commandResult as { error?: string }).error || "Command failed"
              : "Command failed";
          const stdoutText =
            typeof (commandResult as { stdout?: unknown }).stdout === "string"
              ? (commandResult as { stdout?: string }).stdout || ""
              : "";
          const stderrText =
            typeof (commandResult as { stderr?: unknown }).stderr === "string"
              ? (commandResult as { stderr?: string }).stderr || ""
              : "";
          const responseText = commandSucceeded
            ? stdoutText || "Command executed"
            : stderrText || commandError;

          return res.json({
            success: commandSucceeded,
            response: responseText,
            ...(commandSucceeded ? {} : { error: commandError }),
            toolCalls: [],
            executedToolResults: [
              {
                name: "executeCommand",
                args: toolArgs,
                result: commandResult,
                status,
              },
            ],
          });
        }
      }

      const mcpDiscovery = allowMcp
        ? await inspectMcpServersForChat(mcpServers, workspacePath)
        : [];

      // Detect if this is a web-based workspace (virtual path)
      const isWebWorkspace = workspacePath.startsWith("/workspace/");
      isWebWorkspaceForPersistence = isWebWorkspace;

      // Generate environment snapshot for first message (non-web workspaces only)
      let envSnapshotMarkdown = "";
      const isFirstMessage =
        !conversationHistory || conversationHistory.length <= 1;

      if (!isWebWorkspace && isFirstMessage) {
        console.log("📸 Generating environment snapshot for first message...");
        try {
          // Check cache first
          const cacheKey = workspacePath;
          let snapshot = envSnapshotCache.get(cacheKey);

          if (!snapshot) {
            snapshot = await getEnvironmentSnapshot(workspacePath);
            // Cache for 5 minutes
            envSnapshotCache.set(cacheKey, snapshot);
            const evictionTimer = setTimeout(
              () => envSnapshotCache.delete(cacheKey),
              5 * 60 * 1000,
            );
            evictionTimer.unref();
          }

          envSnapshotMarkdown = formatSnapshotAsMarkdown(snapshot);
          console.log("✅ Environment snapshot generated");
        } catch (error) {
          const err = error as Error;
          console.warn(
            "⚠️ Failed to generate environment snapshot:",
            err.message,
          );
          // Continue without snapshot
        }
      }

      // Get or create agent for this model/workspace combination
      const effectivePreferredAgentId =
        preferredAgentId ||
        process.env.IRIS_AGENT_PREFERRED_AGENT_ID ||
        undefined;
      const agent = await getOrCreateAgent(
        modelId,
        workspacePath,
        mcpServers,
        effectivePreferredAgentId,
        terminalAutoApproveRules,
        useMastraObservationalMemory,
        observationalMemorySettings,
        effectiveStreamErrorRetry,
      );

      const hostSessionId = chatSessionId || resolvedRunId;
      activeHostSessionManager = new HostSessionManager<AgentRuntime>(
        () => Promise.resolve(createGeneratedAgentRuntimeAdapter(agent)),
        {
          workspacePath,
          modelId,
          metadata: {
            runId: resolvedRunId,
            preferredAgentId: effectivePreferredAgentId || "iris",
          },
        },
      );
      activeHostSession = await activeHostSessionManager.resumeSession(
        hostSessionId,
        {
          modelId,
          metadata: {
            runId: resolvedRunId,
            threadId: mastraThreadId,
          },
        },
      );

      // Build workspace context
      let contextInfo = `

**WORKSPACE:**`;

      if (isWebWorkspace) {
        contextInfo += `
- **Environment:** Web workspace
- **Name:** ${workspacePath.split("/").pop()}`;

        if (workspaceStructure) {
          contextInfo += `
- **Structure:**
\`\`\`
${formatDirectoryTree(workspaceStructure)}
\`\`\``;
        }

        contextInfo += `
- Treat paths as workspace-relative (for example, \`src/index.js\`).
- Use the provided structure and file context; request missing file contents only when needed.
- Answer directly; avoid generic follow-up questions.`;
      } else {
        contextInfo += `
- **Root:** ${workspacePath}
- Use \`getWorkspaceInfo\` with \`{ "workspacePath": "${workspacePath}", "includeTree": true }\`.
- Use workspace-relative paths with file tools (for example, \`src/index.js\`).`;

        if (gitDetected && gitSafetyMode !== "off") {
          contextInfo += `
- **Git Safety:** repository detected.
  - Preserve existing worktree changes; do not stage, commit, stash, or revert them unless the user explicitly requests it.
  - Keep edits scoped and reversible, and avoid destructive git commands.
  - If edits fail, provide undo guidance and a minimal recovery plan.`;
        }

        // Add environment snapshot if this is the first message
        if (envSnapshotMarkdown) {
          contextInfo += `

${envSnapshotMarkdown}`;
        }
      }

      if (mcpDiscovery.length > 0) {
        contextInfo += `
${formatMcpContext(mcpDiscovery)}`;
      }

      // Add accumulated context summary if available
      if (contextSummary && contextSummary.length > 0) {
        contextInfo += `

**ACCUMULATED KNOWLEDGE (from previous interactions):**
_You have discovered the following in earlier interactions. Use this to avoid repeating searches._

`;
        for (const ctx of contextSummary.slice(-10)) {
          // Last 10 contexts only
          contextInfo += `- ${ctx.id}: ${ctx.preview}...\n`;
        }
        contextInfo +=
          "\n_Use this accumulated knowledge to build upon previous work._\n";
      }

      // Add safety check for filesInContext
      const safeFilesInContext = (filesInContext || []).slice(
        0,
        MAX_CONTEXT_FILES,
      );

      if ((filesInContext || []).length > MAX_CONTEXT_FILES) {
        contextInfo += `\n\n*Only the first ${MAX_CONTEXT_FILES} files in context are included for prompt budget safety.*`;
      }

      if (safeFilesInContext.length > 0) {
        contextInfo += "\n\n**Files in Context:**";

        // Check if files already have content (from web workspace)
        const filesHaveContent = safeFilesInContext.some(
          (f: any) => f.content !== undefined,
        );

        if (filesHaveContent) {
          // Files from web workspace with content already provided
          for (const file of safeFilesInContext) {
            contextInfo += `\n\n### File: ${file.name}`;
            contextInfo += `\n**Path:** \`${file.path}\`\n`;

            if (file.content) {
              const inlineContent = truncateText(
                file.content,
                MAX_INLINE_FILE_CONTENT_CHARS,
              );
              contextInfo += `\`\`\`\n${inlineContent}\n\`\`\`\n`;
            } else if (file.skippedReason) {
              contextInfo += `*Skipped inline file: ${file.skippedReason}*\n`;
            } else if (file.error) {
              contextInfo += `*Error reading file: ${file.error}*\n`;
            } else {
              contextInfo += "*Content not available*\n";
            }
          }
        } else if (!isWebWorkspace) {
          // For non-web workspaces, read actual file contents from filesystem
          for (const file of safeFilesInContext) {
            contextInfo += `\n\n### File: ${file.name}`;
            contextInfo += `\n**Path:** \`${file.path}\`\n`;

            try {
              // Resolve file path relative to workspace
              const filePath = path.isAbsolute(file.path)
                ? file.path
                : path.join(workspacePath, file.path);

              const content = await fs.readFile(filePath, "utf8");
              const inlineContent = truncateText(
                content,
                MAX_INLINE_FILE_CONTENT_CHARS,
              );
              contextInfo += `\`\`\`\n${inlineContent}\n\`\`\`\n`;
            } catch (err) {
              contextInfo += `*Error reading file: ${getErrorMessage(err)}*\n`;
            }
          }
        } else {
          // For web workspaces without content
          contextInfo += `\n${safeFilesInContext
            .map((f: any) => `- ${f.name}: ${f.path}`)
            .join("\n")}`;
          contextInfo +=
            "\n\n**Note:** File contents should be provided by the user or requested through the interface.";
        }
      }

      const modelInputTokenLimit = resolveModelInputTokenLimit(modelId);
      const promptBudgetRatio = asBoundedFloat(
        process.env.IRIS_AGENT_PROMPT_TOKEN_BUDGET_RATIO,
        DEFAULT_PROMPT_TOKEN_BUDGET_RATIO,
        0.2,
        0.8,
      );
      const promptTokenBudget = Math.max(
        MIN_PROMPT_TOKEN_BUDGET,
        Math.min(
          Math.floor(modelInputTokenLimit * promptBudgetRatio),
          Math.max(
            MIN_PROMPT_TOKEN_BUDGET,
            modelInputTokenLimit - PROMPT_TOKEN_RESERVE,
          ),
        ),
      );
      const mastraManagedContextMode = shouldUseMastraManagedContextMode(
        useMastraObservationalMemory,
      );

      const promptBuild = buildPromptWithinTokenBudget({
        effectiveMessage: truncateText(
          typeof messages[messages.length - 1]?.content === "string"
            ? messages[messages.length - 1].content
            : effectiveMessage,
          MAX_CONVERSATION_MESSAGE_CHARS,
        ),
        conversationHistory: mastraManagedContextMode ? undefined : messages,
        contextInfo,
        maxPromptTokens: promptTokenBudget,
        maxConversationMessages: MAX_CONVERSATION_MESSAGES,
        maxConversationMessageTokens: MAX_CONVERSATION_MESSAGE_TOKENS,
        continuationInstruction: isSynthesisOnlyContinuationMessage(
          messages[messages.length - 1],
        )
          ? "**IMPORTANT:** The tool results above contain the information needed to answer the user's question. Please analyze these results and provide a clear, detailed response that directly answers what the user asked. Do not request more tools unless absolutely necessary."
          : undefined,
      });

      const budgetedContextInfo = promptBuild.budgetedContextInfo;
      const budgetedConversationHistory =
        promptBuild.budgetedConversationHistory;
      const prompt = promptBuild.prompt;

      const multimodalImageParts = resolveModelSupportsVision(modelId)
        ? await resolveImageMessageParts(
          safeFilesInContext,
          workspacePath,
          isWebWorkspace,
          hasDesktopAuth(req),
        )
        : [];
      const modelInput: string | MultimodalMessage[] =
        multimodalImageParts.length > 0
          ? [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: prompt,
                },
                ...multimodalImageParts,
              ],
            },
          ]
          : prompt;

      console.log("📏 Prompt budget", {
        modelInputTokenLimit,
        promptBudgetRatio,
        promptTokenBudget,
        contextInfoChars: budgetedContextInfo.length,
        promptChars: prompt.length,
        promptEstimatedTokens: promptBuild.promptEstimatedTokens,
        historyMessages: budgetedConversationHistory.length,
        contextFilesIncluded: safeFilesInContext.length,
        multimodalImagesIncluded: multimodalImageParts.length,
      });

      // Generate response with agent
      // When tools are executed on frontend (web or Tauri), we need to handle continuation
      // - If conversation history contains tool results, we want a TEXT RESPONSE, not more tools
      // - Otherwise, get tool calls and return them to frontend

      // Check whether the last message requires a synthesis-only continuation.
      const lastMessage = messages[messages.length - 1];
      const isSynthesisOnlyContinuation =
        isSynthesisOnlyContinuationMessage(lastMessage);

      if (
        typeof effectiveMessage === "string" &&
        isCodingObjectiveRequest(
          effectiveMessage,
          Array.isArray(toolResults) && toolResults.length > 0,
          isSynthesisOnlyContinuation,
        ) &&
        typeof agent.setObjective === "function"
      ) {
        await agent.setObjective(effectiveMessage, {
          threadId: mastraThreadId,
          resourceId: `iris-chat:${mastraThreadId}`,
          maxRuns: 12,
        });
      }

      // Extract any relevant options from the request body
      // Note: isWebWorkspace already declared at line 89

      // Get maxSteps from request body (sourced from settings.agentMaxSteps in the client),
      // falling back to the desktop cap. The same hard cap applies to both web and desktop
      // so the user-configured value is always honoured.
      const requestedMaxSteps = req.body.maxSteps;
      const defaultMaxSteps = modelProfile.maxStepsCapDesktop;
      const hardCap = 100;
      let maxSteps = Math.max(
        1,
        Math.min(
          hardCap,
          typeof requestedMaxSteps === "number"
            ? requestedMaxSteps
            : defaultMaxSteps,
        ),
      );
      const maxToolCalls = maxSteps;

      // Cap completion tokens so providers don't bill for the model's full max
      // context window. Honors a per-request override, clamped to a safe range.
      const requestedMaxOutputTokens = req.body.maxOutputTokens;
      const maxOutputTokens = Math.max(
        256,
        Math.min(
          65536,
          typeof requestedMaxOutputTokens === "number" &&
            Number.isFinite(requestedMaxOutputTokens)
            ? requestedMaxOutputTokens
            : modelProfile.maxOutputTokens,
        ),
      );

      const toolCallBudget: ToolCallBudget = {
        limit: maxToolCalls,
        admitted: 0,
      };
      const stopWhenToolBudgetReached = ({
        steps,
      }: {
        steps: Array<{ toolCalls?: unknown[] }>;
      }) =>
        toolCallBudget.admitted >= maxToolCalls ||
        toolCallBudget.stopReason === "repeated_call" ||
        steps.reduce(
          (total, step) =>
            total + (Array.isArray(step.toolCalls) ? step.toolCalls.length : 0),
          0,
        ) >= maxToolCalls;
      const { createAgentRequestContext } = await loadAgentCoreModule();
      const agentRequestContext = createAgentRequestContext(enabledSkills, {
        workspaceMutationGenerationId,
        toolCallBudget,
        workspaceRoot: workspacePath,
        isWebWorkspace,
        gitDetected,
        modelId,
        contextFilesMeta: safeFilesInContext.map((file) => ({
          name: typeof file?.name === "string" ? file.name : undefined,
          path: typeof file?.path === "string" ? file.path : undefined,
          type: typeof file?.type === "string" ? file.type : undefined,
          size: typeof file?.size === "number" ? file.size : undefined,
          isImage: isLikelyImageFile(file),
        })),
        multimodalImageCount: multimodalImageParts.length,
      });
      const generateOptions = {
        maxSteps: maxSteps,
        maxOutputTokens,
        ...(mastraMemoryScope ? { memory: mastraMemoryScope } : {}),
        toolChoice: "auto" as "auto" | "none" | "required",
        toolCallConcurrency: 1,
        stopWhen: stopWhenToolBudgetReached,
        requestContext: agentRequestContext,
        abortSignal: turnAbortController.signal,
      };

      if (isSynthesisOnlyContinuation) {
        generateOptions.maxSteps = 1;
        generateOptions.toolChoice = "none";
      }

      const generateBackendOnlySynthesis = async (
        completedToolResults: ExecutedToolResult[],
        stopReason?: ToolCallBudget["stopReason"] | "empty_final_response",
      ): Promise<AgentGenerateResult | CancelledDuringWait> => {
        const completedResults =
          completedToolResults.length > 0
            ? serializeToolResultsForContinuation(
              completedToolResults.map(({ name, result }) => ({
                name,
                result,
              })),
              "unknown_tool",
            )
            : "No tools completed before the action budget was exhausted.";
        const stopReasonExplanation =
          stopReason === "repeated_call"
            ? "The same tool was called with identical arguments several times in a row, so tool execution was stopped to avoid a repetitive loop. Briefly tell the user this happened (which tool, and that it was called repeatedly with the same arguments) before summarizing whatever was accomplished, based on the actual outcomes in the completed tool results below — do not assume the repeated calls failed."
            : stopReason === "empty_final_response"
              ? "Tool execution finished, but the model returned no final response. Summarize the completed work from the tool results below in a concise final answer."
              : "The server-side tool-action budget is exhausted.";
        const synthesisPrompt = `${prompt}\n\n${stopReasonExplanation} Do not call any tools. Produce the final answer now using only the conversation and completed tool results below. Clearly distinguish verified findings from uncertainty.\n\nCompleted tool results:\n${completedResults}`;

        const synthesisOptions = {
          maxSteps: 1,
          maxOutputTokens,
          ...(mastraMemoryScope ? { memory: mastraMemoryScope } : {}),
          toolChoice: "none" as const,
          toolCallConcurrency: 1,
          requestContext: agentRequestContext,
          abortSignal: turnAbortController.signal,
        };

        if (activeHostSession) {
          return await waitForResultOrCancellation(
            generateWithSessionRetry(
              activeHostSession,
              synthesisPrompt,
              synthesisOptions,
              turnAbortController.signal,
              modelProfile.generateRetryAttempts,
            ),
          );
        }

        return await waitForResultOrCancellation(
          generateWithRetry(
            agent,
            synthesisPrompt,
            synthesisOptions,
            turnAbortController.signal,
            modelProfile.generateRetryAttempts,
          ),
        );
      };

      if (stream) {
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");

        // Prevent idle intermediaries (and strict clients) from closing long-running
        // streams while tools execute without emitting deltas.
        const STREAM_KEEPALIVE_MS = 15_000;
        let keepAliveTimer: NodeJS.Timeout | null = null;
        const stopKeepAlive = () => {
          if (keepAliveTimer) {
            clearInterval(keepAliveTimer);
            keepAliveTimer = null;
          }
        };

        const startKeepAlive = () => {
          stopKeepAlive();
          keepAliveTimer = setInterval(() => {
            if (res.writableEnded || res.destroyed) {
              stopKeepAlive();
              return;
            }
            try {
              res.write(`: keepalive ${Date.now()}\n\n`);
            } catch {
              stopKeepAlive();
            }
          }, STREAM_KEEPALIVE_MS);
        };

        res.on("close", stopKeepAlive);
        startKeepAlive();

        const writeEvent = (event: string, data: unknown) => {
          res.write(`event: ${event}\n`);
          res.write(`data: ${JSON.stringify(data)}\n\n`);
        };

        try {
          if (await isCancelled()) {
            await transitionToCancelled("before_stream_start");
            writeEvent("lifecycle", {
              runId: resolvedRunId,
              lifecycleState,
              stopReason,
            });
            writeEvent("done", {
              success: false,
              runId: resolvedRunId,
              lifecycleState,
              stopReason,
              cancelled: true,
              response: "Run cancelled",
              toolCalls: [],
              executedToolResults: [],
              suspendedTools: [],
              thoughtSteps: [],
              model: modelId,
              autoFixAttempted: false,
              autoFixFailureCount: 0,
              maxStepsReached: false,
              stepsUsed: 0,
              maxSteps,
            });
            stopKeepAlive();
            res.end();
            return;
          }

          await persistLifecycle("running", "none", "model_stream_started", {
            maxSteps,
            maxOutputTokens,
          });
          writeEvent("lifecycle", {
            runId: resolvedRunId,
            lifecycleState,
            stopReason,
          });

          const streamResultPromise = activeHostSession
            ? (async () => {
              const hostStreamResult = await activeHostSession.sendStream({
                prompt:
                  typeof modelInput === "string"
                    ? modelInput
                    : "[multimodal-prompt]",
                metadata: {
                  modelInput,
                  generateOptions,
                },
              });

              const rawFromSession = (hostStreamResult as any)
                .rawStreamResult as
                | {
                  fullStream: ReadableStream<any>;
                  text: Promise<string>;
                  toolCalls: Promise<
                    Array<{
                      toolName?: string;
                      args?: Record<string, unknown>;
                      toolCallId?: string;
                    }>
                  >;
                  usage?: Promise<unknown> | unknown;
                  steps?: Promise<StreamStep[]> | StreamStep[];
                }
                | undefined;

              if (rawFromSession) {
                void hostStreamResult.stream.cancel().catch((error: unknown) => {
                  console.error("Failed to cancel host stream adapter:", error);
                });
                return rawFromSession;
              }

              throw new Error(
                "Host session stream transport unavailable for SSE chunk pipeline",
              );
            })()
            : (
              agent as unknown as {
                stream: (
                  ...args: [
                    string | MultimodalMessage[],
                    Record<string, unknown>,
                  ]
                ) => Promise<{
                  fullStream: ReadableStream<any>;
                  text: Promise<string>;
                  toolCalls: Promise<
                    Array<{
                      toolName?: string;
                      args?: Record<string, unknown>;
                      toolCallId?: string;
                    }>
                  >;
                  usage?: Promise<unknown> | unknown;
                  steps?: Promise<StreamStep[]> | StreamStep[];
                }>;
              }
            ).stream(modelInput, generateOptions);
          const streamResultOrCancellation = await waitForResultOrCancellation(
            streamResultPromise,
          );
          if (isCancelledWaitResult(streamResultOrCancellation)) {
            await transitionToCancelled("before_stream_reader");
            writeEvent("lifecycle", {
              runId: resolvedRunId,
              lifecycleState,
              stopReason,
            });
            writeEvent("done", {
              success: false,
              runId: resolvedRunId,
              lifecycleState,
              stopReason,
              cancelled: true,
              response: "Run cancelled",
              toolCalls: [],
              executedToolResults: [],
              suspendedTools: [],
              thoughtSteps: [],
              model: modelId,
              autoFixAttempted: false,
              autoFixFailureCount: 0,
              maxStepsReached: false,
              stepsUsed: 0,
              maxSteps,
            });
            stopKeepAlive();
            res.end();
            return;
          }
          const streamResult = streamResultOrCancellation;

          const reader = streamResult.fullStream.getReader();
          const thoughtBuffer: string[] = [];
          const streamedPendingToolCalls: PendingToolCall[] = [];
          const streamedExecutedToolResults: ExecutedToolResult[] = [];
          const streamedSuspendedTools: SuspendedToolCall[] = [];
          const streamedToolCallArgs = new Map<
            string,
            Record<string, unknown>
          >();
          const streamedAnonymousToolCallArgs: AnonymousToolCallArgs[] = [];
          const emittedPendingCounts = new Map<string, number>();
          let streamTokenUsage: TokenUsageSummary | undefined;
          let streamUsageSeenInChunks = false;

          const getPendingKey = (call: PendingToolCall): string => {
            const signature = getToolCallSignature(call.name, call.args || {});
            if (call.toolCallId) return `id:${call.toolCallId}:${signature}`;
            return signature;
          };
          const getEmittedInvocationKey = (
            toolName: string,
            toolCallId: string | undefined,
            args: Record<string, unknown>,
          ): string =>
            toolCallId
              ? `id:${toolCallId}:${getToolCallSignature(toolName, args)}`
              : getToolCallSignature(toolName, args);
          const emittedToolCallKeys = new Set<string>();
          const persistedStreamToolActionKeys = new Set<string>();
          const getPersistedStreamToolActionKey = (
            eventType: "tool_call" | "tool_result",
            toolName: string,
            toolCallId: string | undefined,
            args: Record<string, unknown>,
          ): string =>
            `${eventType}:${getEmittedInvocationKey(
              toolName,
              toolCallId,
              args,
            )}`;
          const resolveStreamToolResultArgs = (
            toolName: string,
            toolCallId: string | undefined,
            chunkArgs: unknown,
          ): Record<string, unknown> =>
            resolveToolResultArgs(
              toolName,
              toolCallId,
              chunkArgs,
              streamedToolCallArgs,
              streamedAnonymousToolCallArgs,
            );

          while (true) {
            const streamReadOrCancellation = await waitForResultOrCancellation(
              reader.read(),
            );
            if (isCancelledWaitResult(streamReadOrCancellation)) {
              await reader.cancel().catch(() => undefined);
              await transitionToCancelled("stream_read_wait");
              writeEvent("lifecycle", {
                runId: resolvedRunId,
                lifecycleState,
                stopReason,
              });
              writeEvent("done", {
                success: false,
                runId: resolvedRunId,
                lifecycleState,
                stopReason,
                cancelled: true,
                response: "Run cancelled",
                toolCalls: [],
                executedToolResults: [],
                suspendedTools: streamedSuspendedTools,
                thoughtSteps:
                  thoughtBuffer.length > 0 ? [thoughtBuffer.join("")] : [],
                model: modelId,
                autoFixAttempted: false,
                autoFixFailureCount: 0,
                maxStepsReached: false,
                stepsUsed: 0,
                maxSteps,
              });
              stopKeepAlive();
              res.end();
              return;
            }

            const { value, done } = streamReadOrCancellation;
            if (done) break;

            if (await isCancelled()) {
              await requestTurnCancellation();
              await reader.cancel().catch(() => undefined);
              await transitionToCancelled("stream_iteration");
              writeEvent("lifecycle", {
                runId: resolvedRunId,
                lifecycleState,
                stopReason,
              });
              writeEvent("done", {
                success: false,
                runId: resolvedRunId,
                lifecycleState,
                stopReason,
                cancelled: true,
                response: "Run cancelled",
                toolCalls: [],
                executedToolResults: [],
                suspendedTools: streamedSuspendedTools,
                thoughtSteps:
                  thoughtBuffer.length > 0 ? [thoughtBuffer.join("")] : [],
                model: modelId,
                autoFixAttempted: false,
                autoFixFailureCount: 0,
                maxStepsReached: false,
                stepsUsed: 0,
                maxSteps,
              });
              stopKeepAlive();
              res.end();
              return;
            }

            const chunk = value as {
              type?: string;
              payload?: Record<string, unknown>;
            };
            if (!chunk?.type) continue;

            if (chunk.payload) {
              const chunkUsage = extractTokenUsageFromChunkPayload(
                chunk.payload,
              );
              if (chunkUsage) {
                streamUsageSeenInChunks = true;
              }
              streamTokenUsage = mergeTokenUsage(streamTokenUsage, chunkUsage);
            }

            if (chunk.type === "reasoning-delta") {
              const delta = String(chunk.payload?.text || "");
              if (delta) {
                thoughtBuffer.push(delta);
                writeEvent("thought_delta", { text: delta });
              }
              continue;
            }

            if (chunk.type === "text-delta") {
              const delta = String(chunk.payload?.text || "");
              if (delta) {
                writeEvent("text_delta", { text: delta });
              }
              continue;
            }

            if (chunk.type === "tool-call") {
              const toolName = chunk.payload?.toolName;
              if (typeof toolName !== "string" || toolName.length === 0) {
                continue;
              }

              const pendingCall: PendingToolCall = {
                name: toolName,
                args: (chunk.payload?.args as Record<string, unknown>) || {},
                toolCallId:
                  typeof chunk.payload?.toolCallId === "string"
                    ? (chunk.payload.toolCallId as string)
                    : undefined,
              };

              streamedPendingToolCalls.push(pendingCall);
              if (pendingCall.toolCallId) {
                streamedToolCallArgs.set(
                  pendingCall.toolCallId,
                  pendingCall.args || {},
                );
              } else {
                streamedAnonymousToolCallArgs.push({
                  toolName,
                  args: pendingCall.args || {},
                  consumed: false,
                });
              }
              const persistedActionKey = getPersistedStreamToolActionKey(
                "tool_call",
                toolName,
                pendingCall.toolCallId,
                pendingCall.args || {},
              );
              persistedStreamToolActionKeys.add(persistedActionKey);
              await persistToolEvent(
                "tool_call",
                {
                  name: toolName,
                  toolName,
                  args: pendingCall.args,
                  toolCallId: pendingCall.toolCallId,
                  status: "pending",
                },
                "waiting_tool",
              );

              const normalized = normalizeToolLifecycle(
                streamedPendingToolCalls,
                streamedExecutedToolResults,
              );

              // Anonymous calls sharing a signature are distinct invocations,
              // so track how many of each key were emitted instead of a boolean.
              const pendingCountsInSnapshot = new Map<string, number>();
              for (const call of normalized.pendingToolCalls) {
                const key = getPendingKey(call);
                const occurrence = (pendingCountsInSnapshot.get(key) || 0) + 1;
                pendingCountsInSnapshot.set(key, occurrence);
                if (occurrence <= (emittedPendingCounts.get(key) || 0)) continue;
                emittedPendingCounts.set(key, occurrence);
                if (call.toolCallId) {
                  emittedToolCallKeys.add(
                    getEmittedInvocationKey(
                      call.name,
                      call.toolCallId,
                      call.args || {},
                    ),
                  );
                }
                writeEvent("tool_call", {
                  name: call.name,
                  args: call.args,
                  toolCallId:
                    typeof call.toolCallId === "string"
                      ? call.toolCallId
                      : undefined,
                  status: "pending",
                });
              }
              continue;
            }

            if (chunk.type === "tool-result") {
              const toolName = chunk.payload?.toolName;
              if (typeof toolName !== "string" || toolName.length === 0) {
                continue;
              }

              const toolResult =
                chunk.payload?.result ??
                chunk.payload?.output ??
                chunk.payload?.content ??
                chunk.payload?.data;
              const safeToolResult = redactToolResult(toolResult).result;
              const toolCallId =
                typeof chunk.payload?.toolCallId === "string"
                  ? (chunk.payload.toolCallId as string)
                  : undefined;
              const resultArgs = resolveStreamToolResultArgs(
                toolName,
                toolCallId,
                chunk.payload?.args,
              );

              console.log("[DIFF-TRACE] API raw tool result", {
                toolName,
                toolCallId: chunk.payload?.toolCallId,
                resultType: typeof toolResult,
                resultKeys:
                  toolResult && typeof toolResult === "object"
                    ? Object.keys(toolResult as Record<string, unknown>)
                    : [],
              });

              streamedExecutedToolResults.push({
                name: toolName,
                args: resultArgs,
                result: safeToolResult,
                toolCallId,
              });

              const emittedInvocationKey = getEmittedInvocationKey(
                toolName,
                toolCallId,
                resultArgs,
              );
              if (toolCallId && !emittedToolCallKeys.has(emittedInvocationKey)) {
                emittedToolCallKeys.add(emittedInvocationKey);
                writeEvent("tool_call", {
                  name: toolName,
                  args: resultArgs,
                  toolCallId,
                  status: "pending",
                });
              }

              writeEvent("tool_result", {
                name: toolName,
                args: resultArgs,
                result: safeToolResult,
                toolCallId,
                status: resolveToolExecutionStatus(safeToolResult),
              });
              const persistedResultActionKey = getPersistedStreamToolActionKey(
                "tool_result",
                toolName,
                toolCallId,
                resultArgs,
              );
              persistedStreamToolActionKeys.add(persistedResultActionKey);
              await persistToolEvent(
                "tool_result",
                {
                  name: toolName,
                  toolName,
                  args: resultArgs,
                  result: safeToolResult,
                  toolCallId,
                  status: resolveToolExecutionStatus(safeToolResult),
                },
                "running",
              );

              continue;
            }

            if (
              chunk.type === "tool-suspended" ||
              chunk.type === "tool_suspended"
            ) {
              const toolName = chunk.payload?.toolName;
              if (typeof toolName !== "string" || toolName.length === 0) {
                continue;
              }

              const suspended: SuspendedToolCall = {
                name: toolName,
                toolCallId:
                  typeof chunk.payload?.toolCallId === "string"
                    ? (chunk.payload.toolCallId as string)
                    : undefined,
                suspendPayload:
                  chunk.payload?.suspendPayload &&
                    typeof chunk.payload.suspendPayload === "object"
                    ? (chunk.payload.suspendPayload as Record<string, unknown>)
                    : undefined,
              };

              streamedSuspendedTools.push(suspended);

              writeEvent("tool_suspended", {
                name: suspended.name,
                toolCallId: suspended.toolCallId,
                suspendPayload: suspended.suspendPayload,
              });

              void safePersistRunLifecycleEvent({
                runId: resolvedRunId,
                lifecycleState: "waiting_user_input",
                stopReason: "awaiting_user_input",
                eventType: "tool_suspended",
                payload: {
                  toolName: suspended.name,
                  toolCallId: suspended.toolCallId,
                },
              });
            }
          }

          const finalTextOrCancellation = await waitForResultOrCancellation(
            streamResult.text,
          );
          if (isCancelledWaitResult(finalTextOrCancellation)) {
            await transitionToCancelled("before_stream_final_text");
            writeEvent("lifecycle", {
              runId: resolvedRunId,
              lifecycleState,
              stopReason,
            });
            writeEvent("done", {
              success: false,
              runId: resolvedRunId,
              lifecycleState,
              stopReason,
              cancelled: true,
              response: "Run cancelled",
              toolCalls: [],
              executedToolResults: [],
              suspendedTools: streamedSuspendedTools,
              thoughtSteps:
                thoughtBuffer.length > 0 ? [thoughtBuffer.join("")] : [],
              model: modelId,
              autoFixAttempted: false,
              autoFixFailureCount: 0,
              maxStepsReached: false,
              stepsUsed: 0,
              maxSteps,
            });
            stopKeepAlive();
            res.end();
            return;
          }
          const finalText = finalTextOrCancellation;
          const streamedToolCallsOrCancellation =
            await waitForResultOrCancellation(streamResult.toolCalls);
          if (isCancelledWaitResult(streamedToolCallsOrCancellation)) {
            await transitionToCancelled("before_stream_tool_calls");
            writeEvent("lifecycle", {
              runId: resolvedRunId,
              lifecycleState,
              stopReason,
            });
            writeEvent("done", {
              success: false,
              runId: resolvedRunId,
              lifecycleState,
              stopReason,
              cancelled: true,
              response: "Run cancelled",
              toolCalls: [],
              executedToolResults: [],
              suspendedTools: streamedSuspendedTools,
              thoughtSteps:
                thoughtBuffer.length > 0 ? [thoughtBuffer.join("")] : [],
              model: modelId,
              autoFixAttempted: false,
              autoFixFailureCount: 0,
              maxStepsReached: false,
              stepsUsed: 0,
              maxSteps,
            });
            stopKeepAlive();
            res.end();
            return;
          }
          const streamedToolCalls = streamedToolCallsOrCancellation;
          const streamStepsOrCancellation = await waitForResultOrCancellation(
            Promise.resolve(
              (
                streamResult as unknown as {
                  steps?: Promise<StreamStep[]>;
                }
              ).steps,
            ).catch(() => undefined),
          );
          if (isCancelledWaitResult(streamStepsOrCancellation)) {
            await transitionToCancelled("before_stream_steps");
            writeEvent("lifecycle", {
              runId: resolvedRunId,
              lifecycleState,
              stopReason,
            });
            writeEvent("done", {
              success: false,
              runId: resolvedRunId,
              lifecycleState,
              stopReason,
              cancelled: true,
              response: "Run cancelled",
              toolCalls: [],
              executedToolResults: [],
              suspendedTools: streamedSuspendedTools,
              thoughtSteps:
                thoughtBuffer.length > 0 ? [thoughtBuffer.join("")] : [],
              model: modelId,
              autoFixAttempted: false,
              autoFixFailureCount: 0,
              maxStepsReached: false,
              stepsUsed: 0,
              maxSteps,
            });
            stopKeepAlive();
            res.end();
            return;
          }
          const streamSteps = streamStepsOrCancellation;
          const streamStepsUsed = Array.isArray(streamSteps)
            ? streamSteps.length
            : 0;
          const streamToolCallsFromSteps = Array.isArray(streamSteps)
            ? streamSteps.reduce(
              (total, step) =>
                total +
                (Array.isArray(step.toolCalls) ? step.toolCalls.length : 0),
              0,
            )
            : undefined;
          const streamLastStep = Array.isArray(streamSteps)
            ? streamSteps[streamSteps.length - 1]
            : undefined;
          const streamLastStepHadToolCalls =
            Array.isArray(streamLastStep?.toolCalls) &&
            streamLastStep.toolCalls.length > 0;
          const streamUsageRawOrCancellation = await waitForResultOrCancellation(
            Promise.resolve(
              (streamResult as unknown as { usage?: unknown }).usage,
            ).catch(() => undefined),
          );
          if (isCancelledWaitResult(streamUsageRawOrCancellation)) {
            await transitionToCancelled("before_stream_usage");
            writeEvent("lifecycle", {
              runId: resolvedRunId,
              lifecycleState,
              stopReason,
            });
            writeEvent("done", {
              success: false,
              runId: resolvedRunId,
              lifecycleState,
              stopReason,
              cancelled: true,
              response: "Run cancelled",
              toolCalls: [],
              executedToolResults: [],
              suspendedTools: streamedSuspendedTools,
              thoughtSteps:
                thoughtBuffer.length > 0 ? [thoughtBuffer.join("")] : [],
              model: modelId,
              autoFixAttempted: false,
              autoFixFailureCount: 0,
              maxStepsReached: false,
              stepsUsed: 0,
              maxSteps,
            });
            stopKeepAlive();
            res.end();
            return;
          }
          const streamUsageFromResult = normalizeTokenUsage(
            streamUsageRawOrCancellation,
          );
          const streamUsageSeenInFinal = Boolean(streamUsageFromResult);
          streamTokenUsage = mergeTokenUsage(
            streamTokenUsage,
            streamUsageFromResult,
          );
          const streamUsageSource: "final" | "stream" | "none" =
            streamUsageSeenInFinal
              ? "final"
              : streamUsageSeenInChunks
                ? "stream"
                : "none";
          logTokenUsageSource({
            mode: "stream",
            source: streamUsageSource,
            usage: streamTokenUsage,
            modelId,
          });
          const typedStreamedToolCalls =
            (streamedToolCalls || []) as Array<{
              toolName?: string;
              args?: Record<string, unknown>;
              toolCallId?: string;
            }>;
          const mappedToolCalls: PendingToolCall[] = typedStreamedToolCalls.reduce(
            (
              calls: PendingToolCall[],
              call: {
                toolName?: string;
                args?: Record<string, unknown>;
                toolCallId?: string;
              },
            ) => {
              const toolName = call?.toolName;
              if (typeof toolName !== "string" || toolName.length === 0) {
                return calls;
              }

              calls.push({
                name: toolName,
                args: call.args || {},
                toolCallId:
                  typeof call.toolCallId === "string"
                    ? call.toolCallId
                    : undefined,
              });

              return calls;
            },
            [],
          );

          const processedStreamToolResults = Array.isArray(streamSteps)
            ? extractProcessedToolResults(streamSteps)
            : [];
          const toolResultMetadata = new Map(
            [...streamedExecutedToolResults, ...processedStreamToolResults]
              .filter((entry) => entry.toolCallId)
              .map((entry) => [entry.toolCallId as string, entry]),
          );
          const bridgedStreamToolResults =
            agent
              .takeProcessedWorkspaceResults?.(
                workspaceMutationGenerationId,
                Array.from(toolResultMetadata.keys()),
              )
              .map(({ toolCallId, result }) => {
                const metadata = toolResultMetadata.get(toolCallId);
                return {
                  name: metadata?.name || "workspaceMutation",
                  args: metadata?.args || {},
                  toolCallId,
                  result,
                };
              }) || [];
          const reconciledStreamLifecycleSnapshots =
            reconcileToolLifecycleSnapshots(
              streamedPendingToolCalls,
              mappedToolCalls,
              streamedExecutedToolResults,
              [...processedStreamToolResults, ...bridgedStreamToolResults],
            );
          const reconciledStreamToolResults =
            reconciledStreamLifecycleSnapshots.executedToolResults;
          console.log("[DIFF-TRACE] API reconciled tool results", {
            rawCount: streamedExecutedToolResults.length,
            processedCount: processedStreamToolResults.length,
            bridgedCount: bridgedStreamToolResults.length,
            resultKeys: reconciledStreamToolResults.map((entry) =>
              entry.result && typeof entry.result === "object"
                ? Object.keys(entry.result as Record<string, unknown>)
                : [],
            ),
          });
          const streamInputToolCalls =
            reconciledStreamLifecycleSnapshots.pendingToolCalls;
          console.log("DEBUG_STREAM_LIFECYCLE_INPUT", {
            streamedPendingCount: streamInputToolCalls.length,
            streamedPendingToolNames: streamInputToolCalls.map(
              (call) => call.name,
            ),
            reconciledResultCount: reconciledStreamToolResults.length,
            reconciledResultKeys: reconciledStreamToolResults.map((entry) =>
              entry.result && typeof entry.result === "object"
                ? Object.keys(entry.result as Record<string, unknown>)
                : [],
            ),
          });
          const normalizedStreamLifecycle = normalizeToolLifecycle(
            streamInputToolCalls,
            reconciledStreamToolResults,
          );
          let normalizedStreamToolCalls =
            normalizedStreamLifecycle.pendingToolCalls.map((call) => ({
              name: call.name,
              args: call.args,
              toolCallId: call.toolCallId,
              status: "pending" as ToolExecutionStatus,
            }));
          const normalizedStreamExecutedResults =
            normalizedStreamLifecycle.executedToolResults.map((toolResult) => ({
              name: toolResult.name,
              args: toolResult.args,
              result: toolResult.result,
              toolCallId: toolResult.toolCallId,
              status: resolveToolExecutionStatus(toolResult.result),
            }));
          const normalizedStreamToolCallsUsed = countUniqueToolCalls(
            streamInputToolCalls,
            reconciledStreamToolResults,
          );
          const streamToolCallsUsed =
            typeof streamToolCallsFromSteps === "number"
              ? Math.max(
                streamToolCallsFromSteps,
                normalizedStreamToolCallsUsed,
              )
              : normalizedStreamToolCallsUsed;
          const hasStreamToolActivity =
            normalizedStreamToolCalls.length > 0 ||
            normalizedStreamExecutedResults.length > 0 ||
            Array.isArray(streamSteps);
          const hasStreamPendingToolCalls =
            normalizedStreamToolCalls.length > 0;
          const hasStreamBudgetOverflow =
            streamToolCallsUsed > maxToolCalls ||
            toolCallBudget.stopReason === "repeated_call";
          const streamBudgetReached =
            hasStreamBudgetOverflow ||
            (streamToolCallsUsed >= maxToolCalls &&
              (hasStreamPendingToolCalls || streamLastStepHadToolCalls));
          console.log("DEBUG_STREAM_BUDGET", {
            streamToolCallsUsed,
            maxToolCalls,
            toolCallBudgetStopReason: toolCallBudget.stopReason,
            streamLastStepHadToolCalls,
            hasStreamToolActivity,
            pendingToolCallCount: normalizedStreamToolCalls.length,
            executedResultCount: normalizedStreamExecutedResults.length,
            streamBudgetReached,
            finalTextPresent:
              typeof finalText === "string" && finalText.trim().length > 0,
          });

          const streamPendingConfirmations =
            normalizedStreamExecutedResults.filter(
              (toolResult) =>
                resolveToolExecutionStatus(toolResult.result) ===
                "pending_confirmation",
            );

          let finalResponseText = finalText;
          let backendSynthesisPerformed = false;
          const streamEndedWithoutFinalText =
            typeof finalText !== "string" || finalText.trim().length === 0;
          const hasStreamTerminalToolResults = hasTerminalToolResults(
            normalizedStreamExecutedResults,
          );
          const hasStreamNonterminalToolResults = hasNonterminalToolResults(
            normalizedStreamExecutedResults,
          );
          const hasStreamResultSnapshots =
            normalizedStreamExecutedResults.length > 0;
          const shouldSynthesizeAfterCompletedToolWork =
            streamedSuspendedTools.length === 0 &&
            streamPendingConfirmations.length === 0 &&
            ((hasStreamPendingToolCalls &&
              !hasStreamNonterminalToolResults &&
              (hasStreamBudgetOverflow ||
                toolCallBudget.stopReason === "repeated_call" ||
                streamToolCallsUsed >= maxToolCalls)) ||
              (hasStreamTerminalToolResults &&
                streamEndedWithoutFinalText &&
                !hasStreamPendingToolCalls));
          if (shouldSynthesizeAfterCompletedToolWork) {
            const synthesisStopReason =
              streamBudgetReached ||
                toolCallBudget.stopReason === "repeated_call" ||
                streamToolCallsUsed >= maxToolCalls
                ? (toolCallBudget.stopReason ?? "limit")
                : "empty_final_response";
            const synthesisResultOrCancellation =
              await generateBackendOnlySynthesis(
                normalizedStreamExecutedResults,
                synthesisStopReason,
              );
            if (isCancelledWaitResult(synthesisResultOrCancellation)) {
              await transitionToCancelled("during_stream_backend_synthesis");
              writeEvent("lifecycle", {
                runId: resolvedRunId,
                lifecycleState,
                stopReason,
              });
              writeEvent("done", {
                success: false,
                runId: resolvedRunId,
                lifecycleState,
                stopReason,
                cancelled: true,
                response: "Run cancelled",
                toolCalls: [],
                executedToolResults: [],
                suspendedTools: streamedSuspendedTools,
                thoughtSteps:
                  thoughtBuffer.length > 0 ? [thoughtBuffer.join("")] : [],
                model: modelId,
                autoFixAttempted: false,
                autoFixFailureCount: 0,
                maxStepsReached: false,
                stepsUsed: 0,
                maxSteps,
              });
              stopKeepAlive();
              res.end();
              return;
            }
            const synthesisResult = synthesisResultOrCancellation;
            const synthesizedText =
              typeof synthesisResult.text === "string" &&
                synthesisResult.text.trim().length > 0
                ? synthesisResult.text
                : null;
            if (!synthesizedText && streamEndedWithoutFinalText) {
              throw new Error(
                "The agent completed its tool work but returned no final response.",
              );
            }
            if (synthesizedText) {
              finalResponseText = synthesizedText;
              normalizedStreamToolCalls = [];
              backendSynthesisPerformed = true;
            }
            streamTokenUsage = mergeTokenUsage(
              streamTokenUsage,
              normalizeTokenUsage(synthesisResult.usage),
            );
          }

          let streamLifecycleState: RunLifecycleState = "succeeded";
          let streamStopReason: RunStopReason = "completed";
          if (streamedSuspendedTools.length > 0) {
            streamLifecycleState = "waiting_user_input";
            streamStopReason = "awaiting_user_input";
          } else if (streamPendingConfirmations.length > 0) {
            streamLifecycleState = "waiting_confirmation";
            streamStopReason = "awaiting_approval";
          } else if (normalizedStreamToolCalls.length > 0) {
            streamLifecycleState = "waiting_tool";
            streamStopReason = "none";
          } else if (streamBudgetReached && !backendSynthesisPerformed) {
            streamLifecycleState = "paused";
            streamStopReason = "max_steps_reached";
          }

          const finalStreamReplayActions = buildOrderedPersistedToolActions(
            streamSteps,
            streamInputToolCalls.map((call) => ({
              name: call.name,
              args: call.args,
              toolCallId: call.toolCallId,
              status: "pending" as ToolExecutionStatus,
            })),
            normalizedStreamExecutedResults,
            (toolName, args) =>
              sanitizeToolArgsForWorkspace(toolName, args, isWebWorkspace),
          );
          for (const action of finalStreamReplayActions) {
            const persistedActionKey = getPersistedStreamToolActionKey(
              action.eventType,
              action.name,
              action.toolCallId,
              action.args,
            );
            if (persistedStreamToolActionKeys.has(persistedActionKey)) {
              continue;
            }

            persistedStreamToolActionKeys.add(persistedActionKey);
            await persistToolEvent(
              action.eventType,
              {
                name: action.name,
                toolName: action.name,
                args: action.args,
                ...(action.eventType === "tool_result"
                  ? { result: action.result }
                  : {}),
                toolCallId: action.toolCallId,
                status: action.status,
              },
              "running",
            );
          }

          await persistLifecycle(
            streamLifecycleState,
            streamStopReason,
            "stream_completed",
            {
              pendingToolCalls: normalizedStreamToolCalls.length,
              suspendedTools: streamedSuspendedTools.length,
              pendingConfirmations: streamPendingConfirmations.length,
              stepsUsed: streamStepsUsed,
              toolCallsUsed: streamToolCallsUsed,
              budgetReached: streamBudgetReached,
              toolBudgetStopReason: toolCallBudget.stopReason,
            },
          );
          writeEvent("lifecycle", {
            runId: resolvedRunId,
            lifecycleState,
            stopReason,
          });

          writeEvent("done", {
            success: true,
            runId: resolvedRunId,
            lifecycleState,
            stopReason,
            response: finalResponseText,
            toolCalls: normalizedStreamToolCalls,
            executedToolResults: normalizedStreamExecutedResults,
            suspendedTools: streamedSuspendedTools,
            thoughtSteps:
              thoughtBuffer.length > 0 ? [thoughtBuffer.join("")] : [],
            model: modelId,
            autoFixAttempted: false,
            autoFixFailureCount: 0,
            maxStepsReached: streamBudgetReached && !backendSynthesisPerformed,
            stepsUsed: streamStepsUsed,
            maxSteps: maxSteps,
            toolCallsUsed: streamToolCallsUsed,
            maxToolCalls,
            usage: streamTokenUsage,
            ...(buildTokenUsageDebug({
              mode: "stream",
              source: streamUsageSource,
            })
              ? {
                tokenUsageDebug: buildTokenUsageDebug({
                  mode: "stream",
                  source: streamUsageSource,
                }),
              }
              : {}),
          });
          stopKeepAlive();
          res.end();
          return;
        } catch (streamError) {
          const { code, message: providerMessage } =
            extractProviderErrorDetails(streamError);
          await persistLifecycle("failed", "error", "stream_error", {
            message: providerMessage,
            code,
          });
          writeEvent("lifecycle", {
            runId: resolvedRunId,
            lifecycleState,
            stopReason,
          });
          writeEvent("error", {
            success: false,
            runId: resolvedRunId,
            lifecycleState,
            stopReason,
            errorCode: code,
            error: normalizeProviderRequestError(
              requestedModelId,
              providerMessage,
              code,
            ),
          });
          stopKeepAlive();
          res.end();
          return;
        } finally {
          agent.clearProcessedWorkspaceResults?.(workspaceMutationGenerationId);
        }
      }

      await persistLifecycle("running", "none", "model_request_started", {
        stream: false,
        maxSteps,
        maxOutputTokens,
      });

      if (await isCancelled()) {
        await transitionToCancelled("before_model_request");
        return res.status(409).json({
          success: false,
          runId: resolvedRunId,
          lifecycleState,
          stopReason,
          error: "Run was cancelled",
        });
      }

      let result: AgentGenerateResult;
      try {
        const resultOrCancellation = await waitForResultOrCancellation(
          activeHostSession
            ? generateWithSessionRetry(
              activeHostSession,
              modelInput,
              generateOptions,
              turnAbortController.signal,
              modelProfile.generateRetryAttempts,
            )
            : generateWithRetry(
              agent,
              modelInput,
              generateOptions,
              turnAbortController.signal,
              modelProfile.generateRetryAttempts,
            ),
        );
        if (isCancelledWaitResult(resultOrCancellation)) {
          await transitionToCancelled("during_model_request");
          return res.status(409).json({
            success: false,
            runId: resolvedRunId,
            lifecycleState,
            stopReason,
            error: "Run was cancelled",
          });
        }
        result = resultOrCancellation;
      } finally {
        agent.clearProcessedWorkspaceResults?.(workspaceMutationGenerationId);
      }

      if (await isCancelled()) {
        await transitionToCancelled("after_model_response");
        return res.status(409).json({
          success: false,
          runId: resolvedRunId,
          lifecycleState,
          stopReason,
          error: "Run was cancelled",
        });
      }

      await persistLifecycle("running", "none", "model_response_received", {
        stepsCount: result.steps?.length || 0,
        toolCallsCount: result.toolCalls?.length || 0,
      });

      let usageSummary = normalizeTokenUsage(result.usage);
      let usageSeenFromFinal = Boolean(usageSummary);

      console.log("=== AGENT RESULT ===");
      console.log("Text:", result.text);
      console.log("Steps:", result.steps?.length || 0);
      console.log("Tool calls:", result.toolCalls?.length || 0);

      // Truncate response if it's too long to prevent context overflow
      let responseText = result.text || "";
      if (responseText.length > 12000) {
        console.log(
          `⚠️ Truncating long response: ${responseText.length} chars -> 12000 chars`,
        );
        responseText = truncateEnvironmentResponse(responseText);
      }

      const toolCalls: PendingToolCall[] = [];
      const executedToolResults: ExecutedToolResult[] = []; // Track all tools that were executed
      const suspendedTools: SuspendedToolCall[] = [];
      const toolCallArgs = new Map<string, Record<string, unknown>>(); // Map to store tool call args by toolCallId
      const anonymousToolCallArgs: AnonymousToolCallArgs[] = [];
      const thoughtSteps: string[] = []; // Intermediate agent text steps for UI display

      // Check steps for tool execution details
      if (result.steps && result.steps.length > 0) {
        // Log all steps for debugging
        result.steps.forEach((step, index) => {
          console.log(`Step ${index}:`, JSON.stringify(step, null, 2));

          // Collect ALL executed tools from all steps (not just last step)
          if (step.content && Array.isArray(step.content)) {
            // Capture intermediate text/thought content emitted in step stream
            step.content.forEach((item) => {
              const maybeText = (item as { text?: unknown }).text;
              if (item.type === "text" && typeof maybeText === "string") {
                const text = maybeText.trim();
                if (text.length > 0) {
                  thoughtSteps.push(text);
                }
              }
            });

            // First pass: collect tool-call args
            step.content.forEach((item) => {
              if (item.type === "tool-call" && item.toolName) {
                const args = item.args || item.input || {};
                if (item.toolCallId) {
                  toolCallArgs.set(item.toolCallId, args);
                } else {
                  anonymousToolCallArgs.push({
                    toolName: item.toolName,
                    args,
                    consumed: false,
                  });
                }
              }
            });

            // Second pass: collect tool results with their args
            step.content.forEach((item) => {
              // Capture tool results (tools that were already executed)
              if (item.type === "tool-result" && item.toolName) {
                // Get args from the corresponding tool-call
                const args = resolveToolResultArgs(
                  item.toolName,
                  item.toolCallId,
                  item.args || item.input,
                  toolCallArgs,
                  anonymousToolCallArgs,
                );
                // Result can be in different properties depending on AI SDK version
                // Use 'in' operator to check property existence, not truthiness
                // Priority: result > output > content > data
                let toolResult: unknown;
                if ("result" in item) {
                  toolResult = item.result;
                } else if ("output" in item) {
                  toolResult = item.output;
                } else if ("content" in item && item.type === "tool-result") {
                  // Only use content if it's not the type discriminator
                  toolResult = item.content;
                } else if ("data" in item) {
                  toolResult = item.data;
                } else {
                  toolResult = undefined;
                }
                console.log(`  Tool result name: ${item.toolName}`);
                console.log(
                  "  Tool result raw item:",
                  JSON.stringify(item, null, 2),
                );
                console.log("  Tool result value:", toolResult);
                console.log("  Tool args:", args);
                const safeToolResult = redactToolResult(toolResult).result;
                executedToolResults.push({
                  name: item.toolName,
                  args: args,
                  result: safeToolResult,
                  toolCallId: item.toolCallId,
                  lifecycleStepIndex: index,
                });
              }

              if (
                (item.type === "tool-suspended" ||
                  item.type === "tool_suspended") &&
                item.toolName
              ) {
                let suspendPayload: Record<string, unknown> | undefined;
                if (
                  "suspendPayload" in item &&
                  item.suspendPayload &&
                  typeof item.suspendPayload === "object"
                ) {
                  suspendPayload = item.suspendPayload as Record<
                    string,
                    unknown
                  >;
                } else if (
                  "result" in item &&
                  item.result &&
                  typeof item.result === "object"
                ) {
                  suspendPayload = item.result as Record<string, unknown>;
                } else if (
                  "output" in item &&
                  item.output &&
                  typeof item.output === "object"
                ) {
                  suspendPayload = item.output as Record<string, unknown>;
                } else if (
                  "data" in item &&
                  item.data &&
                  typeof item.data === "object"
                ) {
                  suspendPayload = item.data as Record<string, unknown>;
                }

                suspendedTools.push({
                  name: item.toolName,
                  toolCallId: item.toolCallId,
                  suspendPayload,
                });
              }
            });
          }
        });

        // Only collect PENDING tool calls from the LAST step
        // If the agent executed tools in previous steps, we don't want to send them back to the client
        const lastStep = result.steps[result.steps.length - 1];

        // Tool calls are in the content array
        const lastStepCallCounts = new Map<string, number>();
        const lastStepCallKey = (
          name: string,
          args: Record<string, unknown>,
          toolCallId?: string,
        ): string =>
          toolCallId
            ? `id:${toolCallId}:${getToolCallSignature(name, args)}`
            : getToolCallSignature(name, args);

        if (lastStep.content && Array.isArray(lastStep.content)) {
          lastStep.content.forEach((item) => {
            if (item.type === "tool-call" && item.toolName) {
              console.log(
                `  Tool call: ${item.toolName}`,
                item.input || item.args,
              );

              const args = sanitizeToolArgsForWorkspace(
                item.toolName,
                item.input || item.args,
                isWebWorkspace,
              );

              const key = lastStepCallKey(item.toolName, args, item.toolCallId);
              lastStepCallCounts.set(
                key,
                (lastStepCallCounts.get(key) || 0) + 1,
              );

              toolCalls.push({
                name: item.toolName,
                args: args,
                toolCallId: item.toolCallId,
              });
            }
          });
        }

        // Fallback: Check toolCalls property. Track multiplicity per key so
        // repeated anonymous invocations are preserved while entries already
        // collected from `content` above are not double-counted.
        if (lastStep.toolCalls && lastStep.toolCalls.length > 0) {
          const fallbackCallCounts = new Map<string, number>();
          lastStep.toolCalls.forEach((call) => {
            // Only add if it has a valid toolName
            if (call && call.toolName) {
              const args = sanitizeToolArgsForWorkspace(
                call.toolName,
                call.args,
                isWebWorkspace,
              );

              const key = lastStepCallKey(call.toolName, args, call.toolCallId);
              const occurrence = (fallbackCallCounts.get(key) || 0) + 1;
              fallbackCallCounts.set(key, occurrence);
              if (occurrence <= (lastStepCallCounts.get(key) || 0)) {
                return;
              }

              console.log("  Tool call (fallback):", call.toolName, call.args);

              toolCalls.push({
                name: call.toolName,
                args: args,
                toolCallId: call.toolCallId,
              });
            }
          });
        }
      }

      // Fallback to top-level toolCalls if no steps
      if (
        toolCalls.length === 0 &&
        result.toolCalls &&
        result.toolCalls.length > 0
      ) {
        result.toolCalls.forEach((call) => {
          // Only add if it has a valid toolName
          if (call && call.toolName) {
            console.log("Direct tool call:", call.toolName, call.args);

            const args = sanitizeToolArgsForWorkspace(
              call.toolName,
              call.args,
              isWebWorkspace,
            );

            toolCalls.push({
              name: call.toolName,
              args: args,
              toolCallId: call.toolCallId,
            });
          }
        });
      }

      const normalizedLifecycle = normalizeToolLifecycle(
        toolCalls,
        executedToolResults,
      );
      let lifecycleToolCallsForCounting = toolCalls;
      let lifecycleResultsForCounting = executedToolResults;
      let normalizedToolCalls = normalizedLifecycle.pendingToolCalls.map(
        (call) => ({
          name: call.name,
          args: call.args,
          toolCallId: call.toolCallId,
          status: "pending" as ToolExecutionStatus,
        }),
      );
      const normalizedExecutedToolResults =
        normalizedLifecycle.executedToolResults.map((toolResult) => ({
          name: toolResult.name,
          args: toolResult.args,
          result: toolResult.result,
          toolCallId: toolResult.toolCallId,
          status: resolveToolExecutionStatus(toolResult.result),
        }));
      const replayToolActions = buildOrderedPersistedToolActions(
        result.steps,
        normalizedToolCalls,
        normalizedExecutedToolResults,
        (toolName, args) =>
          sanitizeToolArgsForWorkspace(toolName, args, isWebWorkspace),
      );
      const persistedReplayActions = new Set<PersistedToolAction>();
      const persistReplayToolActions = async (
        actions: PersistedToolAction[],
      ): Promise<void> => {
        for (const action of actions) {
          if (persistedReplayActions.has(action)) continue;
          persistedReplayActions.add(action);
          await persistToolEvent(action.eventType, {
            name: action.name,
            toolName: action.name,
            args: action.args,
            ...(action.eventType === "tool_result"
              ? { result: action.result }
              : {}),
            toolCallId: action.toolCallId,
            status: action.status,
          });
        }
      };
      await persistReplayToolActions(replayToolActions);

      const uniqueThoughtSteps = Array.from(
        new Set(
          thoughtSteps
            .map((t) => t.trim())
            .filter((t) => t.length > 0 && t !== responseText.trim()),
        ),
      );

      console.log("Final tool calls count:", normalizedToolCalls.length);
      console.log(
        "Executed tool results count:",
        normalizedExecutedToolResults.length,
      );
      console.log("Thought steps count:", uniqueThoughtSteps.length);

      // Check if any tool results are pending user confirmation
      let pendingConfirmations = normalizedExecutedToolResults.filter(
        (toolResult) =>
          resolveToolExecutionStatus(toolResult.result) ===
          "pending_confirmation",
      );
      let stepsCount = result.steps?.length || 0;
      let effectiveMaxSteps = maxSteps;
      let autoFixAttempted = false;
      let autoFixFailureCount = 0;
      let reflectionAttemptCount = 0;
      let reflectionStopReason: ReflectionStopReason = "none";
      let backendSynthesisPerformed = false;
      const countResultToolCalls = (
        generationResult: AgentGenerateResult,
      ): number =>
        generationResult.steps?.reduce(
          (total, step) =>
            total + (Array.isArray(step.toolCalls) ? step.toolCalls.length : 0),
          0,
        ) ??
        generationResult.toolCalls?.length ??
        0;
      let cumulativeToolCallsUsed = Math.max(
        toolCallBudget.admitted,
        countUniqueToolCalls(
          lifecycleToolCallsForCounting,
          lifecycleResultsForCounting,
        ),
        countResultToolCalls(result),
      );

      // Bounded reflection loop: target failed validation/tool execution with explicit retry context.
      if (
        isAutoFixValidationEnabled() &&
        pendingConfirmations.length === 0 &&
        normalizedToolCalls.length === 0
      ) {
        let reflectionAttempt = 0;
        const reflectionCap = modelProfile.reflectionMaxAttempts;
        const noProgressRepeatThreshold =
          getReflectionNoProgressRepeatThreshold();
        let previousFailureSignature: string | null = null;
        let repeatedFailureSignatures = 0;

        while (reflectionAttempt < reflectionCap) {
          if (await isCancelled()) {
            await transitionToCancelled("reflection_loop");
            return res.status(409).json({
              success: false,
              runId: resolvedRunId,
              lifecycleState,
              stopReason,
              error: "Run was cancelled",
            });
          }

          const validationFailures = extractValidationFailures(
            normalizedExecutedToolResults,
          );
          const toolFailures = extractToolExecutionFailures(
            normalizedExecutedToolResults,
          );
          const detectedFailureCount =
            validationFailures.length + toolFailures.length;
          autoFixFailureCount = Math.max(
            autoFixFailureCount,
            detectedFailureCount,
          );

          if (detectedFailureCount === 0) {
            reflectionStopReason = "resolved";
            break;
          }

          const remainingToolCalls = maxToolCalls - cumulativeToolCallsUsed;
          if (remainingToolCalls <= 0) {
            reflectionStopReason = "max_attempts";
            break;
          }

          const failureSignature = buildFailureSignature(
            validationFailures,
            toolFailures,
          );
          if (previousFailureSignature === failureSignature) {
            repeatedFailureSignatures += 1;
          } else {
            repeatedFailureSignatures = 0;
          }
          previousFailureSignature = failureSignature;

          if (repeatedFailureSignatures >= noProgressRepeatThreshold) {
            reflectionStopReason = "no_progress";
            console.warn(
              `[agent] reflection halted due to repeated failure signature (${repeatedFailureSignatures}/${noProgressRepeatThreshold})`,
            );
            break;
          }

          reflectionAttempt += 1;
          reflectionAttemptCount = reflectionAttempt;
          autoFixAttempted = true;

          const validationFailureReport = validationFailures
            .map((failure, index) => {
              const chunks = [
                `${index + 1}. ${failure.phase.toUpperCase()} failed`,
                failure.command ? `Command: ${failure.command}` : undefined,
                failure.error ? `Error: ${failure.error}` : undefined,
                failure.stderr ? `stderr:\n${failure.stderr}` : undefined,
                failure.stdout ? `stdout:\n${failure.stdout}` : undefined,
              ].filter(Boolean);

              return chunks.join("\n");
            })
            .join("\n\n");

          const toolFailureReport = toolFailures
            .map((failure, index) => {
              const chunks = [
                `${index + 1}. Tool \`${failure.toolName}\` failed`,
                `Status: ${failure.status}`,
                failure.error ? `Error: ${failure.error}` : undefined,
                failure.args
                  ? `Args: ${JSON.stringify(failure.args)}`
                  : undefined,
              ].filter(Boolean);
              return chunks.join("\n");
            })
            .join("\n\n");

          const autoFixPrompt = `${prompt}\n\nA prior attempt produced failures. Perform a targeted repair pass for attempt ${reflectionAttempt}/${reflectionCap}.\n\n${validationFailureReport
            ? `Validation failures:\n${validationFailureReport}\n\n`
            : ""
            }${toolFailureReport
              ? `Tool execution failures:\n${toolFailureReport}\n\n`
              : ""
            }Requirements:\n- Focus only on the listed failures.\n- If patch/tool matching failed, retry with tighter file targeting and explicit paths.\n- Keep edits minimal and reversible.\n- Stop after this repair pass.`;

          const autoFixOptions = {
            maxSteps: Math.min(
              modelProfile.reflectionMaxSteps,
              remainingToolCalls,
            ),
            maxOutputTokens,
            ...(mastraMemoryScope ? { memory: mastraMemoryScope } : {}),
            toolChoice: "auto" as const,
            toolCallConcurrency: 1,
            stopWhen: stopWhenToolBudgetReached,
            requestContext: agentRequestContext,
            abortSignal: turnAbortController.signal,
          };

          let autoFixResultOrCancellation:
            | AgentGenerateResult
            | CancelledDuringWait;
          const admittedBeforeReflection = toolCallBudget.admitted;
          try {
            autoFixResultOrCancellation = await waitForResultOrCancellation(
              activeHostSession
                ? generateWithSessionRetry(
                  activeHostSession,
                  autoFixPrompt,
                  autoFixOptions,
                  turnAbortController.signal,
                  modelProfile.reflectionRetryAttempts,
                )
                : generateWithRetry(
                  agent,
                  autoFixPrompt,
                  autoFixOptions,
                  turnAbortController.signal,
                  modelProfile.reflectionRetryAttempts,
                ),
            );
          } finally {
            agent.clearProcessedWorkspaceResults?.(
              workspaceMutationGenerationId,
            );
          }
          if (isCancelledWaitResult(autoFixResultOrCancellation)) {
            await transitionToCancelled("during_reflection_model_request");
            return res.status(409).json({
              success: false,
              runId: resolvedRunId,
              lifecycleState,
              stopReason,
              error: "Run was cancelled",
            });
          }
          const autoFixResult = autoFixResultOrCancellation;
          if (await isCancelled()) {
            await transitionToCancelled("after_reflection_response");
            return res.status(409).json({
              success: false,
              runId: resolvedRunId,
              lifecycleState,
              stopReason,
              error: "Run was cancelled",
            });
          }

          usageSummary = mergeTokenUsage(
            usageSummary,
            normalizeTokenUsage(autoFixResult.usage),
          );
          if (!usageSeenFromFinal && usageSummary) {
            usageSeenFromFinal = true;
          }

          let autoFixResponseText = autoFixResult.text || "";
          if (autoFixResponseText.length > 12000) {
            autoFixResponseText =
              truncateEnvironmentResponse(autoFixResponseText);
          }

          responseText = autoFixResponseText;

          const autoFixToolCalls: PendingToolCall[] = [];
          const autoFixExecutedToolResults: ExecutedToolResult[] = [];
          const autoFixToolCallArgs = new Map<
            string,
            Record<string, unknown>
          >();
          const autoFixAnonymousToolCallArgs: AnonymousToolCallArgs[] = [];
          const autoFixThoughtSteps: string[] = [];

          if (autoFixResult.steps && autoFixResult.steps.length > 0) {
            const lastStep =
              autoFixResult.steps[autoFixResult.steps.length - 1];

            autoFixResult.steps.forEach((step, index) => {
              if (!step.content || !Array.isArray(step.content)) return;

              step.content.forEach((item) => {
                const maybeText = (item as { text?: unknown }).text;
                if (item.type === "text" && typeof maybeText === "string") {
                  const text = maybeText.trim();
                  if (text.length > 0) {
                    autoFixThoughtSteps.push(text);
                  }
                }
              });

              step.content.forEach((item) => {
                if (item.type === "tool-call" && item.toolName) {
                  const args = sanitizeToolArgsForWorkspace(
                    item.toolName,
                    item.input || item.args,
                    isWebWorkspace,
                  );
                  if (item.toolCallId) {
                    autoFixToolCallArgs.set(item.toolCallId, args);
                  } else {
                    autoFixAnonymousToolCallArgs.push({
                      toolName: item.toolName,
                      args,
                      consumed: false,
                    });
                  }
                }
              });

              step.content.forEach((item) => {
                if (item.type === "tool-result" && item.toolName) {
                  const args = resolveToolResultArgs(
                    item.toolName,
                    item.toolCallId,
                    item.args || item.input,
                    autoFixToolCallArgs,
                    autoFixAnonymousToolCallArgs,
                  );
                  let toolResult: unknown;
                  if ("result" in item) {
                    toolResult = item.result;
                  } else if ("output" in item) {
                    toolResult = item.output;
                  } else if ("content" in item && item.type === "tool-result") {
                    toolResult = item.content;
                  } else if ("data" in item) {
                    toolResult = item.data;
                  }

                  const safeToolResult = redactToolResult(toolResult).result;
                  autoFixExecutedToolResults.push({
                    name: item.toolName,
                    args,
                    result: safeToolResult,
                    toolCallId: item.toolCallId,
                    lifecycleStepIndex: index,
                  });
                }
              });
            });

            if (lastStep.content && Array.isArray(lastStep.content)) {
              lastStep.content.forEach((item) => {
                if (item.type === "tool-call" && item.toolName) {
                  const args = sanitizeToolArgsForWorkspace(
                    item.toolName,
                    item.input || item.args,
                    isWebWorkspace,
                  );

                  autoFixToolCalls.push({
                    name: item.toolName,
                    args,
                    toolCallId: item.toolCallId,
                  });
                }
              });
            }
          }

          if (
            autoFixToolCalls.length === 0 &&
            autoFixResult.toolCalls &&
            autoFixResult.toolCalls.length > 0
          ) {
            autoFixResult.toolCalls.forEach((call) => {
              if (!call || !call.toolName) return;

              const args = sanitizeToolArgsForWorkspace(
                call.toolName,
                call.args,
                isWebWorkspace,
              );

              autoFixToolCalls.push({
                name: call.toolName,
                args,
                toolCallId: call.toolCallId,
              });
            });
          }

          const autoFixNormalizedLifecycle = normalizeToolLifecycle(
            autoFixToolCalls,
            autoFixExecutedToolResults,
          );

          const autoFixNormalizedToolCalls =
            autoFixNormalizedLifecycle.pendingToolCalls.map((call) => ({
              name: call.name,
              args: redactToolResult(call.args).result as Record<
                string,
                unknown
              >,
              toolCallId: call.toolCallId,
              status: "pending" as ToolExecutionStatus,
            }));

          const autoFixNormalizedExecutedResults =
            autoFixNormalizedLifecycle.executedToolResults.map(
              (toolResult) => ({
                name: toolResult.name,
                args: redactToolResult(toolResult.args).result as Record<
                  string,
                  unknown
                >,
                result: toolResult.result,
                toolCallId: toolResult.toolCallId,
                status: resolveToolExecutionStatus(toolResult.result),
              }),
            );

          const reflectionToolCallsUsed = countUniqueToolCalls(
            autoFixToolCalls,
            autoFixExecutedToolResults,
          );
          const admissionDelta =
            toolCallBudget.admitted - admittedBeforeReflection;
          cumulativeToolCallsUsed +=
            admissionDelta > 0 ? admissionDelta : reflectionToolCallsUsed;

          const uniqueAutoFixThoughtSteps = Array.from(
            new Set(
              autoFixThoughtSteps
                .map((t) => t.trim())
                .filter((t) => t.length > 0 && t !== responseText.trim()),
            ),
          );

          const autoFixReplayActions = buildOrderedPersistedToolActions(
            autoFixResult.steps,
            autoFixNormalizedToolCalls,
            autoFixNormalizedExecutedResults,
            (toolName, args) =>
              sanitizeToolArgsForWorkspace(toolName, args, isWebWorkspace),
          );
          replayToolActions.push(...autoFixReplayActions);
          await persistReplayToolActions(autoFixReplayActions);
          normalizedToolCalls.length = 0;
          normalizedToolCalls.push(...autoFixNormalizedToolCalls);
          normalizedExecutedToolResults.length = 0;
          normalizedExecutedToolResults.push(
            ...autoFixNormalizedExecutedResults,
          );
          lifecycleToolCallsForCounting = autoFixToolCalls;
          lifecycleResultsForCounting = autoFixExecutedToolResults;
          uniqueThoughtSteps.length = 0;
          uniqueThoughtSteps.push(...uniqueAutoFixThoughtSteps);

          pendingConfirmations = normalizedExecutedToolResults.filter(
            (toolResult) =>
              resolveToolExecutionStatus(toolResult.result) ===
              "pending_confirmation",
          );
          stepsCount = autoFixResult.steps?.length || 0;
          effectiveMaxSteps = autoFixOptions.maxSteps;

          if (
            pendingConfirmations.length > 0 ||
            normalizedToolCalls.length > 0
          ) {
            break;
          }
        }

        if (autoFixAttempted && reflectionStopReason === "none") {
          const remainingValidationFailures = extractValidationFailures(
            normalizedExecutedToolResults,
          );
          const remainingToolFailures = extractToolExecutionFailures(
            normalizedExecutedToolResults,
          );
          reflectionStopReason =
            remainingValidationFailures.length +
              remainingToolFailures.length ===
              0
              ? "resolved"
              : "max_attempts";
        }
      }

      const gitSafety: GitSafetyMetadata = {
        enabled: gitSafetyMode !== "off",
        gitDetected,
        policyMode: gitSafetyMode,
      };

      await persistReplayToolActions(replayToolActions);

      logTokenUsageSource({
        mode: "non_stream",
        source: usageSeenFromFinal ? "final" : "none",
        usage: usageSummary,
        modelId,
      });
      const nonStreamUsageSource: "final" | "none" = usageSeenFromFinal
        ? "final"
        : "none";
      const nonStreamTokenUsageDebug = buildTokenUsageDebug({
        mode: "non_stream",
        source: nonStreamUsageSource,
      });

      if (
        gitDetected &&
        gitSafetyMode !== "off" &&
        hasSuccessfulEditExecution(normalizedExecutedToolResults)
      ) {
        gitSafety.checkpointHint =
          'Create a checkpoint commit: git add -A && git commit -m "checkpoint: agent changes"';
        gitSafety.undoHint =
          "Undo unstaged edits safely: git restore -- <file>; inspect with git diff first.";
      }

      if (pendingConfirmations.length > 0) {
        await persistLifecycle(
          "waiting_confirmation",
          "awaiting_approval",
          "awaiting_confirmation",
          {
            pendingConfirmations: pendingConfirmations.length,
          },
        );
        // Return special response for command confirmation
        return res.json({
          success: true,
          runId: resolvedRunId,
          lifecycleState,
          stopReason,
          requiresConfirmation: true,
          autoFixAttempted,
          autoFixFailureCount,
          reflectionAttemptCount,
          reflectionStopReason,
          gitSafety,
          usage: usageSummary,
          ...(nonStreamTokenUsageDebug
            ? { tokenUsageDebug: nonStreamTokenUsageDebug }
            : {}),
          pendingConfirmations: pendingConfirmations.map((tool) => {
            const resultPayload = getToolResultPayload(tool.result) || {};
            return {
              confirmationId:
                typeof resultPayload.confirmationId === "string"
                  ? resultPayload.confirmationId
                  : undefined,
              command:
                typeof resultPayload.command === "string"
                  ? resultPayload.command
                  : undefined,
              action:
                typeof resultPayload.action === "string"
                  ? resultPayload.action
                  : undefined,
              target:
                typeof resultPayload.target === "string"
                  ? resultPayload.target
                  : undefined,
              toolName: tool.name,
              toolArgs: tool.args,
            };
          }),
          response:
            "The following commands require your approval before execution:",
        });
      }

      if (suspendedTools.length > 0) {
        const primarySuspension = suspendedTools[0];
        const payload = primarySuspension.suspendPayload || {};
        const question =
          typeof payload.question === "string" &&
            payload.question.trim().length > 0
            ? payload.question
            : typeof payload.prompt === "string" &&
              payload.prompt.trim().length > 0
              ? payload.prompt
              : primarySuspension.name === "submit_plan"
                ? "A plan requires your review. Please approve, reject, or provide feedback."
                : "Additional input is required to continue. Please provide your response.";

        await persistLifecycle(
          "waiting_user_input",
          "awaiting_user_input",
          "awaiting_user_input",
          {
            suspendedTools: suspendedTools.length,
          },
        );

        return res.json({
          success: true,
          runId: resolvedRunId,
          lifecycleState,
          stopReason,
          response: question,
          waitingForUserInput: true,
          suspendedTools,
          toolCalls: [],
          executedToolResults: normalizedExecutedToolResults,
          thoughtSteps: uniqueThoughtSteps,
          model: modelId,
          autoFixAttempted,
          autoFixFailureCount,
          reflectionAttemptCount,
          reflectionStopReason,
          gitSafety,
          usage: usageSummary,
          ...(nonStreamTokenUsageDebug
            ? { tokenUsageDebug: nonStreamTokenUsageDebug }
            : {}),
          maxStepsReached: false,
          stepsUsed: stepsCount,
          maxSteps: effectiveMaxSteps,
        });
      }

      const toolCallsUsed = Math.max(
        cumulativeToolCallsUsed,
        countUniqueToolCalls(
          lifecycleToolCallsForCounting,
          lifecycleResultsForCounting,
        ),
      );

      const endedWithoutFinalText =
        typeof responseText !== "string" || responseText.trim().length === 0;
      const hasPendingToolCalls = normalizedToolCalls.length > 0;
      const hasTerminalExecutedToolResults = hasTerminalToolResults(
        normalizedExecutedToolResults,
      );
      const hasNonterminalExecutedToolResults = hasNonterminalToolResults(
        normalizedExecutedToolResults,
      );
      const budgetLimitReached =
        toolCallsUsed >= maxToolCalls ||
        toolCallBudget.stopReason === "repeated_call";
      const shouldSynthesizeAfterCompletedToolWork =
        pendingConfirmations.length === 0 &&
        ((hasPendingToolCalls &&
          !hasNonterminalExecutedToolResults &&
          budgetLimitReached) ||
          (hasTerminalExecutedToolResults &&
            endedWithoutFinalText &&
            !hasPendingToolCalls));
      if (shouldSynthesizeAfterCompletedToolWork) {
        const synthesisStopReason = budgetLimitReached
          ? (toolCallBudget.stopReason ?? "limit")
          : "empty_final_response";
        const synthesisResultOrCancellation = await generateBackendOnlySynthesis(
          normalizedExecutedToolResults,
          synthesisStopReason,
        );
        if (isCancelledWaitResult(synthesisResultOrCancellation)) {
          await transitionToCancelled("during_backend_synthesis");
          return res.status(409).json({
            success: false,
            runId: resolvedRunId,
            lifecycleState,
            stopReason,
            error: "Run was cancelled",
          });
        }
        const synthesisResult = synthesisResultOrCancellation;
        const synthesizedText =
          typeof synthesisResult.text === "string" &&
            synthesisResult.text.trim().length > 0
            ? synthesisResult.text
            : null;
        if (!synthesizedText && endedWithoutFinalText) {
          throw new Error(
            "The agent completed its tool work but returned no final response.",
          );
        }
        if (synthesizedText) {
          responseText = synthesizedText;
          normalizedToolCalls = [];
          backendSynthesisPerformed = true;
        }
        usageSummary = mergeTokenUsage(
          usageSummary,
          normalizeTokenUsage(synthesisResult.usage),
        );
      }

      const maxStepsReached =
        !backendSynthesisPerformed &&
        (toolCallsUsed >= maxToolCalls ||
          toolCallBudget.stopReason === "repeated_call") &&
        (endedWithoutFinalText || toolCallsUsed > 0);

      let completionState: RunLifecycleState = "succeeded";
      let completionStopReason: RunStopReason = "completed";
      if (normalizedToolCalls.length > 0) {
        completionState = "waiting_tool";
        completionStopReason = maxStepsReached ? "max_steps_reached" : "none";
      } else if (reflectionStopReason !== "none") {
        completionStopReason =
          toRunStopReasonFromReflection(reflectionStopReason);
      }

      await persistLifecycle(
        completionState,
        completionStopReason,
        "response_ready",
        {
          stepsUsed: stepsCount,
          toolCallsUsed,
          maxSteps: effectiveMaxSteps,
          pendingToolCalls: normalizedToolCalls.length,
          reflectionStopReason,
        },
      );

      console.log(
        `📊 Steps used: ${stepsCount}/${effectiveMaxSteps} - Max reached: ${maxStepsReached}`,
      );

      // ✅ FIX: Return the correct response object
      res.json({
        success: true,
        runId: resolvedRunId,
        lifecycleState,
        stopReason,
        response: responseText, // Use result.text, not aiResponse.content
        toolCalls: normalizedToolCalls, // Pending tool calls that need client execution
        executedToolResults: normalizedExecutedToolResults, // Tools that were already executed with results
        suspendedTools,
        thoughtSteps: uniqueThoughtSteps,
        model: modelId,
        autoFixAttempted,
        autoFixFailureCount,
        reflectionAttemptCount,
        reflectionStopReason,
        gitSafety,
        usage: usageSummary,
        ...(nonStreamTokenUsageDebug
          ? { tokenUsageDebug: nonStreamTokenUsageDebug }
          : {}),
        maxStepsReached: maxStepsReached, // Indicate if max steps was reached
        stepsUsed: stepsCount,
        toolCallsUsed,
        maxSteps: effectiveMaxSteps,
      });
    } catch (error) {
      const err = error as Error;
      console.error("❌ === AGENT ERROR ===");
      console.error("Error name:", err.name);
      console.error("Error message:", err.message);
      console.error("Error stack:", err.stack);
      console.error("Error details:", error);

      const { code, message: providerMessage } =
        extractProviderErrorDetails(error);
      if (activeRunId) {
        await safePersistRunLifecycleEvent({
          runId: activeRunId,
          lifecycleState: "failed",
          stopReason: "error",
          eventType: "route_error",
          payload: {
            message: providerMessage,
            code,
          },
        });
      }
      const message = providerMessage.toLowerCase();
      const isInsufficientQuota =
        code === "insufficient_quota" || message.includes("insufficient_quota");
      const isRateLimitError =
        code === "429" ||
        code?.toLowerCase().includes("rate_limit") ||
        message.includes("rate_limit") ||
        message.includes("rate limit") ||
        message.includes("rate-limited") ||
        message.includes("too many requests");

      if (isInsufficientQuota) {
        return res.status(429).json({
          success: false,
          runId: activeRunId,
          lifecycleState: "failed",
          stopReason: "error",
          error:
            "API quota exceeded. Please check your plan and billing details.",
          errorCode: "insufficient_quota",
        });
      }

      if (isRateLimitError) {
        return res.status(429).json({
          success: false,
          runId: activeRunId,
          lifecycleState: "failed",
          stopReason: "error",
          error: getRateLimitErrorMessage(requestedModelId),
          errorCode: "rate_limit_exceeded",
        });
      }

      res.status(500).json({
        success: false,
        runId: activeRunId,
        lifecycleState: "failed",
        stopReason: "error",
        error: normalizeProviderRequestError(
          requestedModelId,
          providerMessage,
          code,
        ),
        errorDetails:
          process.env.NODE_ENV === "development" ? err.stack : undefined,
      });
    } finally {
      try {
        if (activeHostSession) {
          await activeHostSession.disconnect();
        } else if (activeHostSessionManager) {
          await activeHostSessionManager.stopAll();
        }
      } catch (disconnectError) {
        const disconnectMessage = getErrorMessage(disconnectError);
        console.warn("[agent] failed to clean up host session:", disconnectMessage);
      }
    }
  },
);

router.get(
  "/runs/:runId",
  async (req: Request<{ runId: string }>, res: Response) => {
    const runId = req.params.runId?.trim();
    if (!runId || !isSafeRunId(runId)) {
      return res.status(400).json({ success: false, error: "Invalid run id" });
    }

    const snapshot = await getRunSnapshot(runId);
    if (!snapshot) {
      return res.status(404).json({ success: false, error: "Run not found" });
    }

    const parsePayload = (
      raw: string | null,
    ): Record<string, unknown> | null => {
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object"
          ? (parsed as Record<string, unknown>)
          : null;
      } catch {
        return null;
      }
    };

    return res.json({
      success: true,
      run: {
        runId: snapshot.run.run_id,
        lifecycleState: snapshot.run.status,
        stopReason: snapshot.run.stop_reason,
        objective: snapshot.run.objective,
        workspacePath: snapshot.run.workspace_path,
        modelId: snapshot.run.model_id,
        cancelRequested: Number(snapshot.run.cancel_requested || 0) === 1,
        cancelRequestedAt: snapshot.run.cancel_requested_at || null,
        createdAt: snapshot.run.created_at,
        updatedAt: snapshot.run.updated_at,
      },
      latestCheckpoint: snapshot.latestCheckpoint
        ? {
          sequence: snapshot.latestCheckpoint.sequence,
          lifecycleState: snapshot.latestCheckpoint.lifecycle_state,
          stopReason: snapshot.latestCheckpoint.stop_reason,
          eventType: snapshot.latestCheckpoint.event_type,
          payload: normalizeToolActionPayload(
            snapshot.latestCheckpoint.event_type,
            parsePayload(snapshot.latestCheckpoint.payload_json),
          ),
          createdAt: snapshot.latestCheckpoint.created_at,
        }
        : null,
    });
  },
);

router.get(
  "/runs/:runId/events",
  async (req: Request<{ runId: string }>, res: Response) => {
    const runId = req.params.runId?.trim();
    if (!runId || !isSafeRunId(runId)) {
      return res.status(400).json({ success: false, error: "Invalid run id" });
    }

    const afterSequence = parsePositiveIntQuery(
      req.query.afterSequence,
      0,
      0,
      10_000_000,
    );
    const limit = parsePositiveIntQuery(req.query.limit, 200, 1, 500);
    const events = await listRunEvents(runId, afterSequence, limit);

    const serialized = events.map((event) => {
      let payload: Record<string, unknown> | null = null;
      if (event.payload_json) {
        try {
          const parsed = JSON.parse(event.payload_json);
          payload =
            parsed && typeof parsed === "object"
              ? (parsed as Record<string, unknown>)
              : null;
        } catch {
          payload = null;
        }
      }

      return {
        runId: event.run_id,
        sequence: event.sequence,
        lifecycleState: event.lifecycle_state,
        stopReason: event.stop_reason,
        eventType: event.event_type,
        payload: normalizeToolActionPayload(event.event_type, payload),
        createdAt: event.created_at,
      };
    });

    return res.json({
      success: true,
      runId,
      afterSequence,
      count: serialized.length,
      events: serialized,
    });
  },
);

router.post(
  "/runs/:runId/cancel",
  async (req: Request<{ runId: string }>, res: Response) => {
    const runId = req.params.runId?.trim();
    if (!runId || !isSafeRunId(runId)) {
      return res.status(400).json({ success: false, error: "Invalid run id" });
    }

    const exists = await getRunSnapshot(runId);
    if (!exists) {
      return res.status(404).json({ success: false, error: "Run not found" });
    }

    const updated = await requestRunCancellation(runId);
    if (!updated) {
      return res
        .status(409)
        .json({ success: false, error: "Unable to request cancellation" });
    }

    const currentState = asRunLifecycleState(exists.run.status);
    await safePersistRunLifecycleEvent({
      runId,
      lifecycleState: currentState,
      stopReason: "cancelled",
      eventType: "cancel_requested",
      payload: {
        requestedAt: new Date().toISOString(),
      },
    });

    return res.json({
      success: true,
      runId,
      cancelRequested: true,
      lifecycleState: currentState,
      stopReason: "cancelled",
    });
  },
);

// POST /api/agent/command-confirmation - Handle user approval/skip for command execution
router.post(
  "/command-confirmation",
  async (
    req: Request<{}, {}, CommandConfirmationRequestBody>,
    res: Response,
  ) => {
    try {
      const { confirmationId, approved, toolArgs, workspaceRoot } = req.body;

      if (!confirmationId || typeof approved !== "boolean") {
        return res.status(400).json({
          error: "confirmationId and approved (boolean) are required",
        });
      }

      console.log(
        `📋 Command confirmation ${confirmationId}: ${approved ? "✅ Approved" : "❌ Skipped"
        }`,
      );

      if (!approved) {
        return res.json({
          success: true,
          skipped: true,
          output: "Command execution skipped by user",
        });
      }

      // User approved - execute the command
      // Import executeCommand function
      const { executeCommand } =
        await import("./core/agent/tools/executeCommand");

      // Execute with approval bypass (since user already approved)
      const result = await executeCommand({
        ...toolArgs,
        workspaceRoot:
          typeof workspaceRoot === "string" && workspaceRoot.trim().length > 0
            ? workspaceRoot
            : typeof toolArgs?.cwd === "string" &&
              toolArgs.cwd.trim().length > 0
              ? toolArgs.cwd
              : process.cwd(),
        skipConfirmation: true, // Flag to bypass confirmation check
      });

      res.json({
        success: true,
        approved: true,
        result,
      });
    } catch (error) {
      const err = error as Error;
      console.error("❌ Command execution error:", error);
      res.status(500).json({
        success: false,
        error: err.message || "Failed to execute command",
      });
    }
  },
);

registerFileRoutes(router, requireDesktopAuth);

registerSemanticRoutes(router);

registerLspDocumentRoutes(router, requireDesktopAuth);

registerLspSemanticDocumentRoutes(router, requireDesktopAuth);

registerLspHierarchyRoutes(router, requireDesktopAuth);

registerLspResolveRoutes(router, requireDesktopAuth);

registerLspPositionRoutes(router, requireDesktopAuth);

registerLspQueryRoutes(router, requireDesktopAuth);

// ── Desktop security helpers ────────────────────────────────────────────────

/** True only for IPv4/IPv6 loopback connections. */
function isLoopback(req: Request): boolean {
  const ip = req.socket.remoteAddress ?? "";
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

function hasDesktopAuth(req: Request): boolean {
  const token = process.env.IRIS_DESKTOP_TOKEN;

  if (!process.env.TAURI_BUNDLED || !token) {
    return false;
  }

  if (!isLoopback(req)) {
    return false;
  }

  const raw = req.headers["x-desktop-token"];
  const provided = Array.isArray(raw) ? raw[0] : raw;
  return Boolean(provided && provided === token);
}

/**
 * Reject with 403 unless ALL of:
 *   1. The server was started as a Tauri desktop sidecar (TAURI_BUNDLED=1)
 *   2. The request originates from the loopback interface
 *   3. The X-Desktop-Token header matches the per-launch secret
 *
 * This gates the mutable /keys endpoint so arbitrary web pages or local
 * processes cannot change API keys on behalf of the user.
 */
export function requireDesktopAuth(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (!hasDesktopAuth(req)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  next();
}

// ── API Key management ─────────────────────────────────────────────
// Allowed env vars that the frontend can set via this endpoint.
const ALLOWED_KEY_NAMES = new Set([
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENROUTER_BASE_URL",
  "OLLAMA_BASE_URL",
  "OLLAMA_API_KEY",
  "HF_TOKEN",
]);

// POST /api/agent/keys - Set API keys at runtime (desktop app only)
router.post("/keys", requireDesktopAuth, (req: Request, res: Response) => {
  const keys = req.body?.keys;
  if (!keys || typeof keys !== "object") {
    return res
      .status(400)
      .json({ success: false, error: "Missing keys object" });
  }

  const applied: string[] = [];

  for (const [name, value] of Object.entries(keys)) {
    if (!ALLOWED_KEY_NAMES.has(name)) continue;

    if (typeof value === "string") {
      const trimmedValue = value.trim();
      if (trimmedValue.length > 0) {
        process.env[name] = trimmedValue;
        applied.push(name);
        continue;
      }
    }

    if (
      value === "" ||
      value === null ||
      (typeof value === "string" && value.trim().length === 0)
    ) {
      delete process.env[name];
      applied.push(name);
    }
  }

  // Clear cached agents so they pick up the new keys on next request
  if (applied.length > 0) {
    agentCache.clear();
  }

  res.json({ success: true, applied });
});

// GET /api/agent/keys - Check which keys are configured (never returns values)
router.get("/keys", requireDesktopAuth, (_req: Request, res: Response) => {
  const status: Record<string, boolean> = {};
  for (const name of ALLOWED_KEY_NAMES) {
    status[name] = Boolean(process.env[name]?.trim());
  }

  res.json({ success: true, keys: status });
});

// GET /api/agent/keys/values - Return runtime key values (desktop app only)
router.get(
  "/keys/values",
  requireDesktopAuth,
  (_req: Request, res: Response) => {
    const keys: Record<string, string> = {};
    for (const name of ALLOWED_KEY_NAMES) {
      keys[name] = process.env[name]?.trim() || "";
    }

    res.json({ success: true, keys });
  },
);

router.get(
  "/chat-sessions/:sessionId",
  requireDesktopAuth,
  async (req: Request<{ sessionId: string }>, res: Response) => {
    const sessionId = req.params.sessionId?.trim();
    if (!sessionId || !isSafeSessionId(sessionId)) {
      return res
        .status(400)
        .json({ success: false, error: "Invalid session id" });
    }

    const sessionPath = getRemoteChatSessionPath(sessionId);

    try {
      const raw = await fs.readFile(sessionPath, "utf8");
      const parsed = JSON.parse(raw) as RemoteChatSessionBody;

      if (!Array.isArray(parsed?.messages)) {
        return res
          .status(404)
          .json({ success: false, error: "Session not found" });
      }

      return res.json({
        id: sessionId,
        title: typeof parsed.title === "string" ? parsed.title : undefined,
        createdAt:
          typeof parsed.createdAt === "number" ? parsed.createdAt : undefined,
        updatedAt:
          typeof parsed.updatedAt === "number" ? parsed.updatedAt : undefined,
        messages: parsed.messages,
      });
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        return res
          .status(404)
          .json({ success: false, error: "Session not found" });
      }

      return res
        .status(500)
        .json({ success: false, error: "Failed to read session" });
    }
  },
);

router.put(
  "/chat-sessions/:sessionId",
  requireDesktopAuth,
  async (
    req: Request<{ sessionId: string }, {}, RemoteChatSessionBody>,
    res: Response,
  ) => {
    const sessionId = req.params.sessionId?.trim();
    if (!sessionId || !isSafeSessionId(sessionId)) {
      return res
        .status(400)
        .json({ success: false, error: "Invalid session id" });
    }

    if (!Array.isArray(req.body?.messages)) {
      return res
        .status(400)
        .json({ success: false, error: "messages must be an array" });
    }

    const timestamp = Date.now();
    const payload: RemoteChatSessionBody = {
      id: sessionId,
      title: typeof req.body.title === "string" ? req.body.title : "New Chat",
      createdAt:
        typeof req.body.createdAt === "number" ? req.body.createdAt : timestamp,
      updatedAt:
        typeof req.body.updatedAt === "number" ? req.body.updatedAt : timestamp,
      messages: req.body.messages,
    };

    try {
      await fs.mkdir(REMOTE_CHAT_SESSIONS_DIR, { recursive: true });
      await fs.writeFile(
        getRemoteChatSessionPath(sessionId),
        JSON.stringify(payload, null, 2),
        "utf8",
      );

      return res.json({ success: true, syncedAt: timestamp });
    } catch {
      return res
        .status(500)
        .json({ success: false, error: "Failed to store session" });
    }
  },
);

router.delete(
  "/chat-sessions/:sessionId",
  requireDesktopAuth,
  async (req: Request<{ sessionId: string }>, res: Response) => {
    const sessionId = req.params.sessionId?.trim();
    if (!sessionId || !isSafeSessionId(sessionId)) {
      return res
        .status(400)
        .json({ success: false, error: "Invalid session id" });
    }

    try {
      const sessionPath = getRemoteChatSessionPath(sessionId);
      const rawSession = await fs.readFile(sessionPath, "utf8");
      const parsed = JSON.parse(rawSession) as RemoteChatSessionBody;
      const runIds = extractRunIdsFromRemoteSession(parsed);

      if (runIds.length > 0) {
        await deleteRunDataBatch(runIds);
      }

      await fs.unlink(sessionPath);
      return res.json({ success: true });
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        return res.json({ success: true });
      }

      if (error instanceof SyntaxError) {
        return res
          .status(500)
          .json({ success: false, error: "Failed to parse session" });
      }

      return res
        .status(500)
        .json({ success: false, error: "Failed to delete session" });
    }
  },
);

router.post(
  "/mcp/inspect",
  requireDesktopAuth,
  async (req: Request, res: Response) => {
    const serverList = sanitizeMcpServers([req.body?.server], 1);
    const server = serverList[0];

    if (!server) {
      return res
        .status(400)
        .json({ success: false, error: "Invalid MCP server configuration" });
    }

    try {
      const tools = await listMcpServerTools(server, process.cwd());
      return res.json({
        success: true,
        server: {
          id: server.id,
          name: server.name,
          command: server.command,
        },
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description || "",
        })),
        toolCount: tools.length,
      });
    } catch (error) {
      const err = error as Error;
      return res.status(500).json({
        success: false,
        error: err.message || "Failed to inspect MCP server",
      });
    }
  },
);

router.post(
  "/mcp/call",
  requireDesktopAuth,
  async (req: Request<{}, {}, McpCallRequestBody>, res: Response) => {
    console.log("🧩 === MCP TOOL CALL RECEIVED ===");
    console.log("Tool name:", req.body?.toolName);
    console.log("Args keys:", Object.keys(req.body?.args || {}));
    console.log("Workspace root:", req.body?.workspaceRoot);
    console.log("MCP servers:", req.body?.mcpServers);

    const toolName =
      typeof req.body?.toolName === "string" ? req.body.toolName.trim() : "";
    const args =
      req.body?.args &&
        typeof req.body.args === "object" &&
        !Array.isArray(req.body.args)
        ? req.body.args
        : {};
    const workspaceRoot = req.body?.workspaceRoot || process.cwd();
    const mcpServers = sanitizeMcpServers(req.body?.mcpServers);

    console.log("Sanitized MCP servers count:", mcpServers.length);

    if (!toolName.startsWith("mcp_")) {
      console.warn("⚠️ Invalid MCP tool name:", toolName);
      return res
        .status(400)
        .json({ success: false, error: "Invalid MCP tool name" });
    }

    if (mcpServers.length === 0) {
      console.warn("⚠️ No MCP servers configured");
      return res
        .status(400)
        .json({ success: false, error: "No MCP servers configured" });
    }

    try {
      console.log("🚀 Executing MCP tool:", toolName);
      const result = await executeMcpToolByKey(
        mcpServers,
        workspaceRoot,
        toolName,
        args,
      );
      console.log("✅ MCP tool execution result:", result);
      return res.json(result);
    } catch (error) {
      const err = error as Error;
      console.error("❌ MCP tool execution error:", err.message);
      console.error("Stack:", err.stack);
      return res.status(500).json({
        success: false,
        error: err.message || "Failed to execute MCP tool",
      });
    }
  },
);

router.get("/skills", async (_req: Request, res: Response) => {
  try {
    const { getSkillsList } = await loadAgentCoreModule();
    const skills = await getSkillsList();
    res.json({ success: true, skills });
  } catch {
    res.status(500).json({ success: false, error: "Failed to load skills" });
  }
});

// GET /api/agent/tools - List all available Language Model Tools (native + MCP)
router.get("/tools", async (req: Request, res: Response) => {
  try {
    const tools = await getAvailableTools();

    res.json({
      success: true,
      count: tools.length,
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        tags: tool.tags,
        inputSchema: tool.inputSchema,
      })),
    });
  } catch (error) {
    const err = error as Error;
    console.error("❌ Failed to list tools:", error);
    res.status(500).json({
      success: false,
      error: err.message || "Failed to list tools",
    });
  }
});

export default router;
