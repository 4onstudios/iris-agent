export const MCP_SERVERS_STORAGE_KEY = "settings.mcpServers";

export type McpRemoteTransport = "streamable-http" | "sse";

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
  transport?: McpRemoteTransport;
  headers?: Record<string, string>;
  enabled: boolean;
};

const isSafeEnvKey = (key: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
const isValidHttpHeaderName = (name: string): boolean =>
  /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name);
const isValidHttpHeaderValue = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= MAX_HEADER_LENGTH &&
  /^[\t\x20-\x7E\x80-\xFF]*$/.test(value);

const isValidHttpHeaders = (
  headers: unknown,
): headers is Record<string, string> => {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    return false;
  }

  const entries = Object.entries(headers);
  return (
    entries.length <= MAX_HEADERS &&
    entries.every(
      ([name, value]) =>
        name.length <= MAX_HEADER_LENGTH &&
        isValidHttpHeaderName(name) &&
        isValidHttpHeaderValue(value),
    )
  );
};

const hasValidHttpHeaders = (headers: unknown): boolean =>
  headers === undefined || isValidHttpHeaders(headers);

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
  if (!isValidHttpHeaders(headers)) return {};

  return Object.fromEntries(
    Object.entries(headers).slice(0, MAX_HEADERS),
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
  if (!hasValidHttpHeaders(raw.headers)) return null;
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
  const transport = raw.transport;
  if (
    url &&
    transport !== undefined &&
    transport !== "streamable-http" &&
    transport !== "sse"
  ) {
    return null;
  }
  const name = safeString(raw.name, MAX_NAME_LENGTH) || command || (url ? hostnameFromUrl(url) : "") || "New MCP Server";

  return {
    id,
    name,
    command,
    args: sanitizeArgs(raw.args),
    env: sanitizeEnv(raw.env),
    ...(url ? { url } : {}),
    ...(url ? { transport: transport === "sse" ? "sse" : "streamable-http" } : {}),
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
  if (!hasValidHttpHeaders(raw.headers)) return null;
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

  const transport = raw.transport;
  if (
    url &&
    transport !== undefined &&
    transport !== "streamable-http" &&
    transport !== "sse"
  ) {
    return null;
  }

  const id = safeString(raw.id, 120) || getDefaultId(index);
  const name = safeString(raw.name, MAX_NAME_LENGTH) || command || (url ? hostnameFromUrl(url) : "") || "MCP Server";

  return {
    id,
    name,
    command,
    args: sanitizeArgs(raw.args),
    env: sanitizeEnv(raw.env),
    ...(url ? { url } : {}),
    ...(url ? { transport: transport === "sse" ? "sse" : "streamable-http" } : {}),
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

export const parseMcpServerConfigFile = (contents: string): McpServerConfig[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`MCP config is not valid JSON: ${message}`);
  }

  let servers: unknown[];
  if (Array.isArray(parsed)) {
    servers = parsed;
  } else if (parsed && typeof parsed === "object") {
    const configuredServers = (parsed as Record<string, unknown>).mcpServers;
    if (Array.isArray(configuredServers)) {
      servers = configuredServers;
    } else if (configuredServers && typeof configuredServers === "object") {
      servers = Object.entries(configuredServers).map(([key, value]) => {
        if (!key.trim() || key !== key.trim() || key.length > MAX_NAME_LENGTH) {
          throw new Error(`MCP config has an invalid server key: "${key}"`);
        }
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          return value;
        }
        const server = value as Record<string, unknown>;
        return {
          ...server,
          id: server.id ?? key,
          name: server.name ?? key,
        };
      });
    } else {
      throw new Error(
        'MCP config must be an array or an object with a "mcpServers" array or object',
      );
    }
  } else {
    throw new Error(
      'MCP config must be an array or an object with a "mcpServers" array or object',
    );
  }
  if (servers.length > MAX_MCP_SERVERS) {
    throw new Error(`MCP config supports at most ${MAX_MCP_SERVERS} servers`);
  }

  const validatedServers: Array<{
    config: unknown;
    args?: string[];
    env?: Record<string, string>;
    headers?: Record<string, string>;
  }> = servers.map((server) => {
    if (server && typeof server === "object" && !Array.isArray(server)) {
      const config = server as Record<string, unknown>;
      const validatedConfig = { ...config };
      if ("enabled" in config && typeof config.enabled !== "boolean") {
        throw new Error('MCP config server "enabled" value must be a boolean');
      }
      if ("url" in config) {
        if (
          typeof config.url !== "string" ||
          !config.url.trim() ||
          config.url.length > MAX_URL_LENGTH
        ) {
          throw new Error(
            'MCP config server "url" must be a non-empty string',
          );
        }
      }
      if ("command" in config) {
        if (typeof config.command !== "string" || !config.command.trim()) {
          throw new Error(
            'MCP config server "command" must be a non-empty string',
          );
        }
        if (config.command !== config.command.trim()) {
          throw new Error(
            'MCP config server "command" cannot have surrounding whitespace',
          );
        }
        if (config.command.length > MAX_COMMAND_LENGTH) {
          throw new Error(
            `MCP config server "command" exceeds ${MAX_COMMAND_LENGTH} characters`,
          );
        }
      }

      let args: string[] | undefined;
      if ("args" in config) {
        if (!Array.isArray(config.args)) {
          throw new Error(
            'MCP config server "args" must be an array of strings',
          );
        }
        if (config.args.length > MAX_ARGS) {
          throw new Error(
            `MCP config server "args" supports at most ${MAX_ARGS} values`,
          );
        }
        args = config.args.map((argument) => {
          if (typeof argument !== "string") {
            throw new Error(
              'MCP config server "args" must contain only strings',
            );
          }
          if (argument.length > MAX_ARG_LENGTH) {
            throw new Error(
              `MCP config server arguments cannot exceed ${MAX_ARG_LENGTH} characters`,
            );
          }
          return argument;
        });
        validatedConfig.args = args;
      }

      let env: Record<string, string> | undefined;
      if ("env" in config) {
        if (
          !config.env ||
          typeof config.env !== "object" ||
          Array.isArray(config.env)
        ) {
          throw new Error('MCP config server "env" must be an object of strings');
        }
        const entries = Object.entries(config.env);
        if (entries.length > MAX_ENV_VARS) {
          throw new Error(
            `MCP config server "env" supports at most ${MAX_ENV_VARS} values`,
          );
        }
        env = Object.fromEntries(
          entries.map(([key, value]) => {
            if (
              key.length > MAX_ENV_KEY_LENGTH ||
              !isSafeEnvKey(key) ||
              typeof value !== "string" ||
              value.length > MAX_ENV_VALUE_LENGTH
            ) {
              throw new Error(
                'MCP config server "env" contains an invalid key or value',
              );
            }
            return [key, value];
          }),
        );
        validatedConfig.env = env;
      }

      let headers: Record<string, string> | undefined;
      if ("headers" in config) {
        if (
          !config.headers ||
          typeof config.headers !== "object" ||
          Array.isArray(config.headers)
        ) {
          throw new Error(
            'MCP config server "headers" must be an object of strings',
          );
        }
        const entries = Object.entries(config.headers);
        if (entries.length > MAX_HEADERS) {
          throw new Error(
            `MCP config server "headers" supports at most ${MAX_HEADERS} values`,
          );
        }
        headers = Object.fromEntries(
          entries.map(([key, value]) => {
            if (
              key.length > MAX_HEADER_LENGTH ||
              !isValidHttpHeaderName(key) ||
              !isValidHttpHeaderValue(value)
            ) {
              throw new Error(
                'MCP config server "headers" contains an invalid key or value',
              );
            }
            return [key, value];
          }),
        );
        validatedConfig.headers = headers;
      }

      return { config: validatedConfig, args, env, headers };
    }
    return { config: server };
  });

  const sanitizedServers = sanitizeMcpServers(
    validatedServers.map(({ config }) => config),
  );
  if (sanitizedServers.length !== servers.length) {
    throw new Error("MCP config contains an invalid server entry");
  }
  return sanitizedServers.map((server, index) => ({
    ...server,
    ...(validatedServers[index].args !== undefined
      ? { args: validatedServers[index].args }
      : {}),
    ...(validatedServers[index].env !== undefined
      ? { env: validatedServers[index].env }
      : {}),
    ...(validatedServers[index].headers !== undefined
      ? { headers: validatedServers[index].headers }
      : {}),
  }));
};

export const toStableMcpFingerprint = (servers: McpServerConfig[]): string => {
  const normalized = servers
    .map((server) => ({
      id: server.id,
      name: server.name,
      command: server.command,
      args: [...server.args],
      transport: server.transport,
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
