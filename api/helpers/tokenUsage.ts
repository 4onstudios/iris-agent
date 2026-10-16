import type { ModelContextBudget } from "./modelTokenLimits";

export type TokenUsageSummary = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type ContextWindowStats = {
  contextWindowTokens: number;
  inputLimitTokens: number;
  outputLimitTokens: number;
  inputTokens?: number;
  outputTokens?: number;
  usedTokens?: number;
  remainingTokens?: number;
  utilizationPercent?: number;
};

export const buildContextWindowStats = (
  budget: ModelContextBudget,
  usage: TokenUsageSummary | undefined,
): ContextWindowStats => {
  const usedTokens = usage?.totalTokens ??
    (usage?.inputTokens !== undefined && usage.outputTokens !== undefined
      ? usage.inputTokens + usage.outputTokens
      : undefined);

  return {
    contextWindowTokens: budget.contextWindowTokens,
    inputLimitTokens: budget.inputTokens,
    outputLimitTokens: budget.maxOutputTokens,
    ...(usage?.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
    ...(usage?.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
    ...(usedTokens !== undefined
      ? {
          usedTokens,
          remainingTokens: Math.max(0, budget.contextWindowTokens - usedTokens),
          utilizationPercent: Math.min(
            100,
            Math.round((usedTokens / budget.contextWindowTokens) * 100),
          ),
        }
      : {}),
  };
};

const asFiniteNonNegativeInt = (value: unknown): number | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  if (value < 0) {
    return undefined;
  }

  return Math.round(value);
};

export const normalizeTokenUsage = (raw: unknown): TokenUsageSummary | undefined => {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }

  const record = raw as Record<string, unknown>;

  const inputTokens =
    asFiniteNonNegativeInt(record.inputTokens) ??
    asFiniteNonNegativeInt(record.promptTokens) ??
    asFiniteNonNegativeInt(record.prompt_tokens);
  const outputTokens =
    asFiniteNonNegativeInt(record.outputTokens) ??
    asFiniteNonNegativeInt(record.completionTokens) ??
    asFiniteNonNegativeInt(record.completion_tokens);

  let totalTokens =
    asFiniteNonNegativeInt(record.totalTokens) ??
    asFiniteNonNegativeInt(record.total_tokens);

  if (totalTokens === undefined && inputTokens !== undefined && outputTokens !== undefined) {
    totalTokens = inputTokens + outputTokens;
  }

  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
    return undefined;
  }

  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
};

export const mergeTokenUsage = (
  base: TokenUsageSummary | undefined,
  incoming: TokenUsageSummary | undefined,
): TokenUsageSummary | undefined => {
  if (!base && !incoming) {
    return undefined;
  }

  return {
    ...(base || {}),
    ...(incoming || {}),
  };
};

export const extractTokenUsageFromChunkPayload = (
  payload: unknown,
): TokenUsageSummary | undefined => {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const payloadRecord = payload as Record<string, unknown>;
  const nested = normalizeTokenUsage(payloadRecord.usage);
  if (nested) {
    return nested;
  }

  return normalizeTokenUsage(payload);
};

export const isTokenUsageSourceDebugEnabled = (): boolean => {
  const raw = process.env.IRIS_DEBUG_TOKEN_USAGE_SOURCE;
  if (!raw) {
    return false;
  }

  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
};

export const logTokenUsageSource = ({
  mode,
  source,
  usage,
  modelId,
}: {
  mode: "stream" | "non_stream";
  source: "final" | "stream" | "none";
  usage: TokenUsageSummary | undefined;
  modelId: string;
}): void => {
  if (!isTokenUsageSourceDebugEnabled()) {
    return;
  }

  console.log("📊 Token usage source", {
    mode,
    source,
    modelId,
    usage,
  });
};

export const buildTokenUsageDebug = ({
  mode,
  source,
}: {
  mode: "stream" | "non_stream";
  source: "final" | "stream" | "none";
}): Record<string, unknown> | undefined => {
  if (!isTokenUsageSourceDebugEnabled()) {
    return undefined;
  }

  return {
    mode,
    source,
  };
};
