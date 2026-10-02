import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  auth,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerConfig } from "../../library/mcpSettings";

export type McpOAuthTool = {
  name: string;
  description?: string;
};

export class McpOAuthReconnectRequiredError extends Error {
  constructor(serverName: string) {
    super(
      `MCP authorization for "${serverName}" must be reconnected after restart. Reconnect the server in Settings.`,
    );
    this.name = "McpOAuthReconnectRequiredError";
  }
}

type McpOAuthFlow = {
  id: string;
  state: string;
  server: McpServerConfig;
  provider: OAuthClientProvider;
  status: "waiting" | "connecting" | "connected" | "error";
  error?: string;
  tools?: McpOAuthTool[];
  createdAt: number;
};

const flowsById = new Map<string, McpOAuthFlow>();
const flowsByState = new Map<string, McpOAuthFlow>();
const providersByServer = new Map<string, OAuthClientProvider>();
const FLOW_TTL_MS = 10 * 60 * 1000;
const getOAuthStatePath = (): string =>
  path.join(
    process.env.HOME || process.env.USERPROFILE || os.homedir(),
    ".iris",
    "mcp-oauth",
    "reconnect-required.json",
  );
type ReconnectRequiredState = { version: 1; serverKeys: string[] };
let persistenceQueue: Promise<void> = Promise.resolve();

const getServerKey = (server: Pick<McpServerConfig, "id" | "url">): string =>
  `${server.id}\n${server.url || ""}`;

const getPersistedServerKey = (server: Pick<McpServerConfig, "id" | "url">): string =>
  createHash("sha256").update(getServerKey(server)).digest("hex");

const readReconnectRequiredState = async (): Promise<ReconnectRequiredState> => {
  try {
    const content = await readFile(getOAuthStatePath(), "utf8");
    const parsed: unknown = JSON.parse(content);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !("version" in parsed) ||
      parsed.version !== 1 ||
      !("serverKeys" in parsed) ||
      !Array.isArray(parsed.serverKeys) ||
      parsed.serverKeys.some((key) => typeof key !== "string")
    ) {
      throw new Error("MCP OAuth reconnect state has an invalid format.");
    }
    return parsed as ReconnectRequiredState;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { version: 1, serverKeys: [] };
    }
    throw error;
  }
};

