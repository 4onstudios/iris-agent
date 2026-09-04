export const AGENT_HOST_CONTRACT_VERSION = "1.0.0";

export type AgentSource = "builtin" | "external";

export type AgentCapability =
  | "filesystem"
  | "workspace_search"
  | "terminal"
  | "lsp"
  | "mcp"
  | "tool_calling"
  | "streaming"
  | "approval_flow";

export type AgentCapabilityMap = Partial<Record<AgentCapability, boolean>>;

export type AgentPermissionScope =
  | "workspace_read"
  | "workspace_write"
  | "workspace_delete"
  | "terminal_execute"
  | "network"
  | "lsp_request"
  | "mcp_request";

export type AgentPermissionMode = "allow" | "deny" | "ask";

export type AgentPermissionPolicy = Partial<Record<AgentPermissionScope, AgentPermissionMode>>;

export type AgentDescriptor = {
  id: string;
  name: string;
  version: string;
  source: AgentSource;
  description?: string;
  capabilities?: AgentCapabilityMap;
  permissions?: AgentPermissionPolicy;
  tags?: string[];
};

export type AgentSessionContext = {
  sessionId: string;
  workspacePath: string;
  modelId?: string;
  metadata?: Record<string, unknown>;
};

export type AgentSession = {
  sessionId: string;
  agentId: string;
  createdAt: number;
};

export type AgentTurnRequest = {
  sessionId: string;
  input: string;
  conversation?: Array<{
    role: "user" | "assistant" | "system" | "tool";
    content: string;
  }>;
  metadata?: Record<string, unknown>;
};

export type AgentStreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "tool-call"; name: string; args?: Record<string, unknown> }
  | { type: "tool-result"; name: string; result?: unknown }
  | { type: "approval-required"; reason: string; payload?: Record<string, unknown> }
  | { type: "error"; message: string }
  | { type: "done" };

export type AgentTurnResult = {
  text: string;
  toolCalls?: Array<Record<string, unknown>>;
  toolResults?: Array<Record<string, unknown>>;
  raw?: unknown;
};

export type AgentTurnStreamResult = {
  stream: ReadableStream<AgentStreamEvent>;
  getFinalResult: () => Promise<AgentTurnResult>;
};

export interface AgentRuntime {
  readonly descriptor: AgentDescriptor;
  startSession(context: AgentSessionContext): Promise<AgentSession>;
  runTurn(request: AgentTurnRequest): Promise<AgentTurnResult>;
  runTurnStream?(request: AgentTurnRequest): Promise<AgentTurnStreamResult>;
  cancelTurn?(sessionId: string): Promise<void>;
  endSession(sessionId: string): Promise<void>;
}

export type AgentRuntimeFactory<TRuntime = AgentRuntime> = () => Promise<TRuntime> | TRuntime;
