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
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  completeMcpOAuth,
  getMcpOAuthFlow,
  resolveMcpOAuthServer,
  startMcpOAuth,
} from "../api/core/agent/tools/mcpOAuth";
import { sanitizeMcpServer } from "../api/core/library/mcpSettings";

describe("remote MCP OAuth", () => {
  let originalHome: string | undefined;
  let testHome: string;

  beforeEach(async () => {
    originalHome = process.env.HOME;
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "iris-mcp-oauth-"));
    process.env.HOME = testHome;
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

  afterEach(async () => {
    jest.restoreAllMocks();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await fs.rm(testHome, { recursive: true, force: true });
  });

  it("completes OAuth without forwarding configured authorization headers", async () => {
    const configuredHeaders = {
      "X-Workspace": "team-1",
      authorization: "old-value",
      Authorization: "old-value",
      AUTHORIZATION: "old-value",
      aUtHoRiZaTiOn: "old-value",
    };
    const server = sanitizeMcpServer({
      id: "miro",
      name: "Miro",
      url: "https://mcp.miro.com/",
      headers: configuredHeaders,
    });
    if (!server?.url) throw new Error("Expected Miro config to be valid");

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

    expect(StreamableHTTPClientTransport).toHaveBeenCalledWith(
      new URL(server.url),
      {
        authProvider: provider,
        requestInit: { headers: { "X-Workspace": "team-1" } },
      },
    );
    expect(server.headers).toEqual(configuredHeaders);
    expect(getMcpOAuthFlow(flow.flowId)).toEqual({
      status: "connected",
      tools: [{ name: "search_boards", description: "Search Miro boards" }],
    });
    const authenticatedServer = await resolveMcpOAuthServer(server);
    expect(authenticatedServer.headers).toMatchObject({
      "X-Workspace": "team-1",
      Authorization: expect.stringMatching(/^Bearer /),
    });
    expect(
      Object.keys(authenticatedServer.headers || {}).filter(
        (key) => key.toLowerCase() === "authorization",
      ),
    ).toEqual(["Authorization"]);
    expect(mockListTools).toHaveBeenCalledTimes(1);
    expect(mockClientClose).toHaveBeenCalledTimes(1);
  });

  it("requires reconnect after restart without persisting OAuth credentials", async () => {
    const server = sanitizeMcpServer({
      id: "restart-test",
      name: "Restart test",
      url: "https://mcp.example.com/",
    });
    if (!server) throw new Error("Expected MCP config to be valid");

    const flow = await startMcpOAuth(
      server,
      "http://127.0.0.1:1234/api/agent/mcp/oauth/callback",
    );
    const provider = jest.mocked(auth).mock.calls[0][0];
    const state = await provider.state?.();
    if (!state) throw new Error("Expected OAuth state to be available");
    await completeMcpOAuth({ state, code: "authorization-code" });

    expect(getMcpOAuthFlow(flow.flowId)).toMatchObject({ status: "connected" });
    const persistedState = await fs.readFile(
      path.join(testHome, ".iris", "mcp-oauth", "reconnect-required.json"),
      "utf8",
    );
    expect(persistedState).not.toContain("miro-access-token");
    expect(persistedState).not.toContain("miro-refresh-token");
    expect(flow.flowId).toBeTruthy();

    jest.resetModules();
    const restartedOAuth = await import("../api/core/agent/tools/mcpOAuth");
    await expect(restartedOAuth.resolveMcpOAuthServer(server)).rejects.toThrow(
      /must be reconnected after restart/,
    );
  });

  it("rejects a callback after the authorization flow expires", async () => {
    const server = sanitizeMcpServer({
      id: "expired-flow",
      name: "Expired flow",
      url: "https://mcp.example.com/",
    });
    if (!server) throw new Error("Expected MCP config to be valid");
    const flow = await startMcpOAuth(
      server,
      "http://127.0.0.1:1234/api/agent/mcp/oauth/callback",
    );
    const provider = jest.mocked(auth).mock.calls[0][0];
    const state = await provider.state?.();
    if (!state) throw new Error("Expected OAuth state to be available");

    const now = Date.now();
    jest.spyOn(Date, "now").mockReturnValue(now + 10 * 60 * 1000 + 1);
    await expect(
      completeMcpOAuth({ state, code: "authorization-code" }),
    ).rejects.toThrow("OAuth state is invalid or has expired.");
    expect(getMcpOAuthFlow(flow.flowId)).toBeUndefined();
  });
});
