import fs from "fs";
import os from "os";
import path from "path";
import { executeCommand } from "../api/core/agent/tools/executeCommand";

describe("executeCommand workspace root inference", () => {
  const originalCwd = process.cwd();

  afterEach(() => {
    process.chdir(originalCwd);
  });

  it("allows command execution when process cwd is a nested workspace folder", async () => {
    const repoRoot = originalCwd;
    const nestedWorkspaceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "iris-agent-nested-workspace-"),
    );

    process.chdir(nestedWorkspaceDir);

    const result = await executeCommand({
      command: "pwd",
      cwd: repoRoot,
      skipConfirmation: true,
    });

    expect(result.success).toBe(true);
    expect((result.stdout as string) || "").toContain(repoRoot);

    fs.rmSync(nestedWorkspaceDir, { recursive: true, force: true });
  });
});
