import { createCodingAgent as createMastraCodingAgent } from "@mastra/core/coding-agent";
import {
  webFetchTool as mastraWebFetchTool,
  webSearchTool as mastraWebSearchTool,
} from "@mastra/core/tools";
import { openai, createOpenAI } from "@ai-sdk/openai";
import { anthropic, createAnthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import fsNative from "fs";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { exec } from "child_process";
import { promisify } from "util";

// Skills are backend-owned assets. Always load from the canonical backend
// directory, regardless of whether this file runs from source or transpiled CJS.
export const getSkillsDir = (): string =>
  typeof __dirname === "string"
    ? path.resolve(__dirname, "..", "skills")
    : path.join(process.cwd(), "api", "core", "skills");
import { LibSQLStore, LibSQLVector } from "@mastra/libsql";
import { Memory } from "@mastra/memory";
import {
  DEFAULT_LOCAL_RUNTIME_BASE_URL,
  DEFAULT_LOCAL_RUNTIME_API_KEY,
  isLocalModelId,
} from "../library/localRuntime";

// MY TOOLS
import readFileTool from "./tools/readFile";
import searchFilesTool from "./tools/searchFiles";
import writeFileTool from "./tools/writeFile";
import editFileTool from "./tools/editFile";
import listDirectoryTool from "./tools/listDirectory";
import grepSearchTool from "./tools/grepSearch";
import runTerminalCommandTool from "./tools/runTerminalCommand";
import deleteFileTool from "./tools/deleteFile";
import createDirectoryTool from "./tools/createDirectory";
import renameFileTool from "./tools/renameFile";
import getWorkspaceInfoTool from "./tools/getWorkspaceInfo";
import getSymbolsTool from "./tools/getSymbols";
import applyDiffTool from "./tools/applyDiff";
import findFileContentTool from "./tools/fileContent";
import queryKnowledgeGraphTool from "./tools/queryKnowledgeGraph";
// LSP-based tools for code intelligence
import getTypeInfoTool from "./tools/getTypeInfo";
import findDefinitionTool from "./tools/findDefinition";
import findReferencesTool from "./tools/findReferences";
import getSymbolsLSPTool from "./tools/getSymbolsLSP";
import getCodeCompletionTool from "./tools/getCodeCompletion";
import getSignatureHelpTool from "./tools/getSignatureHelp";
import getCodeActionsTool from "./tools/getCodeActions";
import renameSymbolTool from "./tools/renameSymbol";
import formatDocumentTool from "./tools/formatDocument";
import getWorkspaceSymbolsTool from "./tools/getWorkspaceSymbols";
import {
  taskListTool,
  taskOutputTool,
  taskStopTool,
} from "./tools/backgroundTasks";
// Code context tool for VS Code Copilot-style responses
import getCodeContextTool from "./tools/getCodeContext";
import {
  StreamErrorRetryProcessor,
} from "@mastra/core/processors";
import { MultimodalTokenLimiterProcessor } from "./utils/multimodalTokenLimiter";
import { coreLsp } from "../library/lsp/coreLsp";
import { executeToolWithRecovery } from "./utils/errorRecovery";
import {
  loadSkillsFromDirectories,
  type SkillEntry,
} from "./utils/skillsDiscovery";
import { resolveModelInputTokenLimit, resolveModelSupportsVision } from "../../helpers/promptBudget";
// Browser-backed fallback for providers without native web search.
import { webSearchTool as browserWebSearchTool } from "./tools/webSearch";
//for skills to be called by the workspace
import {
  Workspace,
  LocalFilesystem,
  WORKSPACE_TOOLS,
  type WorkspaceToolHooks,
} from "@mastra/core/workspace";
import { RequestContext } from "@mastra/core/request-context";
import type { McpServerConfig } from "../library/mcpSettings";
import type { TerminalAutoApproveRules } from "../library/terminalAutoApproveSettings";
import { buildMcpTools, generateMcpToolsDocs } from "./tools/mcpTools";
import {
  enforceToolCallBudgetForTools,
  type ToolCallBudget,
} from "./utils/toolCallBudget";
import { resolveOpenRouterModelSettings } from "./utils/openRouterModelSettings";
import { ToolResultSafetyProcessor } from "./utils/toolResultSafetyProcessor";
import { CapturedWorkspaceMutationBridge } from "./utils/capturedWorkspaceMutationBridge";
import { rejectUnsafeWorkspaceMutation } from "./utils/workspacePathGuard";

export const createIrisWorkspaceToolsConfig = (hooks?: WorkspaceToolHooks) => ({
  ...(hooks ? { hooks } : {}),
  [WORKSPACE_TOOLS.FILESYSTEM.READ_FILE]: { name: "readFile" },
  [WORKSPACE_TOOLS.FILESYSTEM.LIST_FILES]: { name: "listDirectory" },
  [WORKSPACE_TOOLS.FILESYSTEM.FILE_STAT]: { name: "fileStat" },
  [WORKSPACE_TOOLS.FILESYSTEM.GREP]: { name: "grepSearch" },
  // Keep native mutations disabled: their string results omit the rich diff
  // contract. AIRIS writeFile/editFile are registered on the agent below.
  [WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE]: { enabled: false },
  [WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE]: {
    enabled: false,
  },
  [WORKSPACE_TOOLS.FILESYSTEM.DELETE]: { name: "deleteFile" },
  [WORKSPACE_TOOLS.FILESYSTEM.MKDIR]: { name: "createDirectory" },
  [WORKSPACE_TOOLS.FILESYSTEM.AST_EDIT]: { enabled: false },
  [WORKSPACE_TOOLS.SEARCH.SEARCH]: { name: "workspaceSearch" },
});

type AgentFactoryOptions = {
  id?: string;
  name?: string;
  enableMemory?: boolean;
  goalJudgeModelId?: string;
  goalMaxRuns?: number;
  useMastraObservationalMemory?: boolean;
  observationalMemorySettings?: {
    model?: string;
    scope?: "resource" | "thread";
    observationMessageTokens?: number;
    reflectionObservationTokens?: number;
    observationPreviousTokens?: number;
    activateAfterIdle?: string;
    activateOnProviderChange?: boolean;
  };
  storageId?: string;
  dbUrl?: string;
  vectorId?: string;
  maxSteps?: number;
  toolChoice?: "auto" | "none" | "required";
  defaultOptions?: Record<string, unknown>;
  mcpServers?: McpServerConfig[];
  terminalAutoApproveRules?: TerminalAutoApproveRules;
  streamErrorRetry?: {
    enabled?: boolean;
    maxRetries?: number;
    retryUnknownErrors?: boolean;
    baseDelayMs?: number;
    maxDelayMs?: number;
  };
};

type AgentRequestContextValues = {
  enabledSkills?: string[];
  workspaceMutationGenerationId?: string;
  toolCallBudget?: ToolCallBudget;
  workspaceRoot?: string;
  isWebWorkspace?: boolean;
  gitDetected?: boolean;
  modelId?: string;
  contextFilesMeta?: Array<{
    name?: string;
    path?: string;
    type?: string;
    size?: number;
    isImage?: boolean;
  }>;
  multimodalImageCount?: number;
};

export type AgentRequestValues = Omit<AgentRequestContextValues, "enabledSkills">;

type ToolParams = Record<string, unknown>;

type ToolResult = Record<string, unknown>;

type ToolLike<TParams extends ToolParams = ToolParams, TResult extends ToolResult = ToolResult> = {
  // eslint-disable-next-line no-unused-vars
  execute: (params: TParams) => Promise<TResult>;
  [key: string]: unknown;
};

type ValidationCommandConfig = {
  autoLint: boolean;
  autoTest: boolean;
  lintCommand?: string;
  testCommand?: string;
};

type ValidationCommandResult = {
  enabled: boolean;
  command?: string;
  success: boolean;
  stdout: string;
  stderr: string;
  error?: string;
  durationMs?: number;
};

type PostEditValidation = {
  lint?: ValidationCommandResult;
  test?: ValidationCommandResult;
};

const execAsync = promisify(exec);
const validationConfigCache = new Map<string, ValidationCommandConfig>();

const isEnabledByEnv = (value: string | undefined, defaultValue: boolean): boolean => {
  if (value === undefined) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return defaultValue;
};

const DEFAULT_OBSERVATIONAL_MODEL = "google/gemini-2.5-flash";
const DEFAULT_OBSERVATIONAL_SCOPE = "resource";
const DEFAULT_OBSERVATION_MESSAGE_TOKENS = 4_000;
const DEFAULT_REFLECTION_OBSERVATION_TOKENS = 8_000;
const isMemoryEnabled = (value: boolean | undefined): boolean => value !== false;

const asBoundedInteger = (
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number => {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
};

const resolveObservationalMemoryOption = (
  enabledOverride?: boolean,
  settingsOverride?: AgentFactoryOptions["observationalMemorySettings"],
): boolean | Record<string, unknown> => {
  // Observational-memory mode is controlled by app settings forwarded per request.
  // We intentionally avoid raw env fallback here to keep behavior user-scoped.
  const enabled = typeof enabledOverride === "boolean" ? enabledOverride : false;
  if (!enabled) return false;

  const modelRaw = settingsOverride?.model;
  const model =
    typeof modelRaw === "string" && modelRaw.trim().length > 0
      ? modelRaw.trim()
      : DEFAULT_OBSERVATIONAL_MODEL;
  const scope = settingsOverride?.scope === "thread" ? "thread" : DEFAULT_OBSERVATIONAL_SCOPE;
  const messageTokens = asBoundedInteger(
    settingsOverride?.observationMessageTokens,
    DEFAULT_OBSERVATION_MESSAGE_TOKENS,
    4_000,
    200_000,
  );
  const observationTokens = asBoundedInteger(
    settingsOverride?.reflectionObservationTokens,
    DEFAULT_REFLECTION_OBSERVATION_TOKENS,
    8_000,
    400_000,
  );
  const previousObserverTokens = asBoundedInteger(
    settingsOverride?.observationPreviousTokens,
    0,
    0,
    100_000,
  );
  const activateAfterIdle =
    typeof settingsOverride?.activateAfterIdle === "string"
      ? settingsOverride.activateAfterIdle.trim()
      : "";
  const activateOnProviderChange =
    typeof settingsOverride?.activateOnProviderChange === "boolean"
      ? settingsOverride.activateOnProviderChange
      : true;

  const observationalMemory: Record<string, unknown> = {
    model,
    scope,
    activateOnProviderChange,
  };

  observationalMemory.observation = {
    messageTokens,
    previousObserverTokens,
  };

  observationalMemory.reflection = {
    observationTokens,
  };

  if (activateAfterIdle) {
    observationalMemory.activateAfterIdle = activateAfterIdle;
  }

  return observationalMemory;
};

const resolvePackageManager = async (
  basePath: string,
): Promise<"npm" | "yarn" | "pnpm"> => {
  try {
    await fs.access(path.join(basePath, "pnpm-lock.yaml"));
    return "pnpm";
  } catch {
    // Keep checking other lockfiles.
  }

  try {
    await fs.access(path.join(basePath, "yarn.lock"));
    return "yarn";
  } catch {
    // Default fallback.
  }

  return "npm";
};

const buildScriptCommand = (
  packageManager: "npm" | "yarn" | "pnpm",
  script: string,
): string => {
  if (packageManager === "yarn") {
    return `yarn -s ${script}`;
  }
  if (packageManager === "pnpm") {
    return `pnpm -s run ${script}`;
  }
  return `npm run --silent ${script}`;
};

const resolveValidationConfig = async (
  basePath: string,
): Promise<ValidationCommandConfig> => {
  if (validationConfigCache.has(basePath)) {
    return validationConfigCache.get(basePath)!;
  }

  const config: ValidationCommandConfig = {
    autoLint: isEnabledByEnv(process.env.IRIS_AGENT_AUTO_LINT, false),
    autoTest: isEnabledByEnv(process.env.IRIS_AGENT_AUTO_TEST, false),
    lintCommand: process.env.IRIS_AGENT_LINT_CMD || undefined,
    testCommand: process.env.IRIS_AGENT_TEST_CMD || undefined,
  };

  if ((!config.lintCommand && config.autoLint) || (!config.testCommand && config.autoTest)) {
    try {
      const packageManager = await resolvePackageManager(basePath);
      const packageJsonPath = path.join(basePath, "package.json");
      const packageJsonContent = await fs.readFile(packageJsonPath, "utf8");
      const packageJson = JSON.parse(packageJsonContent) as {
        scripts?: Record<string, unknown>;
      };
      const scripts = packageJson.scripts || {};

      if (!config.lintCommand && config.autoLint && typeof scripts.lint === "string") {
        config.lintCommand = buildScriptCommand(packageManager, "lint");
      }

      if (!config.testCommand && config.autoTest && typeof scripts.test === "string") {
        config.testCommand = buildScriptCommand(packageManager, "test");
      }
    } catch {
      // No package.json or unreadable config; keep explicit env commands only.
    }
  }

  validationConfigCache.set(basePath, config);
  return config;
};

const runValidationCommand = async (
  command: string,
  cwd: string,
): Promise<ValidationCommandResult> => {
  const start = Date.now();

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout: 120000,
      maxBuffer: 1024 * 1024 * 8,
      env: process.env,
    });

    return {
      enabled: true,
      command,
      success: true,
      stdout: String(stdout || "").trim(),
      stderr: String(stderr || "").trim(),
      durationMs: Date.now() - start,
    };
  } catch (error) {
    const err = error as Error & { stdout?: string; stderr?: string };
    return {
      enabled: true,
      command,
      success: false,
      stdout: String(err.stdout || "").trim(),
      stderr: String(err.stderr || "").trim(),
      error: err.message,
      durationMs: Date.now() - start,
    };
  }
};

