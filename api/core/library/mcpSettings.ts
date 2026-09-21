export const MCP_SERVERS_STORAGE_KEY = "settings.mcpServers";

export const MAX_MCP_SERVERS = 10;
const MAX_COMMAND_LENGTH = 300;
const MAX_NAME_LENGTH = 100;
const MAX_ARG_LENGTH = 500;
const MAX_ARGS = 40;
const MAX_ENV_VARS = 60;
const MAX_ENV_KEY_LENGTH = 120;
const MAX_ENV_VALUE_LENGTH = 2000;
const MAX_URL_LENGTH = 2000;
const MAX_HEADERS = 60;
const MAX_HEADER_LENGTH = 2000;

export type McpServerConfig = {
  id: string;
  name: string;
  command?: string;
  args: string[];
  env: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled: boolean;
};

const isSafeEnvKey = (key: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);

const splitCommandString = (value: string): string[] => {
  const parts: string[] = [];
  const regex = /[^\s"']+|"([^"]*)"|'([^']*)'/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(value)) !== null) {
    parts.push(match[1] ?? match[2] ?? match[0]);
  }

  return parts;
};

export const normalizeMcpServerCommandLine = (
  command: string,
  args: string[],
): { command: string; args: string[] } => {
  const normalizedCommand = command.trim();
  const tokens = splitCommandString(normalizedCommand);
  if (tokens.length === 0) {
    return { command: normalizedCommand, args: [...args] };
  }

  return {
    command: tokens[0],
    args: [...tokens.slice(1), ...args],
  };
};

const safeString = (value: unknown, maxLength: number): string =>
  typeof value === "string" ? value.trim().slice(0, maxLength) : "";

const sanitizeArgs = (args: unknown): string[] => {
  if (!Array.isArray(args)) return [];
  return args
    .map((entry) => safeString(entry, MAX_ARG_LENGTH))
    .filter(Boolean)
    .slice(0, MAX_ARGS);
};

const sanitizeEnv = (env: unknown): Record<string, string> => {
  if (!env || typeof env !== "object" || Array.isArray(env)) return {};

  const entries = Object.entries(env)
    .map(([key, value]) => [safeString(key, MAX_ENV_KEY_LENGTH), safeString(value, MAX_ENV_VALUE_LENGTH)] as const)
    .filter(([key]) => key.length > 0 && isSafeEnvKey(key))
    .slice(0, MAX_ENV_VARS);

  return Object.fromEntries(entries);
};

const sanitizeHeaders = (headers: unknown): Record<string, string> => {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return {};

  return Object.fromEntries(
    Object.entries(headers)
      .map(([key, value]) => [
        safeString(key, MAX_HEADER_LENGTH),
        safeString(value, MAX_HEADER_LENGTH),
      ] as const)
      .filter(([key, value]) => key.length > 0 && value.length > 0)
      .slice(0, MAX_HEADERS),
  );
};

const sanitizeUrl = (value: unknown): string | undefined => {
  const url = safeString(value, MAX_URL_LENGTH);
  if (!url) return undefined;

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
};

/**
 * Produces a credential-safe version of a remote MCP server URL for use in
 * model-facing tool descriptions, generated docs, and logs. Strips any
 * userinfo (`user:pass@`) and query string/fragment, since those commonly
 * carry API keys or tokens (e.g. `?api_key=...`, `?access_token=...`). The
 * raw `server.url` (with headers/query intact) must still be used for the
 * actual transport connection - only use this for anything surfaced outside
 * the server-side process.
 */
export const redactMcpUrlForDisplay = (url: string): string => {
  try {
    const parsed = new URL(url);
    const hadSensitiveParts =
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0;
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    const base = parsed.toString();
    return hadSensitiveParts ? `${base} (redacted)` : base;
  } catch {
    return url;
  }
};

/**
 * Derives a credential-free default display name for a remote server from
 * its URL - just the hostname, e.g. "example.com". Used only when the user
 * hasn't supplied a `name`; falling back to the full URL here would persist
 * (and later surface in model-facing tool identifiers/descriptions) any
 * credentials embedded in the URL's userinfo or query string.
 */
const hostnameFromUrl = (url: string): string => {
  try {
    return new URL(url).hostname || "MCP Server";
  } catch {
    return "MCP Server";
  }
};

const getDefaultId = (index: number): string => `mcp-${Date.now()}-${index}`;

