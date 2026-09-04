import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  createWorkspaceTools,
  LocalFilesystem,
  Workspace,
  WORKSPACE_TOOLS,
} from "@mastra/core/workspace";
import { CapturedWorkspaceMutationBridge } from "../api/core/agent/utils/capturedWorkspaceMutationBridge";

describe("CapturedWorkspaceMutationBridge", () => {
  const requestContext = (generationId: string) => ({
    get: (key: string) =>
      key === "workspaceMutationGenerationId" ? generationId : undefined,
  });

  it("drains the canonical mutation result once", async () => {
    const basePath = await fs.mkdtemp(path.join(os.tmpdir(), "iris-captured-bridge-"));
    const filePath = path.join(basePath, "example.ts");
    const bridge = new CapturedWorkspaceMutationBridge(basePath, async () => null);
    const context = { toolCallId: "call-edit" };

    try {
      await fs.writeFile(filePath, "export const value = 1;\n", "utf8");
      const workspace = new Workspace({
        filesystem: new LocalFilesystem({ basePath }),
        tools: {
          hooks: bridge.hooks,
          [WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE]: { name: "editFile" },
        },
      });
      const tools = await createWorkspaceTools(workspace);
      const result = await tools.editFile.execute(
        { path: "example.ts", old_string: "value = 1", new_string: "value = 2" },
        context,
      );

      const messageList = { updateToolInvocation: jest.fn() };
      const processedMessageList = await bridge.processToolResult({
        toolName: "editFile",
        toolCallId: "call-edit",
        args: { path: "example.ts" },
        result,
        messageList,
        requestContext: requestContext("generation-edit"),
      } as never);

      expect(processedMessageList).toBe(messageList);
      expect(bridge.takeProcessedResults("generation-edit", ["call-edit"])).toEqual([
        {
          toolCallId: "call-edit",
          result: expect.objectContaining({
            success: true,
            filePath,
            oldContent: "export const value = 1;\n",
            newContent: "export const value = 2;\n",
            linesAdded: 1,
            linesRemoved: 1,
          }),
        },
      ]);
      expect(bridge.takeProcessedResults("generation-edit", ["call-edit"])).toEqual([]);
    } finally {
      await fs.rm(basePath, { recursive: true, force: true });
    }
  });

  it("captures and forwards mutation metadata only after secret redaction", async () => {
    const basePath = await fs.mkdtemp(path.join(os.tmpdir(), "iris-captured-bridge-"));
    const filePath = path.join(basePath, "secrets.ts");
    const bridge = new CapturedWorkspaceMutationBridge(basePath, async () => null);
    const oldSecret = "sk-abcdefghijklmnopqrstuvwxyz123456";
    const newSecret = "sk-zyxwvutsrqponmlkjihgfedcba654321";

    try {
      await fs.writeFile(filePath, `export const token = "${oldSecret}";\n`, "utf8");
      const workspace = new Workspace({
        filesystem: new LocalFilesystem({ basePath }),
        tools: {
          hooks: bridge.hooks,
          [WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE]: { name: "editFile" },
        },
      });
      const tools = await createWorkspaceTools(workspace);
      const result = await tools.editFile.execute(
        { path: "secrets.ts", old_string: oldSecret, new_string: newSecret },
        { toolCallId: "call-secret-edit" },
      );
      const updateToolInvocation = jest.fn();

      await bridge.processToolResult({
        toolName: "editFile",
        toolCallId: "call-secret-edit",
        args: { path: "secrets.ts" },
        result,
        messageList: { updateToolInvocation },
        requestContext: requestContext("generation-secret-edit"),
      } as never);

      const [captured] = bridge.takeProcessedResults("generation-secret-edit", [
        "call-secret-edit",
      ]);
      expect(captured.result).toEqual(
        expect.objectContaining({
          oldContent: expect.stringContaining("[REDACTED:openai_key]"),
          newContent: expect.stringContaining("[REDACTED:openai_key]"),
          diff: expect.stringContaining("[REDACTED:openai_key]"),
        }),
      );
      expect(JSON.stringify(captured.result)).not.toContain(oldSecret);
      expect(JSON.stringify(captured.result)).not.toContain(newSecret);
      expect(JSON.stringify(updateToolInvocation.mock.calls)).not.toContain(oldSecret);
      expect(JSON.stringify(updateToolInvocation.mock.calls)).not.toContain(newSecret);
    } finally {
      await fs.rm(basePath, { recursive: true, force: true });
    }
  });

  it("clears only the current generation's captured results", async () => {
    const basePath = await fs.mkdtemp(path.join(os.tmpdir(), "iris-captured-bridge-"));
    const bridge = new CapturedWorkspaceMutationBridge(basePath, async () => null);
    const messageList = { updateToolInvocation: jest.fn() };

    try {
      await fs.writeFile(path.join(basePath, "first.ts"), "first = 1\n", "utf8");
      await fs.writeFile(path.join(basePath, "second.ts"), "second = 1\n", "utf8");
      const workspace = new Workspace({
        filesystem: new LocalFilesystem({ basePath }),
        tools: {
          hooks: bridge.hooks,
          [WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE]: { name: "editFile" },
        },
      });
      const tools = await createWorkspaceTools(workspace);
      const firstResult = await tools.editFile.execute(
        { path: "first.ts", old_string: "first = 1", new_string: "first = 2" },
        { toolCallId: "call-first" },
      );
      const secondResult = await tools.editFile.execute(
        { path: "second.ts", old_string: "second = 1", new_string: "second = 2" },
        { toolCallId: "call-second" },
      );

      await bridge.processToolResult({
        toolName: "editFile",
        toolCallId: "call-first",
        args: { path: "first.ts" },
        result: firstResult,
        messageList,
        requestContext: requestContext("generation-first"),
      } as never);
      await bridge.processToolResult({
        toolName: "editFile",
        toolCallId: "call-second",
        args: { path: "second.ts" },
        result: secondResult,
        messageList,
        requestContext: requestContext("generation-second"),
      } as never);

      bridge.clearProcessedResults("generation-first");

      expect(bridge.takeProcessedResults("generation-first", ["call-first"])).toEqual([]);
      expect(bridge.takeProcessedResults("generation-second", ["call-second"])).toEqual([
        {
          toolCallId: "call-second",
          result: expect.objectContaining({ success: true }),
        },
      ]);
    } finally {
      await fs.rm(basePath, { recursive: true, force: true });
    }
  });
});