const runPostEditValidation = async (basePath: string): Promise<PostEditValidation | null> => {
  const config = await resolveValidationConfig(basePath);
  const result: PostEditValidation = {};

  if (config.autoLint) {
    if (config.lintCommand) {
      result.lint = await runValidationCommand(config.lintCommand, basePath);
    } else {
      result.lint = {
        enabled: true,
        success: false,
        stdout: "",
        stderr: "",
        error: "Auto lint enabled but no lint command could be resolved",
      };
    }
  }

  if (config.autoTest) {
    if (config.testCommand) {
      result.test = await runValidationCommand(config.testCommand, basePath);
    } else {
      result.test = {
        enabled: true,
        success: false,
        stdout: "",
        stderr: "",
        error: "Auto test enabled but no test command could be resolved",
      };
    }
  }

  return Object.keys(result).length > 0 ? result : null;
};

/**
 * Get the appropriate AI model provider based on model ID
 * @param {string} modelId - The model identifier (e.g., 'gpt-4o', 'claude-3-5-sonnet', 'gemini-pro')
 * @returns {Object} AI SDK model instance
 */
const getModel = (modelId: string) => {
    const anthropicBetaEnv =
      process.env.ANTHROPIC_BETA || process.env.ANTHROPIC_BETAS || "";
    const anthropicBetaHeader = anthropicBetaEnv
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .join(",");

    const anthropicProvider = anthropicBetaHeader
      ? createAnthropic({
          headers: {
            "anthropic-beta": anthropicBetaHeader,
          },
        })
      : null;

  const normalizedModelId = modelId.endsWith("-other")
    ? modelId.slice(0, -"-other".length)
    : modelId;

  const localBaseUrl = process.env.OLLAMA_BASE_URL || DEFAULT_LOCAL_RUNTIME_BASE_URL;
  const localApiKey = process.env.OLLAMA_API_KEY || DEFAULT_LOCAL_RUNTIME_API_KEY;
  const localOpenAICompatible = createOpenAI({
    baseURL: localBaseUrl,
    apiKey: localApiKey,
  });

  const isHuggingFaceModelId = (candidateModelId: string): boolean => {
    const normalized = (candidateModelId || "").toLowerCase();
    if (!normalized) return false;
    if (normalized.startsWith("huggingface/")) return true;
    // Common HuggingFace router provider suffix (e.g. "...:fireworks-ai")
    if (normalized.endsWith(":fireworks-ai")) return true;
    return false;
  };

  // HuggingFace Inference Router (OpenAI-compatible)
  if (isHuggingFaceModelId(normalizedModelId)) {
    const hfToken = process.env.HF_TOKEN;
    if (!hfToken) {
      throw new Error(
        "HuggingFace token is not configured. Set HF_TOKEN in Settings and click Save API Keys.",
      );
    }
    const hfClient = createOpenAI({
      baseURL: "https://router.huggingface.co/v1",
      apiKey: hfToken,
    });
    const cleanId = normalizedModelId.startsWith("huggingface/")
      ? normalizedModelId.slice("huggingface/".length)
      : normalizedModelId;
    return hfClient.chat(cleanId);
  }

  const resolveOpenrouterModel = (candidateModelId: string) => {
    const openrouterApiKey = process.env.OPENROUTER_API_KEY;
    if (!openrouterApiKey) {
      throw new Error(
        "OpenRouter API key is not configured. Set OPENROUTER_API_KEY in Settings and click Save API Keys.",
      );
    }
    const isOpenRouterDebugEnabled =
      process.env.NODE_ENV !== "production" &&
      process.env.OPENROUTER_DEBUG_ECHO_UPSTREAM_BODY === "1";
    const openrouter = createOpenRouter({
      baseURL: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
      apiKey: openrouterApiKey,
      // Optional attribution headers surface the app on OpenRouter leaderboards.
      headers: {
        "HTTP-Referer": process.env.OPENROUTER_SITE_URL || "https://github.com/osimuka/iris",
        "X-Title": process.env.OPENROUTER_SITE_NAME || "Iris",
      },
      ...(isOpenRouterDebugEnabled
        ? {
          fetch: async (input, init) => {
            const body = init?.body;
            if (typeof body === "string") {
              try {
                const payload = JSON.parse(body) as {
                  messages?: unknown[];
                  model?: unknown;
                  tools?: unknown[];
                };
                console.debug("[openrouter] validated outgoing request", {
                  model: payload.model,
                  messageCount: payload.messages?.length ?? 0,
                  toolCount: payload.tools?.length ?? 0,
                });
              } catch (error) {
                console.error("[openrouter] invalid outgoing JSON request", error);
              }
            }
            return fetch(input, init);
          },
        }
        : {}),
    });

    const openrouterAliasMap: Record<string, string> = {
      "openai/gpt-latest": "openrouter/free",
      "~openai/gpt-latest": "openrouter/free",
    };
    let resolvedOpenrouterModelId = openrouterAliasMap[candidateModelId] || candidateModelId;
    const debugSettings = isOpenRouterDebugEnabled
      ? { debug: { echo_upstream_body: true } }
      : undefined;

    // Free provider-specific routes are frequently burst-limited upstream.
    // Route them through OpenRouter's free router to improve availability.
    if (resolvedOpenrouterModelId.endsWith(":free")) {
      resolvedOpenrouterModelId = "openrouter/free";
    }

    if (resolvedOpenrouterModelId !== candidateModelId) {
      console.warn(
        `[agent] mapped OpenRouter model alias '${candidateModelId}' -> '${resolvedOpenrouterModelId}'`,
      );
    }

    return openrouter.chat(
      resolvedOpenrouterModelId,
      {
        ...(resolveOpenRouterModelSettings(resolvedOpenrouterModelId) ?? {}),
        ...(debugSettings ?? {}),
      },
    );
  };

  // OpenRouter unified gateway (OpenAI-compatible). Model IDs are explicitly
  // namespaced with an `openrouter/` prefix to avoid colliding with the
  // provider-routing heuristics below (e.g. an OpenRouter slug like
  // `google/gemini-2.0-flash` would otherwise be routed to Google directly).
  if (normalizedModelId.startsWith("openrouter/")) {
    const cleanId = normalizedModelId.slice("openrouter/".length);
    return resolveOpenrouterModel(cleanId);
  }

  // Explicit direct-provider namespace support.
  // These slugs should route to the corresponding provider rather than the
  // OpenRouter slash-model fallback below.
  if (normalizedModelId.startsWith("openai/")) {
    const cleanId = normalizedModelId.slice("openai/".length);
    return openai(cleanId);
  }

  if (normalizedModelId.startsWith("anthropic/")) {
    const cleanId = normalizedModelId.slice("anthropic/".length);
    if (anthropicBetaHeader) {
      console.warn(
        `[agent] using anthropic-beta header: ${anthropicBetaHeader}`,
      );
      return anthropicProvider!(cleanId);
    }
    return anthropic(cleanId);
  }

  // Some callers may already pass a raw OpenRouter slug (e.g. xiaomi/mimo-v2.5)
  // without the `openrouter/` namespace. Treat these as OpenRouter models.
  if (
    normalizedModelId.includes("/") &&
    !isHuggingFaceModelId(normalizedModelId) &&
    !normalizedModelId.startsWith("openai/") &&
    !normalizedModelId.startsWith("anthropic/") &&
    !normalizedModelId.startsWith("google/") &&
    !normalizedModelId.startsWith("ollama/") &&
    !normalizedModelId.startsWith("local/")
  ) {
    return resolveOpenrouterModel(normalizedModelId);
  }

  // USB-local or self-hosted OpenAI-compatible models (e.g. Ollama)
  if (isLocalModelId(normalizedModelId)) {
    const cleanId = normalizedModelId.startsWith("ollama/")
      ? normalizedModelId.slice("ollama/".length)
      : normalizedModelId.slice("local/".length);
    return localOpenAICompatible(cleanId);
  }

  // Anthropic Claude models
  if (normalizedModelId.startsWith("claude")) {
    if (anthropicBetaHeader) {
      console.warn(
        `[agent] using anthropic-beta header: ${anthropicBetaHeader}`,
      );
      return anthropicProvider!(normalizedModelId);
    }

    return anthropic(normalizedModelId);
  }

  // Google Gemini models
  if (normalizedModelId.startsWith("gemini") || normalizedModelId.startsWith("google/")) {
    const cleanId = normalizedModelId.replace("google/", "");
    return google(cleanId);
  }

  // OpenAI models (default)
  if (
    normalizedModelId.startsWith("gpt") ||
    normalizedModelId.startsWith("o1") ||
    normalizedModelId.startsWith("o3")
  ) {
    return openai(normalizedModelId);
  }

  // Default to OpenAI
  console.warn(`Unknown model provider for '${normalizedModelId}', defaulting to OpenAI`);
  return openai(normalizedModelId);
};

