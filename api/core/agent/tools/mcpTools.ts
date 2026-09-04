import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import Ajv from "ajv";
import type { JSONSchema7 } from "json-schema";
import os from "os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  type StdioServerParameters,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpServerConfig } from "../../library/mcpSettings";

const MCP_TIMEOUT_MS = 20000;

type McpToolDefinition = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

export type McpToolSummary = {
  name: string;
  description?: string;
};

const ajv = new Ajv({ allErrors: true });

const safeToolToken = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80);

export const toMcpToolKey = (serverName: string, toolName: string): string =>
  `mcp_${safeToolToken(serverName)}_${safeToolToken(toolName)}`;

const formatAjvErrorPath = (instancePath: string, missingProperty?: string): string => {
  const path = instancePath || "/";
  return missingProperty ? `${path}${path.endsWith("/") ? "" : "/"}${missingProperty}` : path;
};

const summarizeMcpContent = (content: unknown): string | undefined => {
  if (!Array.isArray(content)) return undefined;

  const parts = content
    .map((item) => {
      if (!item || typeof item !== "object") return null;

      const entry = item as Record<string, unknown>;
      if (typeof entry.text === "string" && entry.text.trim()) {
        return entry.text.trim();
      }

      if (typeof entry.message === "string" && entry.message.trim()) {
        return entry.message.trim();
      }

      return null;
    })
    .filter((value): value is string => Boolean(value));

  if (parts.length === 0) return undefined;
  return parts.join("\n");
};

const summarizeStructuredError = (structuredContent: unknown): string | undefined => {
  if (!structuredContent || typeof structuredContent !== "object" || Array.isArray(structuredContent)) {
    return undefined;
  }

  const record = structuredContent as Record<string, unknown>;
  const directMessage = [record.error, record.message, record.detail]
    .find((value) => typeof value === "string" && value.trim().length > 0);

  if (typeof directMessage === "string") {
    return directMessage.trim();
  }

  return undefined;
};

export const validateMcpToolInput = (
  toolName: string,
  inputSchema: Record<string, unknown> | undefined,
  params: Record<string, unknown>,
): string | null => {
  if (!inputSchema || Object.keys(inputSchema).length === 0) {
    return null;
  }

  const validate = ajv.compile(inputSchema);
  const valid = validate(params);

  if (valid) {
    return null;
  }

  const details = (validate.errors || [])
    .map((error) => {
      const missingProperty =
        error.keyword === "required" &&
        typeof (error.params as { missingProperty?: unknown })?.missingProperty === "string"
          ? ((error.params as { missingProperty?: string }).missingProperty || undefined)
          : undefined;
      const path = formatAjvErrorPath((error as { dataPath?: string }).dataPath || "", missingProperty);
      return `${path}: ${error.message || "invalid value"}`;
    })
    .join("; ");

  return `Invalid arguments for MCP tool '${toolName}'. ${details}`;
};

export const summarizeMcpToolError = (result: {
  isError?: boolean;
  content?: unknown;
  structuredContent?: unknown;
}): string | undefined => {
  if (!result.isError) return undefined;

  return summarizeStructuredError(result.structuredContent) || summarizeMcpContent(result.content);
};

const buildAugmentedPath = (): string => {
  const home = process.env.HOME || os.homedir() || "";
  const currentPath = process.env.PATH || "";
  const pathParts = [
    currentPath,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    home ? `${home}/.local/bin` : "",
    home ? `${home}/.cargo/bin` : "",
  ].filter(Boolean);

  return Array.from(new Set(pathParts.join(":").split(":"))).join(":");
};

type CommandCandidate = {
  command: string;
  prependArgs?: string[];
};

