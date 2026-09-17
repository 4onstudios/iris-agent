import path from "path";
import {
  assertAcpWorkspace,
  createAcpAgentApp,
  type AcpRuntimeAgent,
} from "../api/acp/acpServer";
import * as acp from "@agentclientprotocol/sdk";

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

  it("accepts workspaceRoot when creating a session", async () => {
    const runtime: AcpRuntimeAgent = {};
    const client = acp.client({ name: "iris-agent-test-client" });

    await client.connectWith(createAcpAgentApp(runtime), async (ctx) => {
      const session = await ctx.request(acp.methods.agent.session.new, {
        cwd: workspaceRoot,
        mcpServers: [],
        workspaceRoot,
      } as never);
      await expect(
        ctx.request(acp.methods.agent.session.close, {
          sessionId: session.sessionId,
        }),
      ).resolves.toEqual({});
    });
  });
});
