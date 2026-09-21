import {
  sanitizeMcpServer,
  toStableMcpFingerprint,
  redactMcpUrlForDisplay,
} from "../api/core/library/mcpSettings";

describe("MCP server settings", () => {
  it("accepts remote HTTP servers without requiring a command", () => {
    expect(
      sanitizeMcpServer({
        id: "remote",
        name: "Remote tools",
        url: "https://example.com/mcp",
        headers: {
          Authorization: "Bearer token",
        },
      }),
    ).toMatchObject({
      id: "remote",
      name: "Remote tools",
      url: "https://example.com/mcp",
      command: "",
      headers: {
        Authorization: "Bearer token",
      },
      enabled: true,
    });
  });

  it("rejects unsupported or invalid remote URLs", () => {
    expect(sanitizeMcpServer({ url: "file:///tmp/server" })).toBeNull();
    expect(sanitizeMcpServer({ url: "not-a-url" })).toBeNull();
  });

  it("includes remote connection details in the agent cache fingerprint", () => {
    const server = sanitizeMcpServer({
      id: "remote",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer token" },
    });

    expect(server).not.toBeNull();
    expect(toStableMcpFingerprint([server!])).toContain("https://example.com/mcp");
  });

  it("drops a stale command when a URL is also supplied, rather than accepting both", () => {
    const server = sanitizeMcpServer({
      id: "dual",
      command: "node server.js",
      url: "https://example.com/mcp",
    });

    expect(server).toMatchObject({
      command: "",
      url: "https://example.com/mcp",
    });
  });

  it("redacts credentials from URLs used in model-facing display text", () => {
    expect(redactMcpUrlForDisplay("https://example.com/mcp?api_key=super-secret")).toBe(
      "https://example.com/mcp (redacted)",
    );
    expect(redactMcpUrlForDisplay("https://user:pass@example.com/mcp")).toBe(
      "https://example.com/mcp (redacted)",
    );
    expect(redactMcpUrlForDisplay("https://example.com/mcp")).toBe(
      "https://example.com/mcp",
    );
  });

  it("defaults an unnamed remote server's name to a credential-free hostname, not the full URL", () => {
    const withApiKey = sanitizeMcpServer({
      id: "remote",
      url: "https://example.com/mcp?api_key=super-secret",
    });
    expect(withApiKey?.name).toBe("example.com");

    const withUserinfo = sanitizeMcpServer({
      id: "remote",
      url: "https://token:super-secret@example.com/mcp",
    });
    expect(withUserinfo?.name).toBe("example.com");
  });
});
