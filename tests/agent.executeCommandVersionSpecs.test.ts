import { executeCommand } from "../api/core/agent/tools/executeCommand";

describe("executeCommand package version spec handling", () => {
  it("does not force shell mode for conda-style >= version specs", async () => {
    const result = await executeCommand({
      command: "echo numpy>=1.24 scipy>=1.10",
      cwd: process.cwd(),
      workspaceRoot: process.cwd(),
      skipConfirmation: true,
    });

    expect(result.success).toBe(true);
    expect(result.stdout).toContain("numpy>=1.24");
    expect(result.stdout).toContain("scipy>=1.10");
  });

  it("does not force shell mode for pip-style <= version specs", async () => {
    const result = await executeCommand({
      command: "echo package<=2.0",
      cwd: process.cwd(),
      workspaceRoot: process.cwd(),
      skipConfirmation: true,
    });

    expect(result.success).toBe(true);
    expect(result.stdout).toContain("package<=2.0");
  });

  it("still uses shell mode for actual output redirection", async () => {
    const result = await executeCommand({
      command: "node -e \"console.log('hello')\" > /tmp/iris-test-redirect.txt",
      cwd: process.cwd(),
      workspaceRoot: process.cwd(),
      skipConfirmation: true,
    });

    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
  });
});
