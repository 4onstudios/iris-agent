import { randomUUID } from "node:crypto";
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

const getServerKey = (server: Pick<McpServerConfig, "id" | "url">): string =>
  `${server.id}\n${server.url || ""}`;

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
  if (!provider) return server;

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
