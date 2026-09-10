import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
      'import { listMcpServerTools } from "@4onstudios/iris-agent/api/core/agent/tools/mcpTools";',
      "void [IrisClient, startAcpServer, agentRouter, createCodingAgent, getSkillsDir, listMcpServerTools];",
      "",
    ].join("\n"),
  );

  execFileSync(
    path.join(packageRoot, "node_modules", ".bin", "tsc"),
    ["--project", path.join(consumerRoot, "tsconfig.json")],
    { cwd: consumerRoot, stdio: "inherit" },
  );
} finally {
  await fs.rm(consumerRoot, { recursive: true, force: true });
}
