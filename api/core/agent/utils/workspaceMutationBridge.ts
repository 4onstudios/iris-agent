import fs from "fs/promises";
import path from "path";
import type { Processor } from "@mastra/core/processors";
import {
  WORKSPACE_TOOLS,
  type WorkspaceToolHooks,
  type WorkspaceToolName,
} from "@mastra/core/workspace";
import { generateDiff } from "./diffUtils";

type ValidationResult = Record<string, unknown> | null;

type MutationSnapshot = {
  path: string;
  fileExisted: boolean;
  oldContent?: string;
  newContent?: string;
  validation?: ValidationResult;
};

const MUTATION_TOOLS = new Set<WorkspaceToolName>([
  WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.DELETE,
  WORKSPACE_TOOLS.FILESYSTEM.MKDIR,
]);

const VALIDATED_TOOLS = new Set<WorkspaceToolName>([
  WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE,
]);

const getToolCallId = (context: unknown): string | undefined => {
  if (!context || typeof context !== "object") return undefined;
  const value = (context as { toolCallId?: unknown }).toolCallId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

const getInputPath = (input: unknown): string | undefined => {
  if (!input || typeof input !== "object") return undefined;
  const value = (input as { path?: unknown }).path;
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

const isFailedOutput = (output: unknown): boolean => {
  if (typeof output === "string") {
    return /^(error:|cannot edit|could not find|found \d+ occurrences)/i.test(
      output.trim(),
    );
  }
  if (!output || typeof output !== "object") return false;

  const structured = output as {
    success?: unknown;
    error?: unknown;
    value?: unknown;
  };
  return (
    structured.success === false ||
    typeof structured.error === "string" ||
    ("value" in structured && isFailedOutput(structured.value))
  );
};

const getOutputText = (output: unknown): string => {
  if (typeof output === "string") return output;
  if (output && typeof output === "object") {
    const structured = output as { error?: unknown; value?: unknown };
    if (typeof structured.error === "string") return structured.error;
    if ("value" in structured && isFailedOutput(structured.value)) {
      return getOutputText(structured.value);
    }
    try {
      return JSON.stringify(output);
    } catch {
      return String(output);
    }
  }
  return String(output ?? "");
};

const readTextIfPresent = async (
  absolutePath: string,
): Promise<{ exists: boolean; content?: string }> => {
  try {
    return { exists: true, content: await fs.readFile(absolutePath, "utf8") };
  } catch {
    return { exists: false };
  }
};

export class WorkspaceMutationBridge implements Processor {
  readonly id = "workspace-mutation-bridge";
  private readonly snapshots = new Map<string, MutationSnapshot>();

  constructor(
    private readonly basePath: string,
    private readonly validate: () => Promise<ValidationResult>,
  ) {}

  readonly hooks: WorkspaceToolHooks = {
    beforeToolCall: async ({ workspaceToolName, input, context }) => {
      if (!MUTATION_TOOLS.has(workspaceToolName)) return;
      const toolCallId = getToolCallId(context);
      const inputPath = getInputPath(input);
      if (!toolCallId || !inputPath) return;

      const absolutePath = path.resolve(this.basePath, inputPath);
      const relativePath = path.relative(this.basePath, absolutePath);
      if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) return;

      const before = await readTextIfPresent(absolutePath);
      this.snapshots.set(toolCallId, {
        path: absolutePath,
        fileExisted: before.exists,
        oldContent:
          before.content ??
          (workspaceToolName === WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE ? "" : undefined),
      });
    },
    afterToolCall: async ({ workspaceToolName, context, output, error }) => {
      if (!MUTATION_TOOLS.has(workspaceToolName)) return;
      const toolCallId = getToolCallId(context);
      if (!toolCallId) return;
      const snapshot = this.snapshots.get(toolCallId);
      if (!snapshot || error || isFailedOutput(output)) return;

      const after = await readTextIfPresent(snapshot.path);
      snapshot.newContent = after.content;
      if (VALIDATED_TOOLS.has(workspaceToolName)) {
        snapshot.validation = await this.validate();
      }
    },
  };

  async processToolResult({
    toolName,
    toolCallId,
    args,
    result,
    messageList,
  }: Parameters<NonNullable<Processor["processToolResult"]>>[0]) {
    const snapshot = this.snapshots.get(toolCallId);
    if (!snapshot) return messageList;
    this.snapshots.delete(toolCallId);

    const output = getOutputText(result);
    const failed = isFailedOutput(result);
    const normalizedResult: Record<string, unknown> = {
      success: !failed,
      output,
      filePath: snapshot.path,
      fileExisted: snapshot.fileExisted,
    };

    if (!failed && snapshot.oldContent !== undefined && snapshot.newContent !== undefined) {
      const { diff, linesAdded, linesRemoved } = generateDiff(
        snapshot.oldContent,
        snapshot.newContent,
        snapshot.path,
      );
      Object.assign(normalizedResult, {
        oldContent: snapshot.oldContent,
        newContent: snapshot.newContent,
        diff,
        linesAdded,
        linesRemoved,
      });
    }
    if (snapshot.validation) normalizedResult.validation = snapshot.validation;
    if (failed) normalizedResult.error = output;

    messageList.updateToolInvocation({
      type: "tool-invocation",
      toolInvocation: {
        state: "result",
        toolCallId,
        toolName,
        args,
        result: normalizedResult,
      },
    });
    return messageList;
  }
}