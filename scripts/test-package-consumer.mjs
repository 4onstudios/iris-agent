import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const consumerRoot = await fs.mkdtemp(
  path.join(os.tmpdir(), "iris-agent-consumer-"),
);

try {
  const packageScope = path.join(
    consumerRoot,
    "node_modules",
    "@4onstudios",
  );
  await fs.mkdir(packageScope, { recursive: true });
  await fs.symlink(packageRoot, path.join(packageScope, "iris-agent"), "dir");

  await fs.writeFile(
    path.join(consumerRoot, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  await fs.writeFile(
    path.join(consumerRoot, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        noEmit: true,
        strict: true,
        // Validate our package export surface from a consumer project without
        // failing on transitive third-party declaration issues.
        skipLibCheck: true,
      },
      files: ["consumer.ts"],
    }),
  );
  await fs.writeFile(
    path.join(consumerRoot, "consumer.ts"),
    [
      'import { IrisClient, startAcpServer } from "@4onstudios/iris-agent";',
      'import agentRouter from "@4onstudios/iris-agent/api/agent";',
      'import { createCodingAgent, getSkillsDir } from "@4onstudios/iris-agent/api/core/agent/index";',
      'import type { AgentFactoryOptions } from "@4onstudios/iris-agent/api/core/agent/index";',
      'import { listMcpServerTools } from "@4onstudios/iris-agent/api/core/agent/tools/mcpTools";',
      "void [IrisClient, startAcpServer, agentRouter, createCodingAgent, getSkillsDir, listMcpServerTools];",
      "const options: AgentFactoryOptions = {",
      '  instructions: "You are a helpful assistant.",',
      "  disableWorkspaceTools: true,",
      "  disableSkills: true,",
      '  allowedToolNames: ["webSearch", "fetchWebpage"] as const,',
      "  enableMemory: false,",
      "};",
      "void (() => createCodingAgent('openai/gpt-4o', null, options));",
      "",
    ].join("\n"),
  );

  execFileSync(
    path.join(packageRoot, "node_modules", ".bin", "tsc"),
    ["--project", path.join(consumerRoot, "tsconfig.json")],
    { cwd: consumerRoot, stdio: "inherit" },
  );

  await fs.writeFile(
    path.join(consumerRoot, "consumer-runtime.mjs"),
    [
      'import assert from "node:assert/strict";',
      'import fs from "node:fs/promises";',
      'import path from "node:path";',
      'import { mock } from "node:test";',
      'import { createCodingAgent, CODING_AGENT_INSTRUCTIONS, getSkillsDir } from "@4onstudios/iris-agent/api/core/agent/index";',
      `import { coreLsp } from ${JSON.stringify(pathToFileURL(path.join(packageRoot, "dist/api/core/library/lsp/coreLsp.js")).href)};`,
      "",
      "const skillsDir = getSkillsDir();",
      "const stats = await fs.stat(skillsDir);",
      "if (!stats.isDirectory()) {",
      '  throw new Error(`getSkillsDir() did not resolve a directory: ${skillsDir}`);',
      "}",
      "const normalizedSkillsDir = skillsDir.split(path.sep).join('/');",
      "if (!normalizedSkillsDir.endsWith('/dist/api/core/skills')) {",
      "  throw new Error(",
      "    `getSkillsDir() resolved outside package assets: ${normalizedSkillsDir}`",
      "  );",
      "}",
      "const entries = await fs.readdir(skillsDir);",
      "if (entries.length === 0) {",
      '  throw new Error(`skills directory is empty: ${skillsDir}`);',
      "}",
      "",
      'const workspacePath = path.join(process.cwd(), "disabled-workspace");',
      'const connect = mock.method(coreLsp, "connect", () => {});',
      "const embeddedOptions = {",
      "  disableWorkspaceTools: true,",
      "  disableSkills: true,",
      "  enableMemory: false,",
      "};",
      'const agent = await createCodingAgent("openai/gpt-4o", workspacePath, {',
      "  ...embeddedOptions,",
      '  instructions: "Custom embedded instructions",',
      '  allowedToolNames: ["fetchWebpage", "unknownTool"],',
      "});",
      'assert.equal(await agent.getInstructions(), "Custom embedded instructions");',
      "assert.equal(await agent.getWorkspace(), undefined);",
      'assert.deepEqual(Object.keys(await agent.getToolsForExecution({})), ["fetchWebpage"]);',
      'await assert.rejects(fs.stat(workspacePath), { code: "ENOENT" });',
      "assert.equal(connect.mock.callCount(), 0);",
      "",
      'const noToolsAgent = await createCodingAgent("openai/gpt-4o", null, {',
      "  ...embeddedOptions,",
      '  instructions: "",',
      "  allowedToolNames: [],",
      "});",
      'assert.equal(await noToolsAgent.getInstructions(), "");',
      "assert.deepEqual(Object.keys(await noToolsAgent.getToolsForExecution({})), []);",
      "",
      'const defaultAgent = await createCodingAgent("ollama/qwen2.5-coder", null, embeddedOptions);',
      "assert.equal(await defaultAgent.getInstructions(), CODING_AGENT_INSTRUCTIONS);",
      "const defaultTools = await defaultAgent.getToolsForExecution({});",
      'assert.ok(defaultTools.readFile);',
      'assert.ok(defaultTools.runTerminalCommand);',
      'assert.ok(defaultTools.fetchWebpage);',
      "",
      'const localWorkspacePath = path.join(process.cwd(), "local-workspace");',
      "await fs.mkdir(localWorkspacePath);",
      'const localAgent = await createCodingAgent("ollama/qwen2.5-coder", localWorkspacePath, {',
      "  enableMemory: false,",
      "  disableSkills: true,",
      '  allowedToolNames: ["readFile", "fetchWebpage"],',
      "});",
      "assert.ok(await localAgent.getWorkspace());",
      "assert.equal(connect.mock.callCount(), 1);",
      'assert.deepEqual(Object.keys(await localAgent.getToolsForExecution({})).sort(), ["fetchWebpage", "readFile"]);',
      "mock.restoreAll();",
      "",
    ].join("\n"),
  );

  execFileSync(process.execPath, [path.join(consumerRoot, "consumer-runtime.mjs")], {
    cwd: consumerRoot,
    stdio: "inherit",
  });
} finally {
  await fs.rm(consumerRoot, { recursive: true, force: true });
}
