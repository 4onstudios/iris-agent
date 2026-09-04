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
  // GPT-5.3 Codex sessions frequently include large tool schemas + long
  // conversation state; keep a high effective budget to avoid hard drops where
  // no message fits in the limiter window.
  "openrouter/openai/gpt-5.3-codex": 400_000,
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
  "gpt-5.3-codex": 400_000,
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

const getEnvTokenLimitOverride = (): number | null => {
  const raw = process.env.IRIS_AGENT_INPUT_TOKEN_LIMIT;
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return null;
  return clamp(parsed, 4_096, 1_000_000);
};

const inferModelLimitByPattern = (modelId: string): number | null => {
  const normalized = modelId.toLowerCase();

  if (normalized.includes("gemini") || normalized.includes("1m")) return 1_000_000;
  if (normalized.includes("claude") && normalized.includes("haiku")) return 200_000;
  if (normalized.includes("claude") && normalized.includes("sonnet")) return 1_000_000;
  if (normalized.includes("claude") && normalized.includes("opus")) return 1_000_000;
  if (normalized.includes("gpt-5.3-codex")) return 400_000;
  if (normalized.includes("gpt-5.2-codex")) return 400_000;
  if (normalized.includes("gpt-5")) return 192_000;
  if (normalized.includes("gpt-4o")) return 128_000;
  if (normalized.includes("deepseek") || normalized.includes("qwen") || normalized.includes("mistral")) return 128_000;
  if (normalized.includes("laguna")) return 64_000;

  return null;
};

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
  fallback = 64_000,
): number => {
  const envOverride = getEnvTokenLimitOverride();
  if (envOverride) return envOverride;

  const normalized = (modelId || "").trim();
  if (MODEL_INPUT_TOKEN_LIMITS[normalized]) {
    return MODEL_INPUT_TOKEN_LIMITS[normalized];
  }

  const inferred = inferModelLimitByPattern(normalized);
  if (inferred) return inferred;

  return clamp(fallback, 4_096, 1_000_000);
};
