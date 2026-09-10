import path from "path";
import { assertAcpWorkspace } from "../api/acp/acpServer";

describe("ACP workspace binding", () => {
  const workspaceRoot = path.resolve("/tmp/iris-workspace");

  it("allows requests without a workspace override", () => {
    expect(() => assertAcpWorkspace({}, workspaceRoot)).not.toThrow();
  });

  it("allows the workspace used to start the process", () => {
    expect(() =>
      assertAcpWorkspace({ workspaceRoot }, workspaceRoot),
    ).not.toThrow();
    expect(() =>
      assertAcpWorkspace({ cwd: workspaceRoot }, workspaceRoot),
    ).not.toThrow();
  });

  it("requires a respawn before switching workspaces", () => {
    expect(() =>
      assertAcpWorkspace(
        { workspaceRoot: path.resolve("/tmp/other-workspace") },
        workspaceRoot,
      ),
    ).toThrow(/Close it and respawn iris-agent/);
  });

  it("rejects a cwd that differs from the startup workspace", () => {
    expect(() =>
      assertAcpWorkspace(
        { cwd: path.resolve("/tmp/other-workspace") },
        workspaceRoot,
      ),
    ).toThrow(/Close it and respawn iris-agent/);
  });
});