const supportsMastraProviderWebSearch = (modelId: string): boolean => {
  const normalizedModelId = modelId.endsWith("-other")
    ? modelId.slice(0, -"-other".length)
    : modelId;

  if (
    isLocalModelId(normalizedModelId) ||
    normalizedModelId.startsWith("openrouter/") ||
    normalizedModelId.startsWith("hf/") ||
    normalizedModelId.startsWith("huggingface/")
  ) {
    return false;
  }

  return (
    normalizedModelId.startsWith("gpt") ||
    normalizedModelId.startsWith("o1") ||
    normalizedModelId.startsWith("o3") ||
    normalizedModelId.startsWith("openai/") ||
    normalizedModelId.startsWith("claude") ||
    normalizedModelId.startsWith("anthropic/") ||
    normalizedModelId.startsWith("gemini") ||
    normalizedModelId.startsWith("google/")
  );
};

const toFinitePositiveInt = (value: unknown, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : fallback;
};

const parseOptionalBooleanEnv = (value: string | undefined): boolean | undefined => {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
};

const parseOptionalPositiveIntEnv = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return undefined;
  const normalized = Math.floor(parsed);
  return normalized > 0 ? normalized : undefined;
};

const resolveStreamErrorRetryConfig = (
  retryConfig: AgentFactoryOptions["streamErrorRetry"],
): AgentFactoryOptions["streamErrorRetry"] => {
  if (retryConfig !== undefined) {
    return retryConfig;
  }

  const enabled = parseOptionalBooleanEnv(process.env.IRIS_AGENT_STREAM_RETRY_ENABLED);
  const retryUnknownErrors = parseOptionalBooleanEnv(
    process.env.IRIS_AGENT_STREAM_RETRY_UNKNOWN_ERRORS,
  );
  const maxRetries = parseOptionalPositiveIntEnv(process.env.IRIS_AGENT_STREAM_RETRY_MAX_RETRIES);
  const baseDelayMs = parseOptionalPositiveIntEnv(process.env.IRIS_AGENT_STREAM_RETRY_BASE_DELAY_MS);
  const maxDelayMs = parseOptionalPositiveIntEnv(process.env.IRIS_AGENT_STREAM_RETRY_MAX_DELAY_MS);

  const fromEnv: AgentFactoryOptions["streamErrorRetry"] = {
    enabled,
    retryUnknownErrors,
    maxRetries,
    baseDelayMs,
    maxDelayMs,
  };

  return Object.values(fromEnv).some((value) => value !== undefined)
    ? fromEnv
    : undefined;
};