const shellEscape = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`;

const toShellCommand = (command: string, args: string[]): string =>
  [command, ...args].map((part) => shellEscape(part)).join(" ");

const getCommandCandidates = (command: string): CommandCandidate[] => {
  const base = command.trim();
  if (!base) return [];

  const candidates: CommandCandidate[] = [{ command: base }];
  if (base === "npx") {
    candidates.push(
      { command: "/opt/homebrew/bin/npx" },
      { command: "/usr/local/bin/npx" },
      { command: "/usr/bin/npx" },
    );
  }

  if (base === "uvx") {
    const home = process.env.HOME || os.homedir() || "";
    candidates.push(
      { command: "/opt/homebrew/bin/uvx" },
      { command: "/usr/local/bin/uvx" },
      { command: "/usr/bin/uvx" },
      ...(home ? [{ command: `${home}/.cargo/bin/uvx` }] : []),
      ...(home ? [{ command: `${home}/.local/bin/uvx` }] : []),
      { command: "uv", prependArgs: ["x"] },
      { command: "/opt/homebrew/bin/uv", prependArgs: ["x"] },
      { command: "/usr/local/bin/uv", prependArgs: ["x"] },
      ...(home ? [{ command: `${home}/.cargo/bin/uv`, prependArgs: ["x"] }] : []),
      ...(home ? [{ command: `${home}/.local/bin/uv`, prependArgs: ["x"] }] : []),
    );
  }

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.command}::${(candidate.prependArgs || []).join(" ")}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
};

const createTransportParams = (
  server: McpServerConfig,
  workspacePath: string,
): StdioServerParameters => {
  const env = {
    ...process.env,
    ...server.env,
  } as Record<string, string>;
  env.PATH = buildAugmentedPath();

  return {
    command: server.command.trim(),
    args: [...server.args],
    env,
    cwd: workspacePath,
    stderr: "pipe",
  };
};

const connectClient = async (
  server: McpServerConfig,
  workspacePath: string,
): Promise<{ client: Client; transport: StdioClientTransport }> => {
  const command = server.command.trim();
  const args = [...server.args];
  const commandCandidates = getCommandCandidates(command);
  const attempted: string[] = [];
  let lastError: Error | null = null;

  for (const candidate of commandCandidates) {
    const client = new Client({ name: "iris-mcp", version: "1.0.0" });
    const transport = new StdioClientTransport({
      ...createTransportParams(server, workspacePath),
      command: candidate.command,
      args: [
        ...(candidate.prependArgs || []),
        ...args,
      ],
    });

    attempted.push(
      `${candidate.command}${
        (candidate.prependArgs || []).length > 0
          ? ` ${(candidate.prependArgs || []).join(" ")}`
          : ""
      }`,
    );

    try {
      await client.connect(transport, { timeout: MCP_TIMEOUT_MS });
      return { client, transport };
    } catch (error) {
      await closeTransport(transport);
      lastError = error as Error;
      const message = lastError.message || "";
      const isEnoent = /ENOENT/i.test(message);

      if (!isEnoent) {
        throw lastError;
      }
    }
  }

  // Some desktop launch contexts have constrained PATH/environment.
  // If direct spawn failed with ENOENT, retry through a login shell.
  if (lastError && /ENOENT/i.test(lastError.message || "")) {
    const shellCommand = toShellCommand(command, args);
    const shellCandidates = ["/bin/zsh", "/bin/bash"];

    for (const shellPath of shellCandidates) {
      const client = new Client({ name: "iris-mcp", version: "1.0.0" });
      const transport = new StdioClientTransport({
        ...createTransportParams(server, workspacePath),
        command: shellPath,
        args: ["-lc", shellCommand],
      });

      attempted.push(`${shellPath} -lc ${shellCommand}`);

      try {
        await client.connect(transport, { timeout: MCP_TIMEOUT_MS });
        return { client, transport };
      } catch (error) {
        await closeTransport(transport);
        lastError = error as Error;
      }
    }
  }

  if (lastError) {
    const detail = attempted.length > 0 ? ` Tried: ${attempted.join(", ")}.` : "";
    throw new Error(`${lastError.message}${detail}`);
  }

  throw new Error("Failed to start MCP client transport");
};

const closeTransport = async (transport?: StdioClientTransport) => {
  if (!transport) return;
  try {
    await transport.close();
  } catch {
    // No-op; transport teardown should not fail request handling.
  }
};

export const listMcpServerTools = async (
  server: McpServerConfig,
  workspacePath: string,
): Promise<McpToolDefinition[]> => {
  let transport: StdioClientTransport | undefined;

  try {
    const { client, transport: activeTransport } = await connectClient(
      server,
      workspacePath,
    );
    transport = activeTransport;

    const listed = await client.listTools(undefined, { timeout: MCP_TIMEOUT_MS });
    return (listed.tools || []).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: (tool.inputSchema || {}) as Record<string, unknown>,
    }));
  } finally {
    await closeTransport(transport);
  }
};

const callServerTool = async (
  server: McpServerConfig,
  workspacePath: string,
  toolName: string,
  input: Record<string, unknown>,
) => {
  let transport: StdioClientTransport | undefined;

  try {
    const { client, transport: activeTransport } = await connectClient(
      server,
      workspacePath,
    );
    transport = activeTransport;

    const result = await client.callTool(
      {
        name: toolName,
        arguments: input,
      },
      undefined,
      { timeout: MCP_TIMEOUT_MS },
    );

    return {
      success: !result.isError,
      server: server.name,
      tool: toolName,
      isError: !!result.isError,
      content: result.content,
      structuredContent: result.structuredContent,
      error: summarizeMcpToolError({
        isError: !!result.isError,
        content: result.content,
        structuredContent: result.structuredContent,
      }),
    };
  } catch (error) {
    const err = error as Error;
    return {
      success: false,
      server: server.name,
      tool: toolName,
      isError: true,
      error: err.message,
    };
  } finally {
    await closeTransport(transport);
  }
};

export const executeMcpToolByKey = async (
  servers: McpServerConfig[],
  workspacePath: string,
  toolKey: string,
  input: Record<string, unknown>,
) => {
  console.log("🔍 executeMcpToolByKey called with:", {
    toolKey,
    inputKeys: Object.keys(input),
    serversCount: servers.length,
  });

  for (const server of servers) {
    if (!server.enabled) {
      console.log(`⏭️ Skipping disabled server: ${server.name}`);
      continue;
    }

    console.log(`🔍 Checking server: ${server.name}`);

    let tools: McpToolDefinition[] = [];

    try {
      console.log(`📋 Listing tools from ${server.name}...`);
      tools = await listMcpServerTools(server, workspacePath);
      console.log(`✅ ${server.name} reports ${tools.length} tools available`);
    } catch (error) {
      console.error(`❌ Failed to list tools from ${server.name}:`, (error as Error).message);
      continue;
    }

    for (const tool of tools) {
      const computedKey = toMcpToolKey(server.name, tool.name);
      console.log(`🔑 Checking tool: ${tool.name} (key: ${computedKey})`);

      if (computedKey !== toolKey) {
        continue;
      }

      console.log(`🎯 Match found! Validating input for ${tool.name}...`);

      const validationError = validateMcpToolInput(tool.name, tool.inputSchema, input);
      if (validationError) {
        console.error("❌ Input validation failed:", validationError);
        return {
          success: false,
          server: server.name,
          tool: tool.name,
          isError: true,
          error: validationError,
        };
      }

      console.log("🚀 Calling MCP tool with input:", input);
      const result = await callServerTool(server, workspacePath, tool.name, input);
      console.log("✅ MCP tool call completed");
      console.log("📤 Result:", result);
      return result;
    }
  }

  console.warn("⚠️ Tool key not found on any server:", toolKey);
  return {
    success: false,
    isError: true,
    error: `MCP tool '${toolKey}' is not available on the configured servers`,
  };
};

/**
 * Generate MCP tools documentation for persistence in knowledge base.
 * Only includes servers that are connected and available.
 * Returns tool metadata that can be stored in the workspace for semantic search.
 * Returns null if no connected servers with tools are available.
 */
export const generateMcpToolsDocs = async (
  servers: McpServerConfig[],
  workspacePath: string,
): Promise<string | null> => {
  const sections: string[] = [
    "# MCP Tools Documentation",
    "",
    "This document contains all available MCP (Model Context Protocol) tools registered in this workspace.",
    "Only connected and available servers are documented here.",
    "",
  ];

  let hasAnyTools = false;

  for (const server of servers) {
    if (!server.enabled) continue;

    let tools: McpToolDefinition[] = [];

    try {
      tools = await listMcpServerTools(server, workspacePath);
    } catch (error) {
      const err = error as Error;
      console.warn(
        `[mcp-docs] Skipping unavailable server ${server.name}: ${err.message}`,
      );
      // Skip unavailable servers - don't document them
      continue;
    }

    // Skip servers with no tools
    if (tools.length === 0) {
      console.warn(
        `[mcp-docs] Skipping server ${server.name}: no tools exposed`,
      );
      continue;
    }

    hasAnyTools = true;

    sections.push(`## ${server.name}`);
    sections.push(`- **Command**: \`${server.command}\``);
    sections.push(`- **Tools**: ${tools.length}`);
    sections.push(`- **Status**: ✅ Connected`);
    sections.push("");

    for (const tool of tools) {
      const toolKey = toMcpToolKey(server.name, tool.name);
      sections.push(`### \`${toolKey}\``);
      sections.push("");
      sections.push(`**Description**: ${tool.description || "No description available"}`);
      sections.push("");
      
      if (tool.inputSchema) {
        sections.push("**Input Schema**:");
        sections.push("```json");
        sections.push(JSON.stringify(tool.inputSchema, null, 2));
        sections.push("```");
        sections.push("");
      }

      sections.push(`**Usage Example**:`);
      sections.push("```javascript");
      sections.push(`${toolKey}({ /* args matching schema */ })`);
      sections.push("```");
      sections.push("");
    }
  }

  // Return null if no servers have tools available
  return hasAnyTools ? sections.join("\n") : null;
};

