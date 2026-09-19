#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";

const formulaPath = process.argv[2];
const requestedVersion = process.argv[3];

if (!formulaPath) {
  throw new Error("Usage: node scripts/update-homebrew-formula.mjs <formula-path> [version]");
}

const packageMetadata = await fetch(
  requestedVersion
    ? `https://registry.npmjs.org/@4onstudios%2firis-agent/${requestedVersion}`
    : "https://registry.npmjs.org/@4onstudios%2firis-agent/latest",
).then(async (response) => {
  if (!response.ok) {
    throw new Error(`Unable to fetch npm metadata: HTTP ${response.status}`);
  }
  return response.json();
});

const version = packageMetadata.version;
const tarballUrl = packageMetadata.dist?.tarball;
if (!version || !tarballUrl) {
  throw new Error("npm metadata did not include a version and tarball URL");
}

const tarball = await fetch(tarballUrl).then(async (response) => {
  if (!response.ok) {
    throw new Error(`Unable to fetch npm tarball: HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
});
const sha256 = createHash("sha256").update(tarball).digest("hex");

const formula = await readFile(formulaPath, "utf8");
const updatedFormula = formula
  .replace(
    /url "https:\/\/registry\.npmjs\.org\/@4onstudios\/iris-agent\/-\/iris-agent-[^"]+\.tgz"/,
    `url "${tarballUrl}"`,
  )
  .replace(/sha256 "[a-f0-9]+"/, `sha256 "${sha256}"`);

if (updatedFormula === formula) {
  console.log(`Homebrew formula already points to ${version}.`);
  process.exit(0);
}

await writeFile(formulaPath, updatedFormula);
console.log(`Updated Homebrew formula to ${version} (${sha256}).`);