const buildStreamErrorRetryProcessors = (
  retryConfig: AgentFactoryOptions["streamErrorRetry"],
): StreamErrorRetryProcessor[] | [] | undefined => {
  if (retryConfig === undefined) {
    return undefined;
  }

  if (retryConfig.enabled === false) {
    return [];
  }

  const maxRetries = toFinitePositiveInt(retryConfig.maxRetries, 3);
  const baseDelayMs = toFinitePositiveInt(retryConfig.baseDelayMs, 800);
  const maxDelayMs = toFinitePositiveInt(retryConfig.maxDelayMs, 30_000);

  return [
    new StreamErrorRetryProcessor({
      maxRetries,
      retryUnknownErrors: retryConfig.retryUnknownErrors === true,
      delayMs: ({ retryCount }: { retryCount: number }) =>
        Math.min(baseDelayMs * 2 ** retryCount, maxDelayMs),
    }),
  ];
};

/**
 * Module-level cache of all skill entries, populated lazily on the first call
 * to `loadAllSkills` and retained for the lifetime of the process.
 *
 * **Intentional trade-off**: skills are bundled assets that change only on
 * deploy, so re-reading the directory on every request would add unnecessary
 * I/O with no practical benefit in production.
 *
 * If you need to invalidate the cache (e.g. in tests or during development
 * hot-reload) call the exported `resetSkillsCache()` helper.
 */
let _allSkillsCache: SkillEntry[] | null = null;

/**
 * Invalidate the in-process skills cache so that the next call to
 * `loadAllSkills` / `buildSkillsBlock` re-reads the skills directory.
 * Intended for use in tests and development hot-reload scenarios.
 */
export function resetSkillsCache(): void {
  _allSkillsCache = null;
}

async function loadAllSkills(): Promise<SkillEntry[]> {
  if (process.env.NODE_ENV === "production" && _allSkillsCache !== null) return _allSkillsCache;
  const skills = await loadSkillsFromDirectories([getSkillsDir()]);
  _allSkillsCache = skills;
  return skills;
}

const normalizeEnabledSkills = (enabledSkills?: string[]): string[] => {
  if (!Array.isArray(enabledSkills)) {
    return [];
  }

  const normalized = enabledSkills
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value) => /^[a-zA-Z0-9._-]{1,80}$/.test(value));

  return Array.from(new Set(normalized));
};

const resolveAgentSkillPaths = async (
  enabledSkills?: string[],
): Promise<string[]> => {
  const normalizedEnabledSkills = normalizeEnabledSkills(enabledSkills);

  if (normalizedEnabledSkills.length === 0) {
    return [];
  }

  const all = await loadAllSkills();
  const pathsByName = new Map(
    all.map((skill) => [
      skill.name,
      path.join(getSkillsDir(), path.basename(path.dirname(skill.location))),
    ]),
  );

  return normalizedEnabledSkills
    .map((name) => pathsByName.get(name))
    .filter((skillPath): skillPath is string => Boolean(skillPath));
};

