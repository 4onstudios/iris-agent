export const API_KEYS_STORAGE_KEY = "settings.apiKeys";
export const DEFAULT_LOCAL_RUNTIME_BASE_URL = "http://127.0.0.1:11434/v1";
export const DEFAULT_LOCAL_RUNTIME_API_KEY = "ollama";

// Cache for health check results to avoid repeated probes.
// Keyed by normalized baseUrl + a non-reversible fingerprint of apiKey.
// This avoids storing raw secrets in memory while preventing cache collisions
// across different keys for the same endpoint.
const HEALTH_CHECK_CACHE = new Map<
  string,
  { result: LocalRuntimeHealthResult; timestamp: number }
>();
const HEALTH_CHECK_CACHE_MAX_SIZE = 8; // evict oldest entry when exceeded
const HEALTH_CHECK_TTL_MS = 60000; // Cache for 60 seconds
const HEALTH_CHECK_FAILED_TTL_MS = 5000; // Cache failures for 5 seconds only
const HEALTH_CHECK_TIMEOUT_MS = 1500; // 1500ms balances cold-start tolerance vs. latency

export type LocalRuntimeHealthResult = {
  ok: boolean;
  message: string;
  probeUrl: string;
  /** True when the probe was aborted due to timeout (as opposed to a hard connection error). */
  timedOut?: boolean;
};

export const isLocalModelId = (modelId: string): boolean =>
  modelId.startsWith("ollama/") || modelId.startsWith("local/");

const trimTrailingSlash = (value: string): string => value.replace(/\/$/, "");

// Produces a short, non-reversible fingerprint of the API key so that cache
// entries for different keys on the same baseUrl are not conflated, without
// retaining the raw secret in the Map key.
const fingerprintApiKey = (apiKey?: string): string => {
  if (!apiKey) return "";
  let hash = 5381;
  for (let i = 0; i < apiKey.length; i++) {
    hash = (((hash << 5) + hash) ^ apiKey.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
};

const normalizeBaseUrl = (value?: string): string => {
  const trimmed = (value || "").trim();
  if (!trimmed) return DEFAULT_LOCAL_RUNTIME_BASE_URL;
  const candidate = trimTrailingSlash(trimmed);
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return DEFAULT_LOCAL_RUNTIME_BASE_URL;
    }
    return candidate;
  } catch {
    return DEFAULT_LOCAL_RUNTIME_BASE_URL;
  }
};

const buildProbeUrl = (baseUrl: string): string => {
  const normalized = normalizeBaseUrl(baseUrl);
  return `${normalized}/models`;
};

export const getLocalRuntimeConfigFromStorage = (): {
  baseUrl: string;
  apiKey: string;
} => {
  if (typeof window === "undefined") {
    return {
      baseUrl: DEFAULT_LOCAL_RUNTIME_BASE_URL,
      apiKey: DEFAULT_LOCAL_RUNTIME_API_KEY,
    };
  }

  try {
    const raw = localStorage.getItem(API_KEYS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return {
      baseUrl: normalizeBaseUrl(parsed?.OLLAMA_BASE_URL),
      apiKey: (parsed?.OLLAMA_API_KEY || DEFAULT_LOCAL_RUNTIME_API_KEY).trim(),
    };
  } catch {
    return {
      baseUrl: DEFAULT_LOCAL_RUNTIME_BASE_URL,
      apiKey: DEFAULT_LOCAL_RUNTIME_API_KEY,
    };
  }
};

export const checkLocalRuntimeConnection = async (
  baseUrl: string,
  apiKey?: string,
  timeoutMs = 3000,
): Promise<LocalRuntimeHealthResult> => {
  const probeUrl = buildProbeUrl(baseUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = {};
    if (apiKey && apiKey.trim().length > 0) {
      headers.Authorization = `Bearer ${apiKey.trim()}`;
    }

    const res = await fetch(probeUrl, {
      method: "GET",
      headers,
      signal: controller.signal,
    });

    if (!res.ok) {
      return {
        ok: false,
        message: `Runtime responded with HTTP ${res.status}`,
        probeUrl,
      };
    }

    const payload = (await res.json().catch(() => ({}))) as { data?: unknown[] };
    const modelCount = Array.isArray(payload?.data) ? payload.data.length : undefined;

    return {
      ok: true,
      message: modelCount !== undefined ? `Connected (${modelCount} model${modelCount === 1 ? "" : "s"} available)` : "Connected",
      probeUrl,
    };
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "AbortError";
    const message = timedOut ? "Connection timed out" : err instanceof Error ? err.message : "Connection failed";
    return {
      ok: false,
      message,
      probeUrl,
      timedOut,
    };
  } finally {
    clearTimeout(timeout);
  }
};

/**
 * Check local runtime connection with built-in caching to avoid repeated probes.
 * Uses a short TTL (60s for successful, 5s for failed) to prevent latency regressions
 * during repeated chat invocations while still allowing quick error recovery.
 * All probes use HEALTH_CHECK_TIMEOUT_MS regardless of host.
 */
export const checkLocalRuntimeConnectionCached = async (
  baseUrl: string,
  apiKey?: string,
): Promise<LocalRuntimeHealthResult> => {
  const cacheKey = `${normalizeBaseUrl(baseUrl)}:${fingerprintApiKey(apiKey)}`;
  const cached = HEALTH_CHECK_CACHE.get(cacheKey);

  // Return cached result if still valid
  if (cached) {
    const age = Date.now() - cached.timestamp;
    const ttl = cached.result.ok ? HEALTH_CHECK_TTL_MS : HEALTH_CHECK_FAILED_TTL_MS;
    if (age < ttl) {
      return cached.result;
    }
  }

  // Cache miss or expired - perform fresh check
  const result = await checkLocalRuntimeConnection(
    baseUrl,
    apiKey,
    HEALTH_CHECK_TIMEOUT_MS,
  );

  // Don't cache timeout failures — the runtime may just be slow to start;
  // the next invocation should retry immediately rather than hitting a stale negative.
  if (!result.timedOut) {
    // Evict the oldest entry before inserting when the cache is at capacity.
    if (!HEALTH_CHECK_CACHE.has(cacheKey) && HEALTH_CHECK_CACHE.size >= HEALTH_CHECK_CACHE_MAX_SIZE) {
      const oldestKey = HEALTH_CHECK_CACHE.keys().next().value;
      if (oldestKey !== undefined) {
        HEALTH_CHECK_CACHE.delete(oldestKey);
      }
    }
    HEALTH_CHECK_CACHE.set(cacheKey, { result, timestamp: Date.now() });
  }

  return result;
};
