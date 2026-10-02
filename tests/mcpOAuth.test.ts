const mockListTools = jest.fn(async () => ({
  tools: [{ name: "search_boards", description: "Search Miro boards" }],
}));
const mockClientClose = jest.fn(async () => undefined);

jest.mock("@modelcontextprotocol/sdk/client/auth.js", () => ({
  auth: jest.fn(),
}));

jest.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: jest.fn().mockImplementation(() => ({
    connect: jest.fn(async () => undefined),
    listTools: mockListTools,
    close: mockClientClose,
  })),
}));

jest.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: jest.fn(),
}));

import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  completeMcpOAuth,
  getMcpOAuthFlow,
  resolveMcpOAuthServer,
  startMcpOAuth,
} from "../api/core/agent/tools/mcpOAuth";
import { sanitizeMcpServer } from "../api/core/library/mcpSettings";

describe("remote MCP OAuth", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(auth).mockImplementation(async (provider, options) => {
      if (options.authorizationCode) {
        await provider.saveTokens({
          access_token: "miro-access-token",
          refresh_token: "miro-refresh-token",
          token_type: "Bearer",
        });
        return "AUTHORIZED";
      }

      if (!(await provider.tokens())) {
        await provider.saveCodeVerifier("pkce-verifier");
        await provider.redirectToAuthorization(
          new URL("https://miro.example/authorize?state=test"),
        );
        return "REDIRECT";
      }

      return "AUTHORIZED";
    });
  });

  it("completes authorization, discovers tools, and resolves credentials inside iris-agent", async () => {
    const server = sanitizeMcpServer({
      id: "miro",
      name: "Miro",
      url: "https://mcp.miro.com/",
      headers: { "X-Workspace": "team-1", authorization: "old-value" },
    });
    if (!server) throw new Error("Expected Miro config to be valid");

    const flow = await startMcpOAuth(
      server,
      "http://127.0.0.1:1234/api/agent/mcp/oauth/callback",
    );
    const provider = jest.mocked(auth).mock.calls[0][0];
    const state = await provider.state?.();
    if (!state) throw new Error("Expected OAuth state to be available");

    expect(flow.authorizationUrl).toBe("https://miro.example/authorize?state=test");
    expect(state).toEqual(expect.any(String));

    await completeMcpOAuth({ state, code: "authorization-code" });

    expect(getMcpOAuthFlow(flow.flowId)).toEqual({
      status: "connected",
      tools: [{ name: "search_boards", description: "Search Miro boards" }],
    });
    const authenticatedServer = await resolveMcpOAuthServer(server);
    expect(authenticatedServer.headers).toMatchObject({
      "X-Workspace": "team-1",
      Authorization: expect.stringMatching(/^Bearer /),
    });
    expect(authenticatedServer.headers).not.toHaveProperty("authorization");
    expect(mockListTools).toHaveBeenCalledTimes(1);
    expect(mockClientClose).toHaveBeenCalledTimes(1);
  });
});
