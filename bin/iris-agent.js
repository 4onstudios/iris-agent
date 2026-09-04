#!/usr/bin/env node

/**
 * CLI Wrapper for iris-agent
 * This script uses tsx to run the CLI TypeScript code
 */

import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");

try {
  execSync(
    `tsx ${join(projectRoot, "cli.ts")} ${process.argv.slice(2).join(" ")}`,
    {
      stdio: "inherit",
      cwd: projectRoot,
    }
  );
} catch (error) {
  process.exit(1);
}