export const createAgentRequestContext = (
  enabledSkills?: string[],
  requestValues?: AgentRequestValues,
): RequestContext<AgentRequestContextValues> => {
  const normalizedEnabledSkills = normalizeEnabledSkills(enabledSkills);
  const context = new RequestContext<AgentRequestContextValues>(
    [["enabledSkills", normalizedEnabledSkills]],
  );

  // Request-scoped values (workspace, model, git state) belong here rather
  // than in the prompt: they influence behavior without polluting memory.
  for (const [key, value] of Object.entries(requestValues || {})) {
    if (value !== undefined) {
      context.set(
        key as keyof AgentRequestContextValues,
        value as never,
      );
    }
  }

  return context;
};

/**
 * Return the canonical list of available skills for use by the
 * `GET /api/agent/skills` endpoint. Each entry exposes the directory-name slug
 * as `id` (matching what the client stores in preferences) and the description
 * sourced directly from the SKILL.md frontmatter.
 */
export async function getSkillsList(): Promise<Array<{ id: string; description: string }>> {
  const all = await loadAllSkills();
  return all.map((s) => ({ id: s.name, description: s.description }));
}

/**
 * Determine the appropriate database URL for Mastra Memory storage.
 * - Desktop (Tauri): platform-specific app data directory (macOS: ~/Library/Application Support/AIRIS)
 * - Web/Server: external database URL from env or shared data directory
 * - Development: ./mastra.db (relative to cwd)
 */
function getDefaultDbUrl(): string {
  const isTauriBundled = (() => {
    const rawValue = process.env.TAURI_BUNDLED;
    if (!rawValue) return false;
    const normalized = rawValue.trim().toLowerCase();
    return normalized === "1" || normalized === "true" || normalized === "yes";
  })();

  // Desktop Tauri app: use platform-specific app data directory
  if (isTauriBundled) {
    let appDataDir: string;
    if (process.platform === "darwin") {
      // macOS: ~/Library/Application Support/AIRIS
      appDataDir = path.join(os.homedir(), "Library", "Application Support", "AIRIS");
    } else if (process.platform === "win32") {
      // Windows: %APPDATA%\AIRIS
      appDataDir = path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "AIRIS");
    } else {
      // Linux: ~/.local/share/airis
      appDataDir = path.join(os.homedir(), ".local", "share", "airis");
    }

    // Ensure parent directory exists before SQLite opens/creates the DB file.
    fsNative.mkdirSync(appDataDir, { recursive: true });
    return `file:${path.join(appDataDir, "mastra.db")}`;
  }

  // Web/Server deployment: check for external database
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }

  // Development fallback
  return "file:./mastra.db";
}

export const CODING_AGENT_INSTRUCTIONS = `
You are AIRIS, a senior coding agent working in the user's current workspace.
Follow these rules in order; when rules conflict, the earlier rule wins.

## Priorities

1. Fulfill the user's actual request and preserve explicitly stated constraints.
2. Protect user data, existing work, credentials, and external systems.
3. Ground workspace-specific claims in current tool results.
4. Make the smallest complete change that solves the root problem.
5. Use the fewest tool calls that still provide enough evidence and validation.

## Decide Whether To Act

- Use tools when the request depends on workspace contents, runtime state, command output,
  current web information, or an external system. Do not force a tool call for a purely
  conceptual or conversational answer.
- When the user clearly requests a change or command, perform it instead of only proposing it.
- Ask one concise clarification only when missing information materially changes the result,
  no safe default exists, or an irreversible/external action needs confirmation. Otherwise,
  infer the most conservative reasonable intent and proceed.
- Respect tool approval and suspension flows. Waiting for required user input is a valid stop.
- Never invent paths, file contents, command output, tool capabilities, or successful completion.

## Working Method

1. Start from the most concrete available anchor: an exact file, symbol, error, command, test,
   or nearby implementation.
2. Gather only enough current evidence to identify the controlling code path and a check that
   can disprove the intended fix. Avoid broad project surveys when a local read or search is enough.
3. Make a focused change using the repository's existing patterns and public contracts.
4. After an edit, run the narrowest available validation that exercises the changed behavior.
5. If validation exposes a local defect, fix that same slice and rerun the same check. Do not
   expand into unrelated cleanup.
6. Finish with a concise factual response once the request is complete, blocked, awaiting input,
   or the action budget is exhausted.

## Tool Selection

- Treat the tools and their current schemas as authoritative. Never call aliases that are not
  exposed in the current run.
- Known exact path: use readFile directly. Unknown filename: use searchFiles. Known text or code
  pattern: use grepSearch. Use workspaceSearch, when exposed, for conceptual discovery. Use
  getWorkspaceInfo only when a broad project overview is genuinely needed.
- Use getCodeContext or LSP tools when semantic precision matters. Use findReferences before
  changing a shared symbol or contract, and prefer renameSymbol for semantic renames.
- Use editFile for exact, localized replacements, writeFile for new files or deliberate full
  rewrites, and applyDiff for coordinated multi-hunk changes. These AIRIS mutation tools return
  rich diff metadata for review.
- Prefer file tools over shell-based file mutation. Use runTerminalCommand for builds, tests,
  package operations, git inspection, and commands whose behavior belongs in a shell.
- taskList, taskOutput, and taskStop manage background terminal tasks; they are not planning or
  todo-list tools.
- Use MCP and web tools only when the request requires their external capability. Follow each
  exposed schema exactly and avoid irreversible external actions without clear authorization.
- Issue independent reads or searches together when supported. Batch dependent shell commands
  with && only when later commands should run solely after earlier ones succeed.

## Editing And Validation

- Read the relevant current region before modifying an existing file unless its current content
  is already present in the conversation or a fresh tool result.
- Preserve repository style, public APIs, and user-authored changes. Do not reformat, revert,
  delete, or refactor unrelated code.
- Do not perform destructive git operations, commit, push, deploy, publish, or install global
  software unless the user explicitly requests or clearly authorizes it.
- Inspect the mutation result rather than rereading a file solely to confirm that the tool wrote it.
- Prefer a behavior-scoped test, then a targeted test, typecheck, lint, or build. Broaden validation
  only when the change's risk or shared surface justifies it.
- Report pre-existing or unrelated failures without trying to repair them unless they block the task.

## Failure And Completion

- Read the exact error, correct the likely cause, and retry with a bounded alternative. Do not repeat
  the same failing call or continue investigating after the answer is known.
- Continue autonomously until the requested outcome is complete. Stop only when complete, genuinely
  blocked, waiting for required input/approval, or out of the runtime's action budget.
- The configured Mastra maxSteps value is the sole action budget. When it is nearly exhausted,
  prioritize the essential implementation and validation. If exhausted, provide a final synthesis
  of what completed, what remains, and the concrete blocker; do not claim success for partial work.
- After tools, always provide meaningful final text. State the result first, name changed files or
  important findings, and include validation status. Keep details proportional to the request.
- Do not end with a generic offer, ask what to do next, narrate tool mechanics, or continue calling
  tools after the task is resolved.
`.trim();

