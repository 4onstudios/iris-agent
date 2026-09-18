#!/usr/bin/env node

/**
 * CLI Wrapper for iris-agent
 * This script uses tsx to run the CLI TypeScript code
 */

import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");

const tsxCliPath = join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
const result = spawnSync(process.execPath, [tsxCliPath, join(projectRoot, "cli.ts"), ...process.argv.slice(2)], {
  stdio: "inherit",
  cwd: projectRoot,
});

if (result.error) {
  console.error("Failed to start Iris Agent CLI:", result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