const persistReconnectRequiredState = async (
  server: Pick<McpServerConfig, "id" | "url">,
): Promise<void> => {
  const operation = persistenceQueue.then(async () => {
    const existing = await readReconnectRequiredState();
    const serverKeys = new Set(existing.serverKeys);
    serverKeys.add(getPersistedServerKey(server));
    const statePath = getOAuthStatePath();
    const directory = path.dirname(statePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${statePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(
        temporaryPath,
        JSON.stringify({ version: 1, serverKeys: [...serverKeys] }),
        { encoding: "utf8", mode: 0o600, flag: "wx" },
      );
      await rename(temporaryPath, statePath);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  });
  persistenceQueue = operation.then(() => undefined, () => undefined);
  await operation;
};

const requiresReconnect = async (
  server: Pick<McpServerConfig, "id" | "url">,
): Promise<boolean> => {
  const state = await readReconnectRequiredState();
  return state.serverKeys.includes(getPersistedServerKey(server));
};

const pruneExpiredFlows = (): void => {
  const expiredBefore = Date.now() - FLOW_TTL_MS;
  for (const flow of flowsById.values()) {
    if (flow.createdAt < expiredBefore) {
      flowsById.delete(flow.id);
      flowsByState.delete(flow.state);
    }
  }
};

export const startMcpOAuth = async (
  server: McpServerConfig,
  redirectUrl: string,
): Promise<{ flowId: string; authorizationUrl: string }> => {
  if (!server.url) throw new Error("A remote MCP URL is required.");
  pruneExpiredFlows();

  const state = randomUUID();
  const flowId = randomUUID();
  const clientMetadata: OAuthClientMetadata = {
    redirect_uris: [redirectUrl],
    token_endpoint_auth_method: "client_secret_post",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    client_name: "Iris",
  };

  let clientInformation: OAuthClientInformationMixed | undefined;
  let tokens: OAuthTokens | undefined;
  let codeVerifier: string | undefined;
  let discoveryState: OAuthDiscoveryState | undefined;
  let authorizationUrl: URL | undefined;
  const provider: OAuthClientProvider = {
    get redirectUrl() {
      return redirectUrl;
    },
    get clientMetadata() {
      return clientMetadata;
    },
    state: () => state,
    clientInformation: () => clientInformation,
    saveClientInformation: (value) => {
      clientInformation = value;
    },
    tokens: () => tokens,
    saveTokens: (value) => {
      tokens = value;
    },
    redirectToAuthorization: (url) => {
      authorizationUrl = url;
    },
    saveCodeVerifier: (value) => {
      codeVerifier = value;
    },
    codeVerifier: () => {
      if (!codeVerifier) throw new Error("OAuth code verifier is unavailable.");
      return codeVerifier;
    },
    saveDiscoveryState: (value) => {
      discoveryState = value;
    },
    discoveryState: () => discoveryState,
  };

  const flow: McpOAuthFlow = {
    id: flowId,
    state,
    server,
    provider,
    status: "waiting",
    createdAt: Date.now(),
  };
  flowsById.set(flow.id, flow);
  flowsByState.set(flow.state, flow);

  try {
    const result = await auth(provider, { serverUrl: server.url });
    if (result !== "REDIRECT" || !authorizationUrl) {
      throw new Error("The MCP server did not start an interactive OAuth flow.");
    }
  } catch (error) {
    flowsById.delete(flow.id);
    flowsByState.delete(flow.state);
    throw error;
  }

  return { flowId, authorizationUrl: authorizationUrl.toString() };
};

export const completeMcpOAuth = async ({
  state,
  code,
  error,
}: {
  state: string;
  code?: string;
  error?: string;
}): Promise<void> => {
  pruneExpiredFlows();
  const flow = flowsByState.get(state);
  if (!flow) throw new Error("OAuth state is invalid or has expired.");
  if (flow.status !== "waiting") throw new Error("This OAuth flow has already been used.");

  flow.status = "connecting";
  try {
    if (error) throw new Error(`Authorization was denied: ${error}`);
    if (!code) throw new Error("The authorization server did not return an authorization code.");
    if (!flow.server.url) throw new Error("The remote MCP URL is missing.");

    const result = await auth(flow.provider, {
      serverUrl: flow.server.url,
      authorizationCode: code,
    });
    if (result !== "AUTHORIZED") throw new Error("OAuth authorization did not complete.");

    const client = new Client({ name: "iris-agent", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(flow.server.url), {
      authProvider: flow.provider,
      requestInit: { headers: flow.server.headers || {} },
    });
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      flow.tools = listed.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
      }));
    } finally {
      await client.close();
    }

    const tokens = await flow.provider.tokens();
    if (!tokens?.access_token) throw new Error("OAuth completed without an access token.");
    await persistReconnectRequiredState(flow.server);
    flow.status = "connected";
    providersByServer.set(getServerKey(flow.server), flow.provider);
  } catch (caught) {
    flow.error = caught instanceof Error ? caught.message : String(caught);
    flow.status = "error";
  }
};

export const getMcpOAuthFlow = (
  flowId: string,
): Pick<McpOAuthFlow, "status" | "error" | "tools"> | undefined => {
  pruneExpiredFlows();
  const flow = flowsById.get(flowId);
  if (!flow) return undefined;
  return { status: flow.status, error: flow.error, tools: flow.tools };
};

export const resolveMcpOAuthServer = async (
  server: McpServerConfig,
): Promise<McpServerConfig> => {
  if (!server.url) return server;
  const provider = providersByServer.get(getServerKey(server));
  if (!provider) {
    if (await requiresReconnect(server)) {
      throw new McpOAuthReconnectRequiredError(server.name);
    }
    return server;
  }

  const result = await auth(provider, { serverUrl: server.url });
  if (result !== "AUTHORIZED") {
    throw new Error(
      `MCP authorization expired for "${server.name}". Reconnect the server in Settings.`,
    );
  }
  const tokens = await provider.tokens();
  if (!tokens?.access_token) {
    throw new Error(
      `MCP authorization is missing for "${server.name}". Reconnect the server in Settings.`,
    );
  }

  const headers = { ...(server.headers || {}) };
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === "authorization") delete headers[key];
  }
  headers.Authorization = `Bearer ${tokens.access_token}`;
  return { ...server, headers };
};
