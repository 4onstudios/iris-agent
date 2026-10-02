/**
 * Language Model Tools API
 * VS Code-compatible API for registering and managing language model tools
 */

import { EventEmitter } from "events";
import type { McpServerConfig } from "./mcpSettings";
import { listMcpServerTools, executeMcpToolByKey, type McpToolSummary } from "../agent/tools/mcpTools";

/**
 * Represents a tool that can be invoked by a language model
 */
export interface LanguageModelToolInformation {
  /** Unique tool name */
  readonly name: string;
  /** Description for language model */
  readonly description: string;
  /** JSON schema for input validation */
  readonly inputSchema?: object;
  /** Tags for categorization */
  readonly tags: readonly string[];
  /** Source of the tool (mcp, native, etc.) */
  readonly source: string;
}

/**
 * Options for tool invocation
 */
export interface LanguageModelToolInvocationOptions<T = unknown> {
  /** Tool input matching the schema */
  input: T;
  /** Optional token budget hints */
  tokenizationOptions?: {
    tokenBudget: number;
    countTokens: (text: string) => Promise<number>;
  };
  /** Context from chat request (for UI integration) */
  toolInvocationToken?: unknown;
}

/**
 * Result from tool invocation
 */
export interface LanguageModelToolResult {
  /** Content parts from the tool */
  content: Array<{
    type: "text" | "data" | "error";
    value: string;
    mimeType?: string;
  }>;
}

/**
 * A tool that can be registered and invoked
 */
export interface LanguageModelTool<T = unknown> {
  /**
   * Invoke the tool with the given input
   */
  invoke(
    options: LanguageModelToolInvocationOptions<T>,
    signal?: AbortSignal
  ): Promise<LanguageModelToolResult>;

  /**
   * Optional preparation before invocation (for progress/confirmation)
   */
  prepareInvocation?(
    options: { input: T },
    signal?: AbortSignal
  ): Promise<{
    invocationMessage?: string;
    confirmationMessages?: {
      title: string;
      message: string;
    };
  }>;
}

/**
 * MCP Server Definition Provider
 * Provides available MCP servers dynamically
 */
export interface McpServerDefinitionProvider {
  /**
   * Provide available MCP servers
   */
  provideMcpServerDefinitions(signal?: AbortSignal): Promise<McpServerConfig[]>;

  /**
   * Optional: resolve server before starting (e.g., for authentication)
   */
  resolveMcpServerDefinition?(
    server: McpServerConfig,
    signal?: AbortSignal
  ): Promise<McpServerConfig>;

  /**
   * Optional: event when servers change
   */
  onDidChangeMcpServerDefinitions?: (listener: () => void) => () => void;
}

/**
 * Disposable pattern for cleanup
 */
export interface Disposable {
  dispose(): void;
}

/**
 * Language Model Tools Manager
 * Manages tool registration and discovery
 */
export class LanguageModelToolsManager extends EventEmitter {
  private tools: Map<string, LanguageModelTool> = new Map();
  private toolInfo: Map<string, LanguageModelToolInformation> = new Map();
  private mcpProviders: Map<string, McpServerDefinitionProvider> = new Map();
  private mcpServerCache: Map<string, McpServerConfig[]> = new Map();
  private workspacePath: string | null = null;

  constructor() {
    super();
  }

  /**
   * Set workspace path for MCP servers
   */
  setWorkspacePath(path: string | null): void {
    this.workspacePath = path;
    // Clear cache when workspace changes
    this.mcpServerCache.clear();
    this.emit("toolsChanged");
  }

  /**
   * Register a native tool
   */
  registerTool<T = unknown>(
    name: string,
    tool: LanguageModelTool<T>,
    info: Omit<LanguageModelToolInformation, "name" | "source">
  ): Disposable {
    this.tools.set(name, tool as LanguageModelTool);
    this.toolInfo.set(name, {
      name,
      description: info.description,
      inputSchema: info.inputSchema,
      tags: info.tags,
      source: "native",
    });

    this.emit("toolsChanged");

    return {
      dispose: () => {
        this.tools.delete(name);
        this.toolInfo.delete(name);
        this.emit("toolsChanged");
      },
    };
  }

  /**
   * Register an MCP server definition provider
   */
  registerMcpServerDefinitionProvider(
    id: string,
    provider: McpServerDefinitionProvider
  ): Disposable {
    this.mcpProviders.set(id, provider);

    // Listen for changes if provider supports it
    let unsubscribe: (() => void) | undefined;
    if (provider.onDidChangeMcpServerDefinitions) {
      unsubscribe = provider.onDidChangeMcpServerDefinitions(() => {
        this.mcpServerCache.delete(id);
        this.emit("toolsChanged");
      });
    }

    this.emit("toolsChanged");

    return {
      dispose: () => {
        this.mcpProviders.delete(id);
        this.mcpServerCache.delete(id);
        if (unsubscribe) unsubscribe();
        this.emit("toolsChanged");
      },
    };
  }

