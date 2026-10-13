import {
  parseMcpServerConfigFile,
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
        transport: "sse",
        headers: {
          Authorization: "Bearer token",
        },
      }),
    ).toMatchObject({
      id: "remote",
      name: "Remote tools",
      url: "https://example.com/mcp",
      transport: "sse",
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

  it("defaults remote MCP servers to Streamable HTTP and rejects unknown transports", () => {
    expect(sanitizeMcpServer({ url: "https://example.com/mcp" })?.transport).toBe(
      "streamable-http",
    );
    expect(
      sanitizeMcpServer({
        url: "https://example.com/mcp",
        transport: "websocket",
      }),
    ).toBeNull();
  });

  it("parses array and keyed-object MCP server configs", () => {
    const server = {
      id: "local-tools",
      name: "Local tools",
      command: "npx",
      args: ["-y", "example-mcp-server"],
    };

    expect(parseMcpServerConfigFile(JSON.stringify([server]))).toMatchObject([
      { ...server, env: {}, enabled: true, command: "npx" },
    ]);
    expect(
      parseMcpServerConfigFile(JSON.stringify({ mcpServers: [server] })),
    ).toMatchObject([{ ...server, env: {}, enabled: true, command: "npx" }]);

    expect(
      parseMcpServerConfigFile(
        JSON.stringify({
          mcpServers: {
            filesystem: {
              command: "npx",
              args: ["-y", "server-filesystem", " /path with spaces ", ""],
              env: { TOKEN: " token " },
            },
          },
        }),
      ),
    ).toMatchObject([
      {
        id: "filesystem",
        name: "filesystem",
        command: "npx",
        args: ["-y", "server-filesystem", " /path with spaces ", ""],
        env: { TOKEN: " token " },
        enabled: true,
      },
    ]);
  });

  it("rejects malformed MCP entries instead of rewriting their executable fields", () => {
    expect(() => parseMcpServerConfigFile("{")).toThrow("not valid JSON");
    expect(() => parseMcpServerConfigFile("{}")).toThrow("mcpServers");
    expect(() => parseMcpServerConfigFile(JSON.stringify([{}]))).toThrow(
      "invalid server entry",
    );
    expect(() =>
      parseMcpServerConfigFile(
        JSON.stringify([{ command: "npx", enabled: "false" }]),
      ),
    ).toThrow('"enabled" value must be a boolean');
    expect(() =>
      parseMcpServerConfigFile(JSON.stringify([{ command: 42, args: [] }])),
    ).toThrow('"command" must be a non-empty string');
    expect(() =>
      parseMcpServerConfigFile(JSON.stringify([{ command: "npx", args: ["-y", 42] }])),
    ).toThrow('"args" must contain only strings');
    expect(() =>
      parseMcpServerConfigFile(
        JSON.stringify([{ command: "npx", args: [], env: { TOKEN: 42 } }]),
      ),
    ).toThrow('"env" contains an invalid key or value');
  });

  it("rejects invalid present URLs rather than falling back to a local command", () => {
    for (const url of [42, "", "   "]) {
      expect(() =>
        parseMcpServerConfigFile(
          JSON.stringify([{ url, command: "some-stale-command" }]),
        ),
      ).toThrow('"url" must be a non-empty string');
    }
  });

  it("validates and preserves MCP header values from config files", () => {
    expect(() =>
      parseMcpServerConfigFile(
        JSON.stringify([
          { url: "https://example.com/mcp", headers: { Authorization: 42 } },
        ]),
      ),
    ).toThrow('"headers" contains an invalid key or value');

    expect(
      parseMcpServerConfigFile(
        JSON.stringify([
          {
            url: "https://example.com/mcp",
            headers: { Authorization: "  Bearer token  " },
          },
        ]),
      )[0].headers,
    ).toEqual({ Authorization: "  Bearer token  " });
  });

  it("rejects malformed HTTP header names and values", () => {
    for (const headers of [
      { "Bad Header": "value" },
      { Authorization: "Bearer token\r\nX-Injected: yes" },
    ]) {
      expect(() =>
        parseMcpServerConfigFile(
          JSON.stringify([{ url: "https://example.com/mcp", headers }]),
        ),
      ).toThrow('"headers" contains an invalid key or value');

      expect(
        sanitizeMcpServer({
          url: "https://example.com/mcp",
          headers,
        }),
      ).toBeNull();
    }
  });

  it("rejects HTTP header values containing control characters", () => {
    const value = `Bearer token${String.fromCharCode(13, 10)}X-Injected: yes`;
    const headers = { Authorization: value + String.fromCharCode(13) };

    expect(() =>
      parseMcpServerConfigFile(
        JSON.stringify([{ url: "https://example.com/mcp", headers }]),
      ),
    ).toThrow('"headers" contains an invalid key or value');
    expect(
      sanitizeMcpServer({ url: "https://example.com/mcp", headers }),
    ).toBeNull();
  });

  it("rejects the whole config when a malformed URL is paired with a stale command, instead of falling back to local mode", () => {
    // A config that was previously remote but now has a broken/unsupported
    // url must not silently resurrect the leftover `command` and launch a
    // local process - that would run untrusted/stale commands and switch
    // transport modes without the user's knowledge.
    expect(
      sanitizeMcpServer({
        id: "remote",
        command: "node server.js",
        url: "not-a-url",
      }),
    ).toBeNull();

    expect(
      sanitizeMcpServer({
        id: "remote",
        command: "node server.js",
        url: "file:///tmp/server",
      }),
    ).toBeNull();
  });

  it("includes remote connection details in the agent cache fingerprint", () => {
    const server = sanitizeMcpServer({
      id: "remote",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer token" },
    });

    expect(server).not.toBeNull();
    expect(toStableMcpFingerprint([server!])).toContain("https://example.com/mcp");
    expect(
      toStableMcpFingerprint([
        { ...server!, transport: "sse" },
      ]),
    ).not.toBe(toStableMcpFingerprint([server!]));
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
