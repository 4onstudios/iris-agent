import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  createWorkspaceTools,
  LocalFilesystem,
  Workspace,
  WORKSPACE_TOOLS,
} from "@mastra/core/workspace";
import { WorkspaceMutationBridge } from "../api/core/agent/utils/workspaceMutationBridge";

describe("WorkspaceMutationBridge", () => {
  it("preserves diff and validation evidence for Workspace writes", async () => {
    const basePath = await fs.mkdtemp(path.join(os.tmpdir(), "iris-workspace-bridge-"));
    const filePath = path.join(basePath, "example.ts");
    const validation = {
      lint: {
        enabled: true,
        success: false,
        stdout: "",
        stderr: "lint failed",
      },
    };
    const validate = jest.fn(async () => validation);
    const bridge = new WorkspaceMutationBridge(basePath, validate);
    const context = { toolCallId: "call-write" };

    try {
      await fs.writeFile(filePath, "export const value = 1;\n", "utf8");
      const workspace = new Workspace({
        filesystem: new LocalFilesystem({ basePath }),
        tools: {
          hooks: bridge.hooks,
          [WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE]: { name: "writeFile" },
        },
      });
      const tools = await createWorkspaceTools(workspace);
      const result = await tools.writeFile.execute(
        { path: "example.ts", content: "export const value = 2;\n" },
        context,
      );

      const updateToolInvocation = jest.fn();
      const messageList = { updateToolInvocation };
      await bridge.processToolResult({
        toolName: "writeFile",
        toolCallId: "call-write",
        args: { path: "example.ts" },
        result,
        messageList,
      } as never);

      expect(validate).toHaveBeenCalledTimes(1);
      expect(updateToolInvocation).toHaveBeenCalledWith({
        type: "tool-invocation",
        toolInvocation: expect.objectContaining({
          state: "result",
          toolCallId: "call-write",
          toolName: "writeFile",
          result: expect.objectContaining({
            success: true,
            filePath,
            fileExisted: true,
            oldContent: "export const value = 1;\n",
            newContent: "export const value = 2;\n",
            linesAdded: 1,
            linesRemoved: 1,
            validation,
          }),
        }),
      });
    } finally {
      await fs.rm(basePath, { recursive: true, force: true });
    }
  });

  it("marks failed Workspace edits without running validation", async () => {
    const validate = jest.fn(async () => null);
    const bridge = new WorkspaceMutationBridge(process.cwd(), validate);
    const context = { toolCallId: "call-edit" };
    const input = { path: "missing.ts" };

    await bridge.hooks.beforeToolCall?.({
      toolName: "editFile",
      workspaceToolName: WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE,
      input,
      context,
    });
    await bridge.hooks.afterToolCall?.({
      toolName: "editFile",
      workspaceToolName: WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE,
      input,
      context,
      output: "Could not find the requested text",
    });

    const updateToolInvocation = jest.fn();
    await bridge.processToolResult({
      toolName: "editFile",
      toolCallId: "call-edit",
      args: input,
      result: "Could not find the requested text",
      messageList: { updateToolInvocation },
    } as never);

    expect(validate).not.toHaveBeenCalled();
    expect(updateToolInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        toolInvocation: expect.objectContaining({
          result: expect.objectContaining({
            success: false,
            error: "Could not find the requested text",
          }),
        }),
      }),
    );
  });

  it.each([
    ["direct", { success: false, error: "write failed" }],
    ["value-wrapped", { value: { success: false, error: "write failed" } }],
  ])(
    "marks %s structured Workspace failures without running validation",
    async (_shape, failedResult) => {
      const basePath = await fs.mkdtemp(
        path.join(os.tmpdir(), "iris-workspace-bridge-failure-"),
      );
      const validate = jest.fn(async () => null);
      const bridge = new WorkspaceMutationBridge(basePath, validate);
      const context = { toolCallId: `call-${_shape}` };
      const input = { path: "example.ts" };

      try {
        await bridge.hooks.beforeToolCall?.({
          toolName: "writeFile",
          workspaceToolName: WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE,
          input,
          context,
        });
        await bridge.hooks.afterToolCall?.({
          toolName: "writeFile",
          workspaceToolName: WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE,
          input,
          context,
          output: failedResult,
        });

        const updateToolInvocation = jest.fn();
        await bridge.processToolResult({
          toolName: "writeFile",
          toolCallId: context.toolCallId,
          args: input,
          result: failedResult,
          messageList: { updateToolInvocation },
        } as never);

        expect(validate).not.toHaveBeenCalled();
        expect(updateToolInvocation).toHaveBeenCalledWith(
          expect.objectContaining({
            toolInvocation: expect.objectContaining({
              result: expect.objectContaining({
                success: false,
                error: "write failed",
              }),
            }),
          }),
        );
      } finally {
        await fs.rm(basePath, { recursive: true, force: true });
      }
    },
  );
});