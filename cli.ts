#!/usr/bin/env node

/**
 * iris-agent CLI with ACP (Agent Client Protocol) support
 * Usage:
 *   iris-agent --workspace /path/to/workspace --acp
 *   iris-agent --chat --workspace /path/to/workspace
 */

import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { createCodingAgent } from "./api/core/agent/index.js";
import { startAcpServer } from "./api/acp/acpServer.js";

const argv = yargs(hideBin(process.argv))
  .option("workspace", {
    alias: "w",
    type: "string",
    description: "Workspace root path",
    required: true,
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
  .option("port", {
    alias: "p",
    type: "number",
    description: "Port for ACP server",
    default: 3000,
  })
  .help()
  .parseSync();

async function main() {
  const workspaceRoot = argv.workspace as string;

  console.log(`🚀 Iris Agent CLI`);
  console.log(`📁 Workspace: ${workspaceRoot}`);

  // Create agent instance
  const agent = await createCodingAgent("gpt-4", workspaceRoot);

  if (argv.acp) {
    // Start ACP server mode
    console.log(`🔗 Starting ACP server on port ${argv.port}...`);
    await startAcpServer(agent, argv.port as number);
  } else if (argv.chat) {
    // Interactive chat mode
    console.log(`💬 Entering chat mode (type "exit" to quit)`);
    await startChatMode(agent);
  } else {
    // Default: show help
    yargs(hideBin(process.argv))
      .showHelp();
  }
}

async function startChatMode(agent: any) {
  const readline = await import("readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const question = (prompt: string) =>
    new Promise<string>((resolve) => rl.question(prompt, resolve));

  try {
    while (true) {
      const input = await question("\n> ");

      if (input.toLowerCase() === "exit") {
        console.log("👋 Goodbye!");
        break;
      }

      try {
        console.log("🤔 Processing...");
        const response = await agent.chat({
          messages: [{ role: "user", content: input }],
        });

        console.log("\n✅ Agent Response:");
        console.log(response);
      } catch (error) {
        console.error("❌ Error:", error);
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