const normalizeMcpServerDraft = (
  input: unknown,
  index = 0,
): McpServerConfig | null => {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;

  const raw = input as Record<string, unknown>;
  const id = safeString(raw.id, 120) || getDefaultId(index);
  const hasUrlInput = typeof raw.url === "string" && raw.url.trim().length > 0;
  const url = sanitizeUrl(raw.url);
  // A non-empty url that fails sanitization is a malformed/unsupported
  // remote endpoint, not "no url" - reject the whole draft rather than
  // silently falling back to a stale `command` and switching transport
  // modes underneath the user (a saved remote config could otherwise turn
  // into a local process launch).
  if (hasUrlInput && !url) return null;
  // A server config connects via exactly one transport. When both a command
  // and a URL are supplied, `connectClient` silently prefers the URL, so
  // drop the stale/ambiguous `command` here rather than keep it around
  // unused and unvalidated.
  const command = url ? "" : safeString(raw.command, MAX_COMMAND_LENGTH);
  const name = safeString(raw.name, MAX_NAME_LENGTH) || command || (url ? hostnameFromUrl(url) : "") || "New MCP Server";

  return {
    id,
    name,
    command,
    args: sanitizeArgs(raw.args),
    env: sanitizeEnv(raw.env),
    ...(url ? { url } : {}),
    ...(Object.keys(sanitizeHeaders(raw.headers)).length > 0
      ? { headers: sanitizeHeaders(raw.headers) }
      : {}),
    enabled: raw.enabled !== false,
  };
};

const normalizeMcpServerDrafts = (
  input: unknown,
  maxServers = MAX_MCP_SERVERS,
): McpServerConfig[] => {
  if (!Array.isArray(input)) return [];

  return input
    .map((entry, index) => normalizeMcpServerDraft(entry, index))
    .filter((entry): entry is McpServerConfig => entry !== null)
    .slice(0, maxServers);
};

export const sanitizeMcpServer = (input: unknown, index = 0): McpServerConfig | null => {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;

  const raw = input as Record<string, unknown>;
  const hasUrlInput = typeof raw.url === "string" && raw.url.trim().length > 0;
  const url = sanitizeUrl(raw.url);
  // A non-empty url that fails sanitization is malformed/unsupported, not
  // "no url" - reject rather than silently falling back to a stale
  // `command` and switching transport modes underneath the user.
  if (hasUrlInput && !url) return null;
  // See normalizeMcpServerDraft: exactly one transport is allowed, so a
  // supplied URL always wins over a stale/ambiguous command.
  const command = url ? "" : safeString(raw.command, MAX_COMMAND_LENGTH);
  if (!command && !url) return null;

  const id = safeString(raw.id, 120) || getDefaultId(index);
  const name = safeString(raw.name, MAX_NAME_LENGTH) || command || (url ? hostnameFromUrl(url) : "") || "MCP Server";

  return {
    id,
    name,
    command,
    args: sanitizeArgs(raw.args),
    env: sanitizeEnv(raw.env),
    ...(url ? { url } : {}),
    ...(Object.keys(sanitizeHeaders(raw.headers)).length > 0
      ? { headers: sanitizeHeaders(raw.headers) }
      : {}),
    enabled: raw.enabled !== false,
  };
};

export const sanitizeMcpServers = (
  input: unknown,
  maxServers = MAX_MCP_SERVERS,
): McpServerConfig[] => {
  if (!Array.isArray(input)) return [];

  return input
    .map((entry, index) => sanitizeMcpServer(entry, index))
    .filter((entry): entry is McpServerConfig => entry !== null)
    .slice(0, maxServers);
};

export const toStableMcpFingerprint = (servers: McpServerConfig[]): string => {
  const normalized = servers
    .map((server) => ({
      id: server.id,
      name: server.name,
      command: server.command,
      args: [...server.args],
      env: Object.fromEntries(Object.entries(server.env).sort(([a], [b]) => a.localeCompare(b))),
      url: server.url,
      headers: Object.fromEntries(
        Object.entries(server.headers || {}).sort(([a], [b]) => a.localeCompare(b)),
      ),
      enabled: server.enabled,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return JSON.stringify(normalized);
};

export const loadMcpServersFromStorage = (): McpServerConfig[] => {
  if (typeof window === "undefined") return [];

  try {
    const raw = localStorage.getItem(MCP_SERVERS_STORAGE_KEY);
    if (!raw) return [];
    return normalizeMcpServerDrafts(JSON.parse(raw));
  } catch {
    return [];
  }
};

export const saveMcpServersToStorage = (servers: McpServerConfig[]): void => {
  if (typeof window === "undefined") return;
  localStorage.setItem(
    MCP_SERVERS_STORAGE_KEY,
    JSON.stringify(normalizeMcpServerDrafts(servers)),
  );
};

export const getEnabledMcpServersFromStorage = (): McpServerConfig[] =>
  sanitizeMcpServers(loadMcpServersFromStorage().filter((server) => server.enabled));
