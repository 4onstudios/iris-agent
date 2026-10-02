const MODEL_INPUT_TOKEN_LIMITS: Record<string, number> = {
  "openrouter/anthropic/claude-sonnet-latest": 1_000_000,
  "openrouter/google/gemini-2.5-pro": 1_000_000,
  "openrouter/deepseek/deepseek-chat": 164_000,
  "openrouter/xiaomi/mimo-v2.5": 128_000,
  "openrouter/minimax/minimax-m3": 128_000,
  "openrouter/deepseek/deepseek-v4-flash": 128_000,
  "openrouter/openai/gpt-5.5": 1_000_000,
  "openrouter/openai/gpt-5.5-pro": 1_000_000,
  "openrouter/openai/gpt-5.1-codex-mini": 400_000,
  "openrouter/openai/gpt-5.1-codex": 400_000,
  "openrouter/openai/gpt-5.1-codex-max": 400_000,
  "openrouter/openai/gpt-5.2-codex": 400_000,
  // OpenAI specifies 272k maximum input within the 400k context window.
  "openrouter/openai/gpt-5.3-codex": 272_000,
  "openrouter/anthropic/claude-haiku-4.5": 200_000,
  "openrouter/anthropic/claude-opus-4.1": 1_000_000,
  "openrouter/anthropic/claude-fable-5": 1_000_000,
  "openrouter/moonshotai/kimi-k2.5": 256_000,
  "openrouter/moonshotai/kimi-k3": 256_000,
  "openrouter/google/gemini-2.5-flash": 1_000_000,
  "openrouter/z-ai/glm-5.2": 128_000,
  "openrouter/openai/gpt-oss-20b:free": 128_000,
  "openrouter/openai/gpt-oss-120b:free": 128_000,
  "openrouter/z-ai/glm-4.5-air:free": 128_000,
  "openrouter/poolside/laguna-xs.2:free": 64_000,
  "gemini-2.5-pro": 173_000,
  "gemini-3-flash-preview": 173_000,
  "gemini-3.1-pro-preview": 1_000_000,
  "gemini-3.5-flash": 1_000_000,
  "gpt-5-mini": 192_000,
  "gpt-5.2": 192_000,
  "gpt-5.2-codex": 400_000,
  "gpt-5.3-codex": 272_000,
  "gpt-5.4": 1_000_000,
  "gpt-5.4-mini": 400_000,
  "raptor-mini-preview": 264_000,
  "claude-haiku-4.5-other": 160_000,
  "claude-sonnet-4.5-other": 160_000,
  "claude-sonnet-4.6-other": 1_000_000,
  "huggingface/moonshotai/Kimi-K2.7-Code:fastest": 128_000,
  "huggingface/meta-llama/Llama-4-Maverick-17B-128E-Instruct:fastest": 1_000_000,
  "huggingface/Qwen/Qwen3-235B-A22B:fastest": 128_000,
  "huggingface/deepseek-ai/DeepSeek-V3-0324:fastest": 128_000,
  "huggingface/mistralai/Mistral-Small-3.2-24B-Instruct-2506:fastest": 128_000,
  "claude-haiku-4-5": 200_000,
  "claude-opus-4-8": 1_000_000,
  "claude-fable-5": 1_000_000,
  "claude-sonnet-4-6": 1_000_000,
};

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

const getEnvTokenLimitOverride = (env: NodeJS.ProcessEnv = process.env): number | null => {
  const raw = env.IRIS_AGENT_INPUT_TOKEN_LIMIT;
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return null;
  return clamp(parsed, 4_096, 1_000_000);
};

const OPENROUTER_METADATA_TTL_MS = 60 * 60 * 1000;
const OPENROUTER_METADATA_FAILURE_TTL_MS = 5 * 60 * 1000;
const OPENROUTER_METADATA_TIMEOUT_MS = 3_000;
const UNKNOWN_MODEL_INPUT_LIMIT = 16_000;
const OPENROUTER_MAX_INPUT_TOKENS: Record<string, number> = {
  "openai/gpt-5.3-codex": 272_000,
};
export type ModelContextBudget = {
  inputTokens: number;
  maxOutputTokens: number;
};
const modelLimits = new Map<string, { budget: ModelContextBudget; expiresAt: number }>();
const pendingModelLimits = new Map<string, Promise<ModelContextBudget>>();

const positiveTokenCount = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;