export const createCodingAgent = async (
  modelId = "gpt-4o",
  workspacePath: string | null = null,
  options: AgentFactoryOptions = {},
) => {
  // Skip filesystem workspace init for virtual/web paths (e.g. /workspace/*)
  // that don't exist on the server's filesystem. The web client provides file
  // context for those sessions, while agent-level skills still come from the
  // app-owned skills directory.
  const isVirtualPath =
    workspacePath && workspacePath.startsWith("/workspace/");
  const basePath = workspacePath || process.cwd();
  const mcpServers = options.mcpServers || [];
  const terminalAutoApproveRules = options.terminalAutoApproveRules;
  const modelInputTokenLimit = resolveModelInputTokenLimit(modelId);
  const modelSupportsVision = resolveModelSupportsVision(modelId);
  const resolvedStreamErrorRetryConfig = resolveStreamErrorRetryConfig(
    options.streamErrorRetry,
  );
  const configuredErrorProcessors = buildStreamErrorRetryProcessors(
    resolvedStreamErrorRetryConfig,
  );
  const errorProcessorOverrides =
    configuredErrorProcessors === undefined
      ? {}
      : { errorProcessors: configuredErrorProcessors };
  const observationalMemoryOption = resolveObservationalMemoryOption(
    options.useMastraObservationalMemory,
    options.observationalMemorySettings,
  );
  const goalJudgeModelId =
    options.goalJudgeModelId || process.env.IRIS_AGENT_GOAL_JUDGE_MODEL || modelId;
  const workspaceMutationBridge = new CapturedWorkspaceMutationBridge(
    basePath,
    () => runPostEditValidation(basePath),
  );

  let workspace: Workspace | undefined;

  if (!isVirtualPath) {
    try {
      workspace = new Workspace({
        // Provide concise, token-efficient filesystem guidance.
        // Keep filesystem guidance focused on the available capabilities.
        filesystem: new LocalFilesystem({
          basePath,
          instructions:
            "Use workspaceSearch for conceptual discovery, grepSearch for exact text, and readFile before editing. Use editFile with filePath plus oldContent/newContent for small exact replacements, writeFile for full-file changes, and applyDiff for multi-hunk patches. File mutations return reversible diff metadata for user review; validate focused changes before finishing.",
        }),
        bm25: true,
        tools: createIrisWorkspaceToolsConfig(workspaceMutationBridge.hooks),
      });
      await workspace.init();
      console.log("Workspace initialized");
    } catch (err) {
      const error = err as Error;
      console.warn(
        "⚠️ Workspace init failed, continuing without workspace:",
        error.message,
      );
    }
  } else {
    console.log(
      "⚠️ Virtual/web workspace detected — skipping filesystem initialization",
    );
  }

  // Create a wrapped version of getWorkspaceInfo with the correct default path
  const wrappedGetWorkspaceInfo = {
    ...getWorkspaceInfoTool,
    execute: async (params: Parameters<typeof getWorkspaceInfoTool.execute>[0]) => {
      // FORCE the workspace path if it was provided to the factory
      // The agent often hallucinates a path like "social-bot" or "my-project"
      // We ignore params.workspacePath to prevent these errors
      const actualParams = {
        ...params,
        workspacePath: workspacePath || process.cwd(),
      };

      // Use error recovery for workspace info tool
      return executeToolWithRecovery(getWorkspaceInfoTool, actualParams, {
        maxRetries: 2,
        workspacePath: workspacePath || process.cwd(),
      });
    },
  };

  // Helper to resolve paths relative to workspace
  const resolvePath = <T extends string | null | undefined>(p: T): T => {
    if (!p) return p;
    if (path.isAbsolute(p)) return p;
    return path.join(workspacePath || process.cwd(), p) as T;
  };

  // Helper to wrap tools with workspace path resolution AND error recovery
  const wrapTool = <TTool extends ToolLike<any, any>>(
    tool: TTool,
    // eslint-disable-next-line no-unused-vars
    localExecute: (params: Parameters<TTool["execute"]>[0]) => ReturnType<TTool["execute"]>,
  ): TTool => {
    return {
      ...tool,
      execute: async (params: Parameters<TTool["execute"]>[0]) =>
        // Wrap execution with error recovery
        (await executeToolWithRecovery(
          {
            ...tool,
              // eslint-disable-next-line no-unused-vars
            execute: localExecute as (params: ToolParams) => Promise<ToolResult>,
          },
          params,
          {
            maxRetries: 2,
            workspacePath: workspacePath || process.cwd(),
          },
        )) as Awaited<ReturnType<TTool["execute"]>>,
    };
  };

  // Wrap tools to ensure they use the correct workspace path
  const workspaceBasePath = workspacePath || process.cwd();

  const rejectOutsideWorkspaceMutation = (...filePaths: string[]) =>
    rejectUnsafeWorkspaceMutation(
      workspaceBasePath,
      Boolean(isVirtualPath),
      filePaths,
    );

  const withPostEditValidation = async <TResult extends Record<string, unknown>>(
    result: TResult,
  ): Promise<TResult> => {
    if (!result || result.success !== true) {
      return result;
    }

    const validation = await runPostEditValidation(workspaceBasePath);
    if (!validation) {
      return result;
    }

    return {
      ...result,
      validation,
    };
  };

  const wrappedReadFile = wrapTool(readFileTool, async (p: Parameters<typeof readFileTool.execute>[0]) =>
    readFileTool.execute({
      ...p,
      filePath: resolvePath(p.filePath),
      workspaceRoot: p.workspaceRoot || workspacePath || process.cwd(),
    }),
  );
  const wrappedWriteFile = wrapTool(writeFileTool, async (p: Parameters<typeof writeFileTool.execute>[0]) =>
    {
      const filePath = resolvePath(p.filePath);
      const rejection = await rejectOutsideWorkspaceMutation(filePath);
      if (rejection) return rejection;
      return withPostEditValidation(await writeFileTool.execute({ ...p, filePath }));
    },
  );
  const wrappedEditFile = wrapTool(editFileTool, async (p: Parameters<typeof editFileTool.execute>[0]) =>
    {
      const filePath = resolvePath(p.filePath);
      const rejection = await rejectOutsideWorkspaceMutation(filePath);
      if (rejection) return rejection;
      return withPostEditValidation(await editFileTool.execute({ ...p, filePath }));
    },
  );
  const wrappedDeleteFile = wrapTool(deleteFileTool, async (p: Parameters<typeof deleteFileTool.execute>[0]) =>
    {
      const filePath = resolvePath(p.filePath);
      const rejection = await rejectOutsideWorkspaceMutation(filePath);
      if (rejection) return rejection;
      return deleteFileTool.execute({ ...p, filePath });
    },
  );
  const wrappedRenameFile = wrapTool(renameFileTool, async (p: Parameters<typeof renameFileTool.execute>[0]) =>
    {
      const oldPath = resolvePath(p.oldPath);
      const newPath = resolvePath(p.newPath);
      const rejection = await rejectOutsideWorkspaceMutation(oldPath, newPath);
      if (rejection) return rejection;
      return renameFileTool.execute({ ...p, oldPath, newPath });
    },
  );
  const wrappedListDirectory = wrapTool(listDirectoryTool, async (p: Parameters<typeof listDirectoryTool.execute>[0]) =>
    listDirectoryTool.execute({ ...p, dirPath: resolvePath(p.dirPath) }),
  );
  const wrappedCreateDirectory = wrapTool(createDirectoryTool, async (p: Parameters<typeof createDirectoryTool.execute>[0]) =>
    {
      const dirPath = resolvePath(p.dirPath);
      const rejection = await rejectOutsideWorkspaceMutation(dirPath);
      if (rejection) return rejection;
      return createDirectoryTool.execute({ ...p, dirPath });
    },
  );
  const wrappedGetSymbols = wrapTool(getSymbolsTool, async (p: Parameters<typeof getSymbolsTool.execute>[0]) =>
    getSymbolsTool.execute({ ...p, filePath: resolvePath(p.filePath) }),
  );
  const wrappedApplyDiff = wrapTool(applyDiffTool, async (p: Parameters<typeof applyDiffTool.execute>[0]) =>
    {
      const filePath = resolvePath(p.filePath);
      const rejection = await rejectOutsideWorkspaceMutation(filePath);
      if (rejection) return rejection;
      return withPostEditValidation(await applyDiffTool.execute({ ...p, filePath }));
    },
  );

  const wrappedSearchFiles = wrapTool(searchFilesTool, async (p: Parameters<typeof searchFilesTool.execute>[0]) =>
    searchFilesTool.execute({ ...p, cwd: workspacePath || process.cwd() }),
  );
  const wrappedGrepSearch = wrapTool(grepSearchTool, async (p: Parameters<typeof grepSearchTool.execute>[0]) =>
    grepSearchTool.execute({ ...p, cwd: workspacePath || process.cwd() }),
  );
  const wrappedFindFileContent = wrapTool(findFileContentTool, async (p: Parameters<typeof findFileContentTool.execute>[0]) =>
    findFileContentTool.execute({
      ...p,
      rootFolder: workspacePath || process.cwd(),
    }),
  );

  const wrappedQueryKnowledgeGraph = wrapTool(
    queryKnowledgeGraphTool,
    async (p: Parameters<typeof queryKnowledgeGraphTool.execute>[0]) =>
      queryKnowledgeGraphTool.execute({
        ...p,
        filePath: p.filePath ? resolvePath(p.filePath) : undefined,
      }),
  );

  // LSP-based tools for code intelligence
  const wrappedGetTypeInfo = wrapTool(getTypeInfoTool, async (p: Parameters<typeof getTypeInfoTool.execute>[0]) =>
    getTypeInfoTool.execute({ ...p, filePath: resolvePath(p.filePath) }),
  );

  const wrappedFindDefinition = wrapTool(findDefinitionTool, async (p: Parameters<typeof findDefinitionTool.execute>[0]) =>
    findDefinitionTool.execute({ ...p, filePath: resolvePath(p.filePath) }),
  );

  const wrappedFindReferences = wrapTool(findReferencesTool, async (p: Parameters<typeof findReferencesTool.execute>[0]) =>
    findReferencesTool.execute({ ...p, filePath: resolvePath(p.filePath) }),
  );

  const wrappedGetSymbolsLSP = wrapTool(getSymbolsLSPTool, async (p: Parameters<typeof getSymbolsLSPTool.execute>[0]) =>
    getSymbolsLSPTool.execute({ ...p, filePath: resolvePath(p.filePath) }),
  );

  const wrappedGetCodeCompletion = wrapTool(getCodeCompletionTool, async (p: Parameters<typeof getCodeCompletionTool.execute>[0]) =>
    getCodeCompletionTool.execute({ ...p, filePath: resolvePath(p.filePath) }),
  );

  const wrappedGetSignatureHelp = wrapTool(getSignatureHelpTool, async (p: Parameters<typeof getSignatureHelpTool.execute>[0]) =>
    getSignatureHelpTool.execute({ ...p, filePath: resolvePath(p.filePath) }),
  );

  const wrappedGetCodeActions = wrapTool(getCodeActionsTool, async (p: Parameters<typeof getCodeActionsTool.execute>[0]) =>
    getCodeActionsTool.execute({ ...p, filePath: resolvePath(p.filePath) }),
  );

  const wrappedRenameSymbol = wrapTool(renameSymbolTool, async (p: Parameters<typeof renameSymbolTool.execute>[0]) =>
    renameSymbolTool.execute({ ...p, filePath: resolvePath(p.filePath) }),
  );

  const wrappedFormatDocument = wrapTool(formatDocumentTool, async (p: Parameters<typeof formatDocumentTool.execute>[0]) =>
    formatDocumentTool.execute({ ...p, filePath: resolvePath(p.filePath) }),
  );

  const wrappedGetWorkspaceSymbols = wrapTool(getWorkspaceSymbolsTool, async (p: Parameters<typeof getWorkspaceSymbolsTool.execute>[0]) =>
    getWorkspaceSymbolsTool.execute(p),
  );

  // Wrap getCodeContext tool for VS Code Copilot-style responses
  const wrappedGetCodeContext = {
    ...getCodeContextTool,
    execute: async (inputData: unknown, context: unknown) => {
      const execute = getCodeContextTool.execute as
        | ((inputData: Record<string, unknown>, context: unknown) => Promise<unknown>)
        | undefined;
      if (!execute) {
        throw new Error("getCodeContext tool is unavailable");
      }
      return execute(
        { ...(inputData as Record<string, unknown>), cwd: workspacePath || process.cwd() },
        context,
      );
    },
  };
  // Keep browser search as a fallback for local, routed, and unsupported providers.
  const wrappedBrowserWebSearch = wrapTool(browserWebSearchTool, async (p: Parameters<typeof browserWebSearchTool.execute>[0]) =>
    browserWebSearchTool.execute(p)
  );
  const resolvedWebSearchTool = supportsMastraProviderWebSearch(modelId)
    ? mastraWebSearchTool
    : wrappedBrowserWebSearch;

  // Initialize LSP manager with workspace path
  if (workspacePath) {
    coreLsp.connect(workspacePath);
  }

  // Discover MCP tools once for this agent instance.
  const mcpTools = await buildMcpTools(mcpServers, basePath);
  console.log("🧩 MCP Tools registered:", Object.keys(mcpTools));
  if (Object.keys(mcpTools).length > 0) {
    console.log("✅ MCP tools available to agent:", Object.keys(mcpTools).join(", "));

    // Persist MCP tool documentation to workspace for semantic search
    // Only document connected servers; remove docs if no servers available
    if (workspace && mcpServers.length > 0) {
      const mcpDocsPath = path.join(basePath, ".mcp-tools.md");
      try {
        const mcpDocs = await generateMcpToolsDocs(mcpServers, basePath);

        if (mcpDocs) {
          // Write documentation for connected servers
          await fs.writeFile(mcpDocsPath, mcpDocs, "utf8");
          console.log("📚 MCP tool documentation persisted to:", mcpDocsPath);
          console.log("🔍 MCP tools documentation ready for workspace queries");
        } else {
          // No connected servers - remove stale documentation if it exists
          try {
            await fs.unlink(mcpDocsPath);
            console.log("🗑️ Removed stale MCP documentation (no servers connected)");
          } catch (err) {
            // File might not exist, that's fine
          }
        }
      } catch (err) {
        const error = err as Error;
        console.warn("⚠️ Failed to persist MCP tool docs:", error.message);
      }
    }
  } else {
    console.log("⚠️ No MCP tools registered (mcpServers:", mcpServers.length, ")");
  }

  // Wrap terminal command to use workspace path as cwd
  const wrappedRunTerminalCommand = {
    ...runTerminalCommandTool,
    execute: async (
      params: Parameters<typeof runTerminalCommandTool.execute>[0],
    ) => {
      const actualParams = {
        ...params,
        cwd: params.cwd || workspacePath || process.cwd(),
        workspaceRoot: params.workspaceRoot || workspacePath || process.cwd(),
        autoApproveRules: params.autoApproveRules || terminalAutoApproveRules,
      };

      // Use error recovery for terminal commands (with extended timeout handling)
      return executeToolWithRecovery(runTerminalCommandTool, actualParams, {
        maxRetries: 1, // Fewer retries for terminal commands
        workspacePath: workspacePath || process.cwd(),
        timeout: params.timeout || 30000, // Default 30s timeout
      });
    },
  };

  const agent = createMastraCodingAgent({
    id: options.id || "custom-coding-agent",
    name: options.name || "Coding Agent",
    skills: async ({ requestContext }) => {
      const enabledSkills = (requestContext as { get?: (key: string) => unknown } | undefined)
        ?.get?.("enabledSkills") as
        | string[]
        | undefined;
      return resolveAgentSkillPaths(enabledSkills);
    },
    instructions: CODING_AGENT_INSTRUCTIONS,

    model: getModel(modelId),
    workspace,
    tools: enforceToolCallBudgetForTools({
      // Local workspaces provide these through Mastra Workspace under the
      // established Iris names. Virtual workspaces retain the client-aware tools.
      ...(workspace
        ? {
          writeFile: wrappedWriteFile,
          editFile: wrappedEditFile,
        }
        : {
          readFile: wrappedReadFile,
          listDirectory: wrappedListDirectory,
          grepSearch: wrappedGrepSearch,
          writeFile: wrappedWriteFile,
          editFile: wrappedEditFile,
          deleteFile: wrappedDeleteFile,
          createDirectory: wrappedCreateDirectory,
        }),
      searchFiles: wrappedSearchFiles,
      renameFile: wrappedRenameFile,
      getWorkspaceInfo: wrappedGetWorkspaceInfo,
      findFileContent: wrappedFindFileContent,
      getSymbols: wrappedGetSymbols,
      runTerminalCommand: wrappedRunTerminalCommand,
      applyDiff: wrappedApplyDiff,
      queryKnowledgeGraph: wrappedQueryKnowledgeGraph,
      // LSP-based code intelligence tools
      getTypeInfo: wrappedGetTypeInfo,
      findDefinition: wrappedFindDefinition,
      findReferences: wrappedFindReferences,
      getSymbolsLSP: wrappedGetSymbolsLSP,
      getCodeCompletion: wrappedGetCodeCompletion,
      getSignatureHelp: wrappedGetSignatureHelp,
      getCodeActions: wrappedGetCodeActions,
      renameSymbol: wrappedRenameSymbol,
      formatDocument: wrappedFormatDocument,
      getWorkspaceSymbols: wrappedGetWorkspaceSymbols,
      // Code context tool for answering questions about code
      getCodeContext: wrappedGetCodeContext,
      // Background task management
      taskList: taskListTool,
      taskOutput: taskOutputTool,
      taskStop: taskStopTool,
      // Web access: provider-native search when available, browser fallback otherwise.
      webSearch: resolvedWebSearchTool,
      fetchWebpage: mastraWebFetchTool,
      ...mcpTools,
    }),

    // Add memory for conversation context with token-aware budgeting.
    // TokenLimiterProcessor moved to inputProcessors (new Mastra API).
    // Memory is on by default and can be disabled only via explicit options.
    memory: isMemoryEnabled(options.enableMemory)
      ? new Memory({
        storage: new LibSQLStore({
          id: options.storageId || "custom-coding-agent-storage",
          url: options.dbUrl || getDefaultDbUrl(),
        }),
        options: {
          generateTitle: true,
          // Bounded conversation history: prioritize recent turns over full replay.
          // TokenLimiterProcessor enforces input token budget; lastMessages controls
          // max messages to keep in context before older turns are archived.
          lastMessages: 20,
          workingMemory: { enabled: true },
          // Compress long-running conversations into observations instead
          // of replaying full history. Opt-in until embedder/model costs
          // are validated for local setups.
          observationalMemory: observationalMemoryOption,
        },
        vector: new LibSQLVector({
          id: options.vectorId || "custom-coding-agent-vector",
          url: options.dbUrl || getDefaultDbUrl(),
        }),
      })
      : undefined,

    goal: isMemoryEnabled(options.enableMemory)
      ? {
        judge: getModel(goalJudgeModelId),
        maxRuns: options.goalMaxRuns ?? 12,
        maxSteps: 1,
        prompt:
          "Mark the objective complete only when the requested implementation is complete and applicable validation has passed. Do not accept a plan, partial implementation, or an unsupported completion claim.",
      }
      : undefined,

    // Token-aware budgeting: enforce model-specific input token limits.
    // TokenLimiterProcessor limits input tokens; outputProcessors can compress output if needed.
    inputProcessors: [new MultimodalTokenLimiterProcessor(modelInputTokenLimit, modelSupportsVision)],
    outputProcessors: [workspaceMutationBridge, new ToolResultSafetyProcessor()],
    // Keep helper defaults unless explicit retry overrides are provided.
    ...errorProcessorOverrides,

    // Default configuration
    defaultOptions: {
      maxSteps: options.maxSteps ?? 50,
      toolChoice: options.toolChoice ?? "auto",
      ...options.defaultOptions,
    } as never,
  });

  return Object.assign(agent, {
    takeProcessedWorkspaceResults: (generationId: string, toolCallIds: string[]) =>
      workspaceMutationBridge.takeProcessedResults(generationId, toolCallIds),
    clearProcessedWorkspaceResults: (generationId: string) =>
      workspaceMutationBridge.clearProcessedResults(generationId),
  });
};

// createCodingAgent is the primary export. Callers should await it explicitly
// rather than relying on a pre-initialized instance, to ensure environment
// variables and database connections are ready before the agent is created.
