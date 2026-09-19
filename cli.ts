#!/usr/bin/env node

/**
 * iris-agent CLI with ACP (Agent Client Protocol) support
 * Usage:
 *   iris-agent --acp
 *   iris-agent --workspace /path/to/workspace --modelId openrouter/openai/gpt-4o --chat
 */

import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { createCodingAgent } from "./api/core/agent/index.js";
import { startAcpServer } from "./api/acp/acpServer.js";
import { getMissingProviderSetup } from "./api/acp/providerSetup.js";
import { startCliSpinner } from "./api/core/library/cliSpinner.js";

const defaultModelId =
  process.env.MODEL_ID ||
  process.env.OPENROUTER_MODEL ||
  "openrouter/openai/gpt-4o";

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
    const agent = await createCodingAgent(modelId, workspaceRoot);
    console.log(`💬 Entering chat mode (type "exit" to quit)`);
    await startChatMode(agent, workspaceRoot);
  } else {
    // Default: show help
    yargs(hideBin(process.argv))
      .showHelp();
  }
}

async function startChatMode(agent: any, workspaceRoot?: string) {
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
          threadId,
          resourceId,
          maxSteps: 50,
          workspaceRoot,
        };

        stopSpinner = startCliSpinner("Thinking...");

        if (typeof agent.stream === "function") {
          const streamResult = await agent.stream(trimmedInput, options);
          stopSpinner();
          stopSpinner = () => {};
          const reader = streamResult.fullStream.getReader();
          let hasOutput = false;

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            if (value?.type === "text-delta" || value?.type === "reasoning-delta") {
              stopSpinner();
              stopSpinner = () => {};
              const text = String(value.payload?.text || "");
              if (text) {
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
              process.stdout.write(`⚙️  [Calling tool: ${toolName}]...\n`);
              stopSpinner = startCliSpinner(`Running ${toolName}...`);
            } else if (value?.type === "tool-result") {
              stopSpinner();
              stopSpinner = startCliSpinner("Thinking...");
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
        console.error("❌ Error:", error);
      } finally {
        stopSpinner();
      }
    }
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error("❌ Fatal error:", error);
  process.exit(1);
});
