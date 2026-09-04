/**
 * MCP Server Definition Provider
 * Provides MCP servers from application settings
 */

import type { McpServerConfig } from "./mcpSettings";
import type { McpServerDefinitionProvider } from "./languageModelTools";
import { EventEmitter } from "events";

/**
 * Default MCP Server Provider
 * Provides servers from application settings/configuration
 */
export class DefaultMcpServerProvider extends EventEmitter implements McpServerDefinitionProvider {
  private servers: McpServerConfig[] = [];
  private changeListeners: Set<() => void> = new Set();

  constructor(servers: McpServerConfig[] = []) {
    super();
    this.servers = servers;
  }

  /**
   * Update the list of available servers
   */
  updateServers(servers: McpServerConfig[]): void {
    this.servers = servers;
    this.notifyChange();
  }

  /**
   * Provide available MCP servers
   */
  async provideMcpServerDefinitions(signal?: AbortSignal): Promise<McpServerConfig[]> {
    if (signal?.aborted) {
      throw new Error("Operation cancelled");
    }

    // Return enabled servers
    return this.servers.filter(server => server.enabled);
  }

  /**
   * Optional: resolve server before starting
   * Can be used for authentication, validation, etc.
   */
  async resolveMcpServerDefinition(
    server: McpServerConfig,
    signal?: AbortSignal
  ): Promise<McpServerConfig> {
    if (signal?.aborted) {
      throw new Error("Operation cancelled");
    }

    // For now, just return the server as-is
    // In the future, this could:
    // - Validate the server configuration
    // - Prompt for authentication if needed
    // - Expand environment variables
    // - Check if the command exists
    return server;
  }

  /**
   * Listen for server changes
   */
  onDidChangeMcpServerDefinitions(listener: () => void): () => void {
    this.changeListeners.add(listener);
    
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  /**
   * Notify listeners of changes
   */
  private notifyChange(): void {
    for (const listener of this.changeListeners) {
      try {
        listener();
      } catch (error) {
        console.error("Error in MCP server change listener:", error);
      }
    }
  }
}

/**
 * Dynamic MCP Server Provider
 * Can discover servers from various sources
 */
export class DynamicMcpServerProvider extends EventEmitter implements McpServerDefinitionProvider {
  private discoveryFunctions: Array<(signal?: AbortSignal) => Promise<McpServerConfig[]>> = [];
  private changeListeners: Set<() => void> = new Set();

  /**
   * Register a discovery function
   */
  registerDiscovery(
    fn: (signal?: AbortSignal) => Promise<McpServerConfig[]>
  ): () => void {
    this.discoveryFunctions.push(fn);
    this.notifyChange();

    return () => {
      const index = this.discoveryFunctions.indexOf(fn);
      if (index >= 0) {
        this.discoveryFunctions.splice(index, 1);
        this.notifyChange();
      }
    };
  }

  /**
   * Provide available MCP servers by running all discovery functions
   */
  async provideMcpServerDefinitions(signal?: AbortSignal): Promise<McpServerConfig[]> {
    const allServers: McpServerConfig[] = [];
    
    for (const discover of this.discoveryFunctions) {
      try {
        const servers = await discover(signal);
        allServers.push(...servers);
      } catch (error) {
        console.error("Error discovering MCP servers:", error);
      }
    }

    // Deduplicate by server ID
    const seen = new Set<string>();
    return allServers.filter(server => {
      if (seen.has(server.id)) {
        return false;
      }
      seen.add(server.id);
      return true;
    });
  }

  /**
   * Listen for server changes
   */
  onDidChangeMcpServerDefinitions(listener: () => void): () => void {
    this.changeListeners.add(listener);
    
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  /**
   * Notify listeners of changes
   */
  notifyChange(): void {
    for (const listener of this.changeListeners) {
      try {
        listener();
      } catch (error) {
        console.error("Error in MCP server change listener:", error);
      }
    }
  }
}

/**
 * Create a default provider from static configuration
 */
export function createDefaultProvider(servers: McpServerConfig[]): DefaultMcpServerProvider {
  return new DefaultMcpServerProvider(servers);
}

/**
 * Create a dynamic provider for runtime discovery
 */
export function createDynamicProvider(): DynamicMcpServerProvider {
  return new DynamicMcpServerProvider();
}
