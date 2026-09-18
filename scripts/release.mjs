#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const args = new Set(process.argv.slice(2));
const shouldPublish = args.has("--publish");
const allowDirty = args.has("--allow-dirty");

const usage = `Usage:
  npm run release
      Validate the package and run npm pack --dry-run.

  NPM_CONFIG_OTP=<code> npm run release:publish
      Validate the package, run npm pack --dry-run, then publish to npm.

Options:
  --publish      Publish to npm after validation.
  --allow-dirty  Skip the clean git worktree check.
  --help         Show this help text.`;

if (args.has("--help") || args.has("-h")) {
  console.log(usage);
  process.exit(0);
}

const run = (command, commandArgs, options = {}) => {
  const result = spawnSync(command, commandArgs, {
    stdio: "inherit",
    shell: false,
    ...options,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(" ")} failed with exit code ${result.status}`);
  }
};

const capture = (command, commandArgs) => {
  const result = spawnSync(command, commandArgs, {
    encoding: "utf8",
    shell: false,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(" ")} failed with exit code ${result.status}`);
  }

  return result.stdout.trim();
};

const parseVersion = (version) => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) {
    throw new Error(`Could not parse version: ${version}`);
  }

  return match.slice(1).map(Number);
};

const isAtLeast = (actual, minimum) => {
  const actualParts = parseVersion(actual);
  const minimumParts = parseVersion(minimum);

  for (let index = 0; index < minimumParts.length; index += 1) {
    if (actualParts[index] > minimumParts[index]) return true;
    if (actualParts[index] < minimumParts[index]) return false;
  }

  return true;
};

const minimumNode = packageJson.engines?.node?.match(/>=\s*([0-9.]+)/)?.[1];
if (minimumNode && !isAtLeast(process.version, minimumNode)) {
  throw new Error(
    `Release requires Node ${packageJson.engines.node}; current runtime is ${process.version}.`,
  );
}

if (!allowDirty) {
  const status = capture("git", ["status", "--porcelain"]);
  if (status) {
    throw new Error("Git worktree is not clean. Commit or stash changes before releasing.");
  }
}

console.log(`Preparing ${packageJson.name}@${packageJson.version}`);

run("npm", ["run", "typecheck"]);
run("npm", ["test", "--", "--runInBand"]);
run("npm", ["run", "build"]);
run("npm", ["pack", "--dry-run"]);

if (shouldPublish) {
  run("npm", ["publish", "--access", packageJson.publishConfig?.access || "public"]);
  console.log(`Published ${packageJson.name}@${packageJson.version}`);
} else {
  console.log("Release validation complete. Run `NPM_CONFIG_OTP=<code> npm run release:publish` to publish.");
}
