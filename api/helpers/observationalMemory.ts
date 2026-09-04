export type ObservationalMemorySettingsPayload = {
  model?: string;
  scope?: "resource" | "thread";
  observationMessageTokens?: number;
  reflectionObservationTokens?: number;
  observationPreviousTokens?: number;
  activateAfterIdle?: string;
  activateOnProviderChange?: boolean;
};

const asBoundedInteger = (
  input: unknown,
  fallback: number,
  min: number,
  max: number,
): number => {
  const parsed =
    typeof input === "number"
      ? input
      : typeof input === "string"
        ? Number.parseInt(input, 10)
        : Number.NaN;

  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
};

export const sanitizeObservationalMemorySettings = (
  input: unknown,
): ObservationalMemorySettingsPayload | undefined => {
  if (!input || typeof input !== "object") {
    return undefined;
  }

  const raw = input as Record<string, unknown>;
  const model =
    typeof raw.model === "string" && raw.model.trim().length > 0
      ? raw.model.trim()
      : "google/gemini-2.5-flash";
  const scope = raw.scope === "thread" ? "thread" : "resource";
  const observationMessageTokens = asBoundedInteger(
    raw.observationMessageTokens,
    4000,
    4000,
    200000,
  );
  const reflectionObservationTokens = asBoundedInteger(
    raw.reflectionObservationTokens,
    8000,
    8000,
    400000,
  );
  const observationPreviousTokens = asBoundedInteger(
    raw.observationPreviousTokens,
    0,
    0,
    100000,
  );
  const activateAfterIdle =
    typeof raw.activateAfterIdle === "string" ? raw.activateAfterIdle.trim() : "";
  const activateOnProviderChange =
    typeof raw.activateOnProviderChange === "boolean"
      ? raw.activateOnProviderChange
      : true;

  return {
    model,
    scope,
    observationMessageTokens,
    reflectionObservationTokens,
    observationPreviousTokens,
    activateAfterIdle,
    activateOnProviderChange,
  };
};
