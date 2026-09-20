#!/usr/bin/env node

/**
 * iris-agent CLI with ACP (Agent Client Protocol) support
 * Usage:
 *   iris-agent --acp
 *   iris-agent --workspace /path/to/workspace --modelId openrouter/openai/gpt-5.3-codex --chat
 */

import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { createCodingAgent } from "./api/core/agent/index.js";
import { startAcpServer } from "./api/acp/acpServer.js";
import { getMissingProviderSetup } from "./api/core/library/providerSetup.js";
import { resolveToolExecutionStatus } from "./api/core/agent/utils/toolLifecycle.js";
import {
  isCliSpinnerEnabled,
  startCliSpinner,
} from "./api/core/library/cliSpinner.js";

const defaultModelId =
  process.env.MODEL_ID ||
  process.env.OPENROUTER_MODEL ||
  "openrouter/openai/gpt-5.3-codex";

const argv = yargs(hideBin(process.argv))
  .option("workspace", {
    alias: "w",
    type: "string",
    description: "Workspace root path",
    default: process.cwd(),
  })
  .option("acp", {
    alias: "a",
    type: "boolean",
    description: "Start ACP (Agent Client Protocol) server mode",
    default: false,
  })
  .option("chat", {
    alias: "c",
    type: "boolean",
    description: "Interactive chat mode",
    default: false,
  })
  .option("modelId", {
    type: "string",
    description: "Language model identifier",
    default: defaultModelId,
  })
  .help()
  .parseSync();

async function main() {
  const workspaceRoot = argv.workspace as string;
  const modelId = argv.modelId;

  if (argv.acp) {
    const stderrLog = console.error.bind(console);
    console.log = stderrLog;
    console.debug = stderrLog;
    console.info = stderrLog;
    console.warn = stderrLog;
    console.dir = stderrLog;
    console.table = stderrLog;
    console.trace = stderrLog;
    console.group = stderrLog;
    console.groupCollapsed = stderrLog;
    console.groupEnd = stderrLog;
  }

  console.log(`🚀 Iris Agent CLI`);
  console.log(`📁 Workspace: ${workspaceRoot}`);
  console.log(`🤖 Model: ${modelId}`);

  if (argv.acp) {
    const missingProviderSetup = getMissingProviderSetup(modelId);
    if (missingProviderSetup) {
      console.error(missingProviderSetup);
      process.exitCode = 1;
      return;
    }
    console.log("🔗 Starting ACP server over stdio...");
    await startAcpServer(
      (requestedModelId, targetWorkspace) =>
        createCodingAgent(
          requestedModelId || modelId,
          targetWorkspace || workspaceRoot,
        ),
      workspaceRoot,
    );
  } else if (argv.chat) {
    // Interactive chat mode
    const missingProviderSetup = getMissingProviderSetup(modelId, process.env, "chat");
    if (missingProviderSetup) {
      console.error(missingProviderSetup);
      process.exitCode = 1;
      return;
    }
    const agent = await createCodingAgent(modelId, workspaceRoot);
    console.log(`💬 Entering chat mode (type "exit" to quit)`);
    await startChatMode(agent, workspaceRoot, modelId);
  } else {
    // Default: show help
    yargs(hideBin(process.argv))
      .showHelp();
  }
}

/**
 * Extract a short, human-readable message from an error thrown by the agent
 * (including AI SDK `APICallError` instances from provider calls), instead of
 * dumping the full error object with headers, request/response bodies, and
 * stack traces to the terminal.
 */
