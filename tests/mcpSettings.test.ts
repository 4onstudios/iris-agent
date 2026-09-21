import {
  sanitizeMcpServer,
  toStableMcpFingerprint,
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
});
