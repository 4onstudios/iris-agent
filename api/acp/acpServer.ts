/**
 * ACP (Agent Client Protocol) Server Implementation
 * Enables iris-agent to communicate via ACP protocol via stdio
 */

import { AgentApp } from "@agentclientprotocol/sdk";

/**
 * Simple params parser for custom methods
 */
function createParamsParser<T = any>() {
  return {
    parse: (data: unknown): T => {
      if (data === null || data === undefined) {
        return {} as T;
      }
      return data as T;
    },
  };
}

/**
 * Start ACP server for agent communication via stdio
 */
export async function startAcpServer(
  agent: any,
  _port: number = 3000
): Promise<void> {
  // Create ACP agent app
  const agentApp = new AgentApp({
    name: "iris-agent",
  });

  // Handle custom "chat" request
  agentApp.onRequest(
    "chat",
    createParamsParser(),
    async (params: any) => {
      return handleChatRequest(agent, params);
    }
  );

  // Handle custom "list_tools" request
  agentApp.onRequest(
    "list_tools",
    createParamsParser(),
    async () => {
      return handleListToolsRequest(agent);
    }
  );

  // Handle custom "list_skills" request
  agentApp.onRequest(
    "list_skills",
    createParamsParser(),
    async () => {
      return handleListSkillsRequest(agent);
    }
  );

  // Handle custom "workspace_info" request
  agentApp.onRequest(
    "workspace_info",
    createParamsParser(),
    async () => {
      return handleWorkspaceInfoRequest(agent);
    }
  );

  // Connect using stdio (default ACP transport)
  const connection = agentApp.connect(process.stdin as any);

  console.error(`✅ ACP Agent ready: iris-agent@0.1.0`);
  console.error(`📡 Listening via stdio for ACP protocol messages`);

  // Keep process alive until connection closes
  await connection.closed;
}

/**
 * Handle chat request
 */
async function handleChatRequest(agent: any, params: any): Promise<any> {
  const message = params?.message || params?.text || "";

  if (!message) {
    throw new Error("Message is required");
  }

  const response = await agent.chat?.({
    messages: [{ role: "user", content: message }],
  });

  return {
    success: true,
    response,
  };
}

/**
 * List available tools
 */
async function handleListToolsRequest(agent: any): Promise<any> {
  const tools = await agent.tools?.getAvailableTools?.();

  return {
    tools: Array.isArray(tools)
      ? tools.map((t: any) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        }))
      : [],
  };
}

/**
 * List available skills
 */
async function handleListSkillsRequest(agent: any): Promise<any> {
  const skills = await agent.getSkillsList?.();

  return {
    skills: Array.isArray(skills) ? skills : [],
  };
}

/**
 * Get workspace information
 */
async function handleWorkspaceInfoRequest(agent: any): Promise<any> {
  return {
    workspaceRoot: agent.workspaceRoot || "",
    timestamp: new Date().toISOString(),
    agentVersion: "0.1.0",
  };
}