function formatCliError(error: unknown): string {
  if (!error || typeof error !== "object") {
    return String(error);
  }

  const err = error as Record<string, unknown>;
  const parts: string[] = [];

  const baseMessage = typeof err.message === "string" ? err.message.trim() : "";
  if (baseMessage) {
    parts.push(baseMessage);
  }

  // AI SDK `APICallError` (and similar) expose statusCode/url/responseBody.
  // Surface a compact "(HTTP <code> from <url>)" suffix when available.
  const statusCode = typeof err.statusCode === "number" ? err.statusCode : undefined;
  const url = typeof err.url === "string" ? err.url : undefined;
  if (statusCode || url) {
    const location = [
      statusCode ? `HTTP ${statusCode}` : undefined,
      url ? `from ${url}` : undefined,
    ]
      .filter(Boolean)
      .join(" ");
    if (location) {
      parts.push(`(${location})`);
    }
  }

  // Try to pull a more specific message out of the provider's response body,
  // which is often more actionable than the generic AI SDK message.
  const providerMessage = extractProviderErrorMessage(err);
  if (providerMessage && providerMessage !== baseMessage) {
    parts.push(`- ${providerMessage}`);
  }

  if (parts.length === 0) {
    return error instanceof Error ? error.message : String(error);
  }

  const cause = (err as { cause?: unknown }).cause;
  const causeMessage =
    cause && cause !== error ? formatCliError(cause) : undefined;

  return causeMessage && !parts.join(" ").includes(causeMessage)
    ? `${parts.join(" ")} (caused by: ${causeMessage})`
    : parts.join(" ");
}

function extractProviderErrorMessage(
  err: Record<string, unknown>,
): string | undefined {
  const data = err.data as { error?: { message?: unknown } } | undefined;
  if (typeof data?.error?.message === "string") {
    return data.error.message;
  }

  const responseBody = err.responseBody;
  if (typeof responseBody === "string") {
    try {
      const parsed = JSON.parse(responseBody) as {
        error?: { message?: unknown };
      };
      if (typeof parsed?.error?.message === "string") {
        return parsed.error.message;
      }
    } catch {
      // responseBody wasn't JSON; ignore.
    }
  }

  return undefined;
}

/**
 * Produce an actionable one-line hint for common, recognizable failure
 * modes (bad model ID, missing/invalid API key, rate limiting, network
 * issues) so users aren't left staring at a raw provider error message.
 */
function getCliErrorHint(error: unknown, modelId?: string): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const err = error as Record<string, unknown>;
  const statusCode = typeof err.statusCode === "number" ? err.statusCode : undefined;
  const message = (
    (typeof err.message === "string" ? err.message : "") +
    " " +
    (extractProviderErrorMessage(err) || "")
  ).toLowerCase();
  const code = typeof err.code === "string" ? err.code : undefined;

  const modelHint = modelId ? ` (currently "${modelId}")` : "";

  if (
    statusCode === 404 &&
    (message.includes("no endpoints found") || message.includes("not found"))
  ) {
    return `💡 The model ID${modelHint} doesn't exist or isn't available from the provider. Double-check the spelling/provider prefix (e.g. "openrouter/anthropic/claude-sonnet-4.5") and pass a valid one via --modelId.`;
  }

  if (statusCode === 401 || message.includes("unauthorized") || message.includes("invalid api key")) {
    return "💡 Authentication failed. Check that the API key for this provider is set (e.g. OPENROUTER_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY) and hasn't expired.";
  }

  if (statusCode === 403) {
    return "💡 The request was forbidden. Your API key may lack access to this model or your account may need billing/credits set up.";
  }

  if (statusCode === 429 || message.includes("rate limit")) {
    return "💡 You've hit a rate limit or quota. Wait a moment and try again, or check your provider's usage/billing dashboard.";
  }

  if (statusCode && statusCode >= 500) {
    return "💡 The model provider is having issues on its end. Try again shortly, or switch to a different model/provider with --modelId.";
  }

  if (
    code === "ENOTFOUND" ||
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    message.includes("fetch failed") ||
    message.includes("network")
  ) {
    return "💡 Couldn't reach the model provider. Check your internet connection (and any proxy/firewall settings) and try again.";
  }

  return undefined;
}

