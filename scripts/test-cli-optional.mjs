import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "iris-agent-optional-"));
try {
  if (process.argv.includes("--check-yarn-install")) {
    const installRoot = path.join(root, "yarn-install");
    await fs.mkdir(installRoot);
    const manifest = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8"));
    await fs.writeFile(path.join(installRoot, "package.json"), JSON.stringify({
      private: true,
      license: manifest.license,
      engines: manifest.engines,
      optionalDependencies: manifest.optionalDependencies,
    }));
    execFileSync("yarn", ["install", "--ignore-scripts", "--non-interactive", "--no-lockfile"], {
      cwd: installRoot,
      stdio: "inherit",
    });
    const [major, minor] = process.versions.node.split(".").map(Number);
    assert.ok(
      major > 26 || (major === 26 && minor >= 4),
      "Yarn install validation requires Node.js >=26.4.0.",
    );
    await fs.access(path.join(installRoot, "node_modules/@opentui/core"));
  }
  for (const entry of [
    "api", "scripts", "tests", "index.ts", "server.ts", "cli.ts",
    "package.json", "tsconfig.json", "tsconfig.build.json",
  ]) {
    await fs.cp(path.join(packageRoot, entry), path.join(root, entry), { recursive: true });
  }
  const modules = path.join(root, "node_modules");
  await fs.mkdir(modules);
  for (const entry of await fs.readdir(path.join(packageRoot, "node_modules"))) {
    if (entry === "@opentui" || entry === "web-tree-sitter") continue;
    await fs.symlink(path.join(packageRoot, "node_modules", entry), path.join(modules, entry));
  }
  for (const project of ["tsconfig.json", "tsconfig.build.json"]) {
    const output = execFileSync(process.execPath, [
      "scripts/compile.mjs", "--project", project,
      ...(project === "tsconfig.json" ? ["--noEmit"] : []),
    ], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    assert.equal(output, "");
  }
  assert.equal(
    await fs.stat(path.join(root, "dist/api/core/library/cliOpenTui.js")).then(
      () => true,
      (error) => {
        if (error.code !== "ENOENT") throw error;
        return false;
      },
    ),
    false,
  );
  execFileSync(process.execPath, ["scripts/fix-esm-import-specifiers.mjs"], { cwd: root });
  execFileSync(process.execPath, ["--input-type=module", "-e", [
    'import { createCliChatUi } from "./dist/api/core/library/cliChatUi.js";',
    'const ui = await createCliChatUi({ mode: "plain" });',
    "ui.dispose();",
  ].join("\n")], { cwd: root, stdio: "inherit" });
  console.log("Build, typecheck and plain chat pass without optional OpenTUI dependencies.");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