const openRouterSlug = (modelId: string, env: NodeJS.ProcessEnv): string | undefined => {
  const normalized = stripProviderSuffix(modelId.trim());
  if (normalized.startsWith("openrouter/")) {
    return normalized.slice("openrouter/".length);
  }
  if (
    normalized.startsWith("ollama/") ||
    normalized.startsWith("local/") ||
    normalized.startsWith("huggingface/") ||
    normalized.startsWith("anthropic/") ||
    normalized.startsWith("openai/")
  ) return undefined;
  if (normalized.startsWith("google/")) {
    return !env.GOOGLE_GENERATIVE_AI_API_KEY &&
      !env.GEMINI_API_KEY &&
      env.OPENROUTER_API_KEY
      ? normalized
      : undefined;
  }
  if (normalized.includes("/")) {
    return env.OPENROUTER_API_KEY ? normalized : undefined;
  }
  if (normalized.startsWith("claude")) {
    return !env.ANTHROPIC_API_KEY && env.OPENROUTER_API_KEY
      ? `anthropic/${normalized}`
      : undefined;
  }
  if (normalized.startsWith("gemini")) {
    return !env.GOOGLE_GENERATIVE_AI_API_KEY &&
      !env.GEMINI_API_KEY &&
      env.OPENROUTER_API_KEY
      ? `google/${normalized}`
      : undefined;
  }
  if (
    normalized.startsWith("gpt") ||
    /^o[13]/.test(normalized)
  ) {
    return !env.OPENAI_API_KEY && env.OPENROUTER_API_KEY
      ? `openai/${normalized}`
      : undefined;
  }
  return !env.OPENAI_API_KEY && env.OPENROUTER_API_KEY
    ? normalized
    : undefined;
};