  /**
   * Get all available tools (native + MCP)
   */
  async getAvailableTools(signal?: AbortSignal): Promise<LanguageModelToolInformation[]> {
    const tools: LanguageModelToolInformation[] = [];

    // Add native tools
    tools.push(...Array.from(this.toolInfo.values()));

    // Add MCP tools from all providers
    const mcpServers = await this.getAllMcpServers(signal);
    const workspacePath = this.workspacePath || process.cwd();

    for (const server of mcpServers) {
      if (!server.enabled) continue;

      try {
        const serverTools = await listMcpServerTools(server, workspacePath);
        
        for (const tool of serverTools) {
          const toolKey = this.getMcpToolKey(server.name, tool.name);
          tools.push({
            name: toolKey,
            description: tool.description || `MCP tool: ${tool.name}`,
            inputSchema: tool.inputSchema,
            tags: ["mcp", server.name],
            source: `mcp:${server.name}`,
          });
        }
      } catch (error) {
        console.error(`Failed to list tools from ${server.name}:`, error);
      }
    }

    return tools;
  }

  /**
   * Invoke a tool by name
   */
  async invokeTool(
    name: string,
    options: LanguageModelToolInvocationOptions,
    signal?: AbortSignal
  ): Promise<LanguageModelToolResult> {
    // Check if it's a native tool
    const nativeTool = this.tools.get(name);
    if (nativeTool) {
      return nativeTool.invoke(options, signal);
    }

    // Check if it's an MCP tool
    if (name.startsWith("mcp_")) {
      return this.invokeMcpTool(name, options, signal);
    }

    throw new Error(`Tool '${name}' not found`);
  }

  /**
   * Invoke an MCP tool
   */
  private async invokeMcpTool(
    toolKey: string,
    options: LanguageModelToolInvocationOptions,
    signal?: AbortSignal
  ): Promise<LanguageModelToolResult> {
    const mcpServers = await this.getAllMcpServers(signal);
    const workspacePath = this.workspacePath || process.cwd();

    const result = await executeMcpToolByKey(
      mcpServers,
      workspacePath,
      toolKey,
      options.input as Record<string, unknown>
    );

    if (!result.success) {
      return {
        content: [
          {
            type: "error",
            value: result.error || "MCP tool execution failed",
          },
        ],
      };
    }

    // At this point, result.success is true, so we can safely access optional content
    // TypeScript can't narrow the union type properly, so we explicitly cast
    const successResult = result as { success: true; content?: unknown; structuredContent?: unknown; [key: string]: unknown };

    // Convert MCP result to LanguageModelToolResult format
    const content: LanguageModelToolResult["content"] = [];

    if (Array.isArray(successResult.content)) {
      for (const item of successResult.content) {
        if (typeof item === "object" && item !== null) {
          const mcpItem = item as { type?: string; text?: string; message?: string };
          
          if (mcpItem.text) {
            content.push({
              type: "text",
              value: mcpItem.text,
            });
          } else if (mcpItem.message) {
            content.push({
              type: "text",
              value: mcpItem.message,
            });
          }
        }
      }
    }

    if (content.length === 0 && successResult.content !== undefined) {
      content.push({
        type: "text",
        value: JSON.stringify(successResult.content, null, 2),
      });
    }

    return { content };
  }

  /**
   * Get all MCP servers from all providers
   */
  private async getAllMcpServers(signal?: AbortSignal): Promise<McpServerConfig[]> {
    const allServers: McpServerConfig[] = [];

    for (const [id, provider] of this.mcpProviders.entries()) {
      // Check cache first
      let servers = this.mcpServerCache.get(id);

      if (!servers) {
        servers = await provider.provideMcpServerDefinitions(signal);
        this.mcpServerCache.set(id, servers);
      }

      allServers.push(...servers);
    }

    return allServers;
  }

  /**
   * Generate MCP tool key (matches mcpTools.ts format)
   */
  private getMcpToolKey(serverName: string, toolName: string): string {
    const safeToken = (value: string): string =>
      value.replace(/[^a-zA-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80);
    
    return `mcp_${safeToken(serverName)}_${safeToken(toolName)}`;
  }

  /**
   * Listen for tool changes
   */
  onDidChangeTools(listener: () => void): Disposable {
    this.on("toolsChanged", listener);
    
    return {
      dispose: () => {
        this.off("toolsChanged", listener);
      },
    };
  }
}

// Singleton instance
export const languageModelTools = new LanguageModelToolsManager();

export default LanguageModelToolsManager;
