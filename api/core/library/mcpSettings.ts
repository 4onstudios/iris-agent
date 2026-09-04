export const MCP_SERVERS_STORAGE_KEY = "settings.mcpServers";

export const MAX_MCP_SERVERS = 10;
const MAX_COMMAND_LENGTH = 300;
const MAX_NAME_LENGTH = 100;
const MAX_ARG_LENGTH = 500;
const MAX_ARGS = 40;
const MAX_ENV_VARS = 60;
const MAX_ENV_KEY_LENGTH = 120;
const MAX_ENV_VALUE_LENGTH = 2000;

export type McpServerConfig = {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
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

const getDefaultId = (index: number): string => `mcp-${Date.now()}-${index}`;

const normalizeMcpServerDraft = (
  input: unknown,
  index = 0,
): McpServerConfig | null => {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;

  const raw = input as Record<string, unknown>;
  const id = safeString(raw.id, 120) || getDefaultId(index);
  const command = safeString(raw.command, MAX_COMMAND_LENGTH);
  const name = safeString(raw.name, MAX_NAME_LENGTH) || command || "New MCP Server";

  return {
    id,
    name,
    command,
    args: sanitizeArgs(raw.args),
    env: sanitizeEnv(raw.env),
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
  const command = safeString(raw.command, MAX_COMMAND_LENGTH);
  if (!command) return null;

  const id = safeString(raw.id, 120) || getDefaultId(index);
  const name = safeString(raw.name, MAX_NAME_LENGTH) || command;

  return {
    id,
    name,
    command,
    args: sanitizeArgs(raw.args),
    env: sanitizeEnv(raw.env),
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