const fetchOpenRouterInputLimit = async (
  slug: string,
  env: NodeJS.ProcessEnv,
): Promise<ModelContextBudget> => {
  const baseURL = new URL(env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1");
  const modelURL = new URL(`${baseURL.pathname.replace(/\/$/, "")}/model/${slug.split("/").map(encodeURIComponent).join("/")}`, baseURL);
  const response = await fetch(modelURL, {
    signal: AbortSignal.timeout(OPENROUTER_METADATA_TIMEOUT_MS),
    ...(env.OPENROUTER_API_KEY
      ? { headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}` } }
      : {}),
  });
  if (!response.ok) {
    throw new Error(`OpenRouter model metadata returned HTTP ${response.status}`);
  }
  const raw: unknown = await response.json();
  if (!raw || typeof raw !== "object" || !("data" in raw) ||
      !raw.data || typeof raw.data !== "object") {
    throw new Error("OpenRouter model metadata is missing data");
  }
  const data = raw.data as Record<string, unknown>;
  const topProvider = data.top_provider && typeof data.top_provider === "object"
    ? data.top_provider as Record<string, unknown>
    : undefined;
  const contextLength = positiveTokenCount(topProvider?.context_length) ??
    positiveTokenCount(data.context_length);
  if (!contextLength) throw new Error("OpenRouter model metadata is missing context_length");
  const maxOutput = positiveTokenCount(topProvider?.max_completion_tokens);
  // Reserve space for a response, even when the provider omits output metadata.
  const outputReserve = Math.min(
    maxOutput ?? contextLength,
    Math.max(512, Math.min(65_536, Math.floor(contextLength * 0.2))),
  );
  const limit = contextLength - outputReserve;
  if (limit < 1_024) throw new Error("Model context is too small for agent input");
  return {
    inputTokens: Math.min(limit, OPENROUTER_MAX_INPUT_TOKENS[slug] ?? limit),
    maxOutputTokens: outputReserve,
  };
};

/**
 * Discover the effective input allowance for an OpenRouter model. Other
 * providers do not consistently expose context limits, so use the local
 * catalog or a conservative fallback for them.
 */
export const resolveModelContextBudget = async (
  modelId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ModelContextBudget> => {
  const override = getEnvTokenLimitOverride(env);
  if (override) return {
    inputTokens: override,
    maxOutputTokens: Math.min(8_192, Math.max(256, Math.floor(override * 0.2))),
  };
  const slug = openRouterSlug(modelId, env);
  if (!slug) {
    const inputTokens = resolveModelInputTokenLimit(modelId, UNKNOWN_MODEL_INPUT_LIMIT, env);
    return {
      inputTokens,
      maxOutputTokens: Math.min(8_192, Math.max(256, Math.floor(inputTokens * 0.2))),
    };
  }
  const key = `${env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1"}:${slug}`;
  const cached = modelLimits.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.budget;
  let pending = pendingModelLimits.get(key);
  if (!pending) {
    pending = fetchOpenRouterInputLimit(slug, env)
      .then((budget) => {
        modelLimits.set(key, { budget, expiresAt: Date.now() + OPENROUTER_METADATA_TTL_MS });
        return budget;
      })
      .catch((error: unknown) => {
        console.warn(
          `[agent] Could not resolve context limit for OpenRouter model '${slug}':`,
          error instanceof Error ? error.message : String(error),
        );
        const inputTokens = Math.min(
          resolveModelInputTokenLimit(modelId, UNKNOWN_MODEL_INPUT_LIMIT, env),
          UNKNOWN_MODEL_INPUT_LIMIT,
        );
        const budget = {
          inputTokens,
          maxOutputTokens: Math.min(8_192, Math.max(256, Math.floor(inputTokens * 0.2))),
        };
        modelLimits.set(key, {
          budget,
          expiresAt: Date.now() + OPENROUTER_METADATA_FAILURE_TTL_MS,
        });
        return budget;
      })
      .finally(() => { pendingModelLimits.delete(key); });
    pendingModelLimits.set(key, pending);
  }
  return pending;
};

export const resolveModelInputTokenLimitAsync = async (
  modelId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> => (await resolveModelContextBudget(modelId, env)).inputTokens;

// Models known to accept image content parts at the provider/endpoint level.
// Keep this exact-match metadata in sync with selectable model metadata rather
// than inferring from provider/family substrings.
const VISION_MODEL_IDS = new Set([
  "openrouter/openai/gpt-5.3-codex",
  "openrouter/moonshotai/kimi-k2.5",
  "openrouter/moonshotai/kimi-k3",
  "openrouter/z-ai/glm-5.3-flash",
  "openrouter/google/gemini-2.5-pro",
  "openrouter/google/gemini-2.5-flash",
  "gemini-2.5-pro",
  "gemini-3-flash-preview",
  "gemini-3.1-pro-preview",
  "gemini-3.5-flash",
  "gpt-5.2",
  "gpt-5.2-codex",
  "gpt-5.3-codex",
  "gpt-5.4",
  "gpt-4o",
  "gpt-4o-mini",
  "claude-haiku-4-5",
  "claude-opus-4-8",
  "claude-fable-5",
  "claude-sonnet-4-6",
]);

const stripProviderSuffix = (modelId: string): string => {
  return modelId.endsWith("-other")
    ? modelId.slice(0, -"-other".length)
    : modelId;
};

const getVisionModelIdCandidates = (modelId: string): string[] => {
  const normalized = stripProviderSuffix((modelId || "").trim().toLowerCase());
  if (!normalized) return [];

  const candidates = new Set<string>([normalized]);

  if (normalized.startsWith("openrouter/")) {
    candidates.add(normalized.slice("openrouter/".length));
  }

  if (normalized.startsWith("openai/")) {
    candidates.add(normalized.slice("openai/".length));
  }

  if (normalized.startsWith("google/")) {
    candidates.add(normalized.slice("google/".length));
  }

  if (normalized.startsWith("anthropic/")) {
    candidates.add(normalized.slice("anthropic/".length));
  }

  if (
    normalized.includes("/") &&
    !normalized.startsWith("openrouter/") &&
    !normalized.startsWith("ollama/") &&
    !normalized.startsWith("local/") &&
    !normalized.startsWith("huggingface/")
  ) {
    candidates.add(`openrouter/${normalized}`);
  }

  return Array.from(candidates);
};

export const resolveModelSupportsVision = (modelId: string): boolean => {
  return getVisionModelIdCandidates(modelId).some((candidate) =>
    VISION_MODEL_IDS.has(candidate),
  );
};

export const resolveModelInputTokenLimit = (
  modelId: string,
  fallback = UNKNOWN_MODEL_INPUT_LIMIT,
  env: NodeJS.ProcessEnv = process.env,
): number => {
  const envOverride = getEnvTokenLimitOverride(env);
  if (envOverride) return envOverride;

  const normalized = (modelId || "").trim();
  if (MODEL_INPUT_TOKEN_LIMITS[normalized]) {
    return MODEL_INPUT_TOKEN_LIMITS[normalized];
  }

  return clamp(fallback, 4_096, 1_000_000);
};
