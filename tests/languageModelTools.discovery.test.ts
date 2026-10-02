jest.mock("../api/core/agent/tools/mcpTools", () => ({
  listMcpServerTools: jest.fn(),
  executeMcpToolByKey: jest.fn(),
}));

import { listMcpServerTools } from "../api/core/agent/tools/mcpTools";
import { McpOAuthReconnectRequiredError } from "../api/core/agent/tools/mcpOAuth";
import {
  LanguageModelToolsManager,
  type McpServerDefinitionProvider,
} from "../api/core/library/languageModelTools";

describe("language model tool discovery", () => {
  beforeEach(() => jest.clearAllMocks());

  it("keeps native and healthy MCP tools when another server requires reconnect", async () => {
    const manager = new LanguageModelToolsManager();
    manager.setWorkspacePath("/workspace");
    manager.registerTool(
      "native_tool",
      { invoke: jest.fn(async () => ({ content: [] })) },
      { description: "Native", tags: [] },
    );
    const servers = [
      {
        id: "oauth",
        name: "OAuth server",
        url: "https://oauth.example.com/",
        args: [],
        env: {},
        enabled: true,
      },
      {
        id: "healthy",
        name: "Healthy server",
        url: "https://healthy.example.com/",
        args: [],
        env: {},
        enabled: true,
      },
    ];
    const provider: McpServerDefinitionProvider = {
      provideMcpServerDefinitions: async () => servers,
    };
    manager.registerMcpServerDefinitionProvider("test", provider);
    jest.mocked(listMcpServerTools).mockImplementation(async (server) => {
      if (server.id === "oauth") {
        throw new McpOAuthReconnectRequiredError(server.name);
      }
      return [{
        name: "healthy_tool",
        description: "Healthy MCP tool",
        inputSchema: {},
      }];
    });

    const tools = await manager.getAvailableTools();

    expect(tools.map((tool) => tool.name)).toEqual([
      "native_tool",
      expect.stringContaining("healthy_tool"),
    ]);
    expect(listMcpServerTools).toHaveBeenCalledTimes(2);
  });
});