export const buildMcpTools = async (
  servers: McpServerConfig[],
  workspacePath: string,
): Promise<Record<string, unknown>> => {
  const registered: Record<string, unknown> = {};

  for (const server of servers) {
    if (!server.enabled) continue;

    let tools: McpToolDefinition[] = [];

    try {
      tools = await listMcpServerTools(server, workspacePath);
    } catch (error) {
      const err = error as Error;
      console.warn(
        `[mcp] Failed to list tools for ${server.name} (${server.command}): ${err.message}`,
      );
      continue;
    }

    for (const tool of tools) {
      const key = toMcpToolKey(server.name, tool.name);
      if (!key || registered[key]) continue;

      const schemaPreview = tool.inputSchema
        ? JSON.stringify(tool.inputSchema).slice(0, 800)
        : "{}";

      // Expose the MCP server's declared JSON Schema directly to the model's
      // function-calling API instead of an unconstrained passthrough object.
      // Previously every MCP tool used `z.object({}).passthrough()`, so the
      // model had no structured schema to call against and had to *guess*
      // the parameter shape from a text blob in the description. That caused
      // repeated invalid tool calls (caught by Ajv validation below) until
      // the tool-call budget's repeated-call guard kicked in and forced an
      // abrupt synthesis/response. Passing the real JSON Schema lets
      // providers that support structured tool calling constrain arguments
      // correctly on the first attempt.
      const toolInputSchema =
        tool.inputSchema && Object.keys(tool.inputSchema).length > 0
          ? (tool.inputSchema as unknown as JSONSchema7)
          : z.object({}).passthrough();

      registered[key] = createTool({
        id: key,
        description:
          `MCP tool from server '${server.name}' (${server.command}) named '${tool.name}'. ` +
          `Pass the tool arguments directly as fields in the input object and match the declared schema exactly.` +
          `\n\nDeclared input schema:\n${schemaPreview}`,
        inputSchema: toolInputSchema,
        execute: async (params: Record<string, unknown>) => {
          const input = params || {};
          const validationError = validateMcpToolInput(
            tool.name,
            tool.inputSchema,
            input,
          );

          if (validationError) {
            return {
              success: false,
              server: server.name,
              tool: tool.name,
              isError: true,
              error: validationError,
            };
          }

          return callServerTool(server, workspacePath, tool.name, input);
        },
      });
    }
  }

  return registered;
};
