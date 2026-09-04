/**
 * Language Model Tools Integration
 * Initializes and manages the language model tools system for Iris
 */

import { languageModelTools } from "../../library/languageModelTools";
import { createDefaultProvider } from "../../library/mcpServerProvider";
import type { McpServerConfig } from "../../library/mcpSettings";

/**
 * Initialize language model tools system
 */
export async function initializeLanguageModelTools(
  mcpServers: McpServerConfig[],
  workspacePath: string | null
): Promise<void> {
  // Set workspace path
  languageModelTools.setWorkspacePath(workspacePath);

  // Register MCP server provider
  const mcpProvider = createDefaultProvider(mcpServers);
  languageModelTools.registerMcpServerDefinitionProvider(
    "iris.default",
    mcpProvider
  );
}

/**
 * Get all available tools
 */
export async function getAvailableTools() {
  return languageModelTools.getAvailableTools();
}
