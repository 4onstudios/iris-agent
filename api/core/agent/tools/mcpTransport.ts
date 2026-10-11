import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  JSONRPCMessageSchema,
  type JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk-legacy/client/sse.js";
import { JSONRPCMessageSchema as LegacyJSONRPCMessageSchema } from "@modelcontextprotocol/sdk-legacy/types.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { McpServerConfig } from "../../library/mcpSettings";

export class LegacySseTransportAdapter implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: Transport["onmessage"];

  constructor(readonly legacyTransport: SSEClientTransport) {
    legacyTransport.onclose = () => this.onclose?.();
    legacyTransport.onerror = (error) => this.onerror?.(error);
    legacyTransport.onmessage = (message) => {
      this.onmessage?.(JSONRPCMessageSchema.parse(message));
    };
  }

  start(): Promise<void> {
    return this.legacyTransport.start();
  }

  send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    const legacyMessage = LegacyJSONRPCMessageSchema.parse(message);
    return this.legacyTransport.send(legacyMessage);
  }

  close(): Promise<void> {
    return this.legacyTransport.close();
  }
}

export type McpRemoteClientTransport =
  | StreamableHTTPClientTransport
  | LegacySseTransportAdapter;

export const createMcpRemoteTransport = (
  server: McpServerConfig,
  authProvider?: OAuthClientProvider,
): McpRemoteClientTransport => {
  if (!server.url) {
    throw new Error(`MCP server '${server.name}' has no remote URL`);
  }

  const url = new URL(server.url);
  const headers = Object.fromEntries(
    Object.entries(server.headers || {}).filter(
      ([name]) => !authProvider || name.toLowerCase() !== "authorization",
    ),
  );

  if (server.transport === "sse") {
    const legacyTransport = new SSEClientTransport(url, {
      ...(authProvider ? { authProvider } : {}),
      requestInit: { headers },
    });
    return new LegacySseTransportAdapter(legacyTransport);
  }

  return new StreamableHTTPClientTransport(url, {
    ...(authProvider ? { authProvider } : {}),
    requestInit: { headers },
  });
};