async function startChatMode(agent: any, workspaceRoot?: string, modelId?: string) {
  const readline = await import("readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const question = (prompt: string) =>
    new Promise<string>((resolve) => rl.question(prompt, resolve));

  const threadId = `cli-chat-${Date.now()}`;
  const resourceId = `cli-session`;

  try {
    while (true) {
      const input = await question("\n> ");
      const trimmedInput = input.trim();

      if (!trimmedInput) {
        continue;
      }

      if (trimmedInput.toLowerCase() === "exit" || trimmedInput.toLowerCase() === "quit") {
        console.log("👋 Goodbye!");
        break;
      }

      let stopSpinner = (): void => {};
      try {
        const options: Record<string, unknown> = {
          // Use the preferred nested `memory` scope (flat threadId/resourceId
          // is deprecated) so conversation history is reliably threaded
          // across turns within this chat session.
          memory: { thread: threadId, resource: resourceId },
          maxSteps: 50,
          workspaceRoot,
        };

        stopSpinner = startCliSpinner("Thinking...");

        if (typeof agent.stream === "function") {
          const streamResult = await agent.stream(trimmedInput, options);
          const reader = streamResult.fullStream.getReader();
          const pendingToolCallIds = new Map<string, number>();
          let anonymousToolCalls = 0;
          let hasOutput = false;

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            if (value?.type === "text-delta" || value?.type === "reasoning-delta") {
              const text = String(value.payload?.text || "");
              if (text) {
                stopSpinner();
                stopSpinner = () => {};
                process.stdout.write(text);
                hasOutput = true;
              }
            } else if (value?.type === "tool-call") {
              stopSpinner();
              process.stdout.write("\n");
              const toolName =
                typeof value.payload?.toolName === "string"
                  ? value.payload.toolName
                  : "tool";
              const toolCallId =
                typeof value.payload?.toolCallId === "string"
                  ? value.payload.toolCallId
                  : undefined;
              if (toolCallId) {
                pendingToolCallIds.set(
                  toolCallId,
                  (pendingToolCallIds.get(toolCallId) || 0) + 1,
                );
              } else {
                anonymousToolCalls += 1;
              }
              process.stdout.write(`⚙️  [Calling tool: ${toolName}]...\n`);
              stopSpinner = startCliSpinner(
                pendingToolCallIds.size + anonymousToolCalls > 1
                  ? "Running tools..."
                  : `Running ${toolName}...`,
              );
            } else if (value?.type === "tool-result") {
              const toolCallId =
                typeof value.payload?.toolCallId === "string"
                  ? value.payload.toolCallId
                  : undefined;
              const toolResultPayload =
                value.payload?.result ??
                value.payload?.output ??
                value.payload?.content ??
                value.payload?.data;
              const executionStatus = resolveToolExecutionStatus(
                toolResultPayload,
              );
              const isSettled =
                executionStatus !== "pending" &&
                executionStatus !== "in_progress";

              if (isSettled) {
                if (toolCallId) {
                  const pendingCount = pendingToolCallIds.get(toolCallId) || 0;
                  if (pendingCount > 1) {
                    pendingToolCallIds.set(toolCallId, pendingCount - 1);
                  } else if (pendingCount === 1) {
                    pendingToolCallIds.delete(toolCallId);
                  }
                } else if (anonymousToolCalls > 0) {
                  anonymousToolCalls -= 1;
                }
                if (!isCliSpinnerEnabled()) {
                  // Preserve a completion marker for redirected/CI output
                  // where the animated spinner itself never renders anything.
                  process.stdout.write("done.\n");
                }
              }
              const pendingToolCount =
                [...pendingToolCallIds.values()].reduce(
                  (total, count) => total + count,
                  0,
                ) + anonymousToolCalls;
              if (pendingToolCount === 0) {
                stopSpinner();
                stopSpinner = startCliSpinner("Thinking...");
              }
            }
          }

          stopSpinner();
          if (!hasOutput && streamResult.text) {
            const final = await streamResult.text;
            if (final) {
              console.log(final);
            }
          }
          console.log();
        } else if (typeof agent.generate === "function") {
          const result = await agent.generate(trimmedInput, options);
          stopSpinner();
          const text =
            typeof result === "string"
              ? result
              : result?.text || JSON.stringify(result, null, 2);
          console.log("\n✅ Agent Response:\n" + text);
        } else {
          throw new Error("Agent does not support streaming or text generation");
        }
      } catch (error) {
        stopSpinner();
        stopSpinner = () => {};
        console.error(`❌ Error: ${formatCliError(error)}`);
        const hint = getCliErrorHint(error, modelId);
        if (hint) {
          console.error(hint);
        }
      } finally {
        stopSpinner();
      }
    }
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error(`❌ Fatal error: ${formatCliError(error)}`);
  const hint = getCliErrorHint(error);
  if (hint) {
    console.error(hint);
  }
  process.exit(1);
});
