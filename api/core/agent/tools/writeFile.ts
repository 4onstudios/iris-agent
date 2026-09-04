import fs from "fs/promises";
import path from "path";
import { z } from "zod";
import { generateDiff } from "../utils/diffUtils";

type WriteFileParams = {
  filePath: string;
  content: string;
  encoding?: BufferEncoding;
  createDirectories?: boolean;
};

type WriteFileSuccessResult = {
  success: true;
  filePath: string;
  fileExisted: boolean;
  size: number;
  created: Date;
  modified: Date;
  linesAdded: number;
  linesRemoved: number;
  diff: string;
  oldContent: string;
  newContent: string;
};

type WriteFileErrorResult = {
  success: false;
  error: string;
};

type WriteFileResult = WriteFileSuccessResult | WriteFileErrorResult;

/**
 * Tool for writing content to files
 * @param {Object} params - The parameters for writing a file
 * @param {string} params.filePath - The path to the file to write
 * @param {string} params.content - The content to write to the file
 * @param {string} [params.encoding='utf8'] - The encoding to use when writing the file
 * @param {boolean} [params.createDirectories=true] - Whether to create parent directories if they don't exist
 * @returns {Promise<Object>} Object containing success status and file info or error
 */
export async function writeFile({
  filePath,
  content,
  encoding = "utf8",
  createDirectories = true,
}: WriteFileParams): Promise<WriteFileResult> {
  try {
    // Validate input
    if (!filePath) {
      return {
        success: false,
        error: "File path is required",
      };
    }

    if (content === undefined || content === null) {
      return {
        success: false,
        error: "Content is required",
      };
    }

    // Resolve to absolute path
    const absolutePath = path.resolve(filePath);

    // Track whether the file existed before this write so undo can decide
    // between restoring content vs deleting a newly created file.
    let fileExisted = false;

    // Try to read existing content for diff (may not exist for new files)
    let oldContent = "";
    try {
      fileExisted = true;
      oldContent = await fs.readFile(absolutePath, encoding);
    } catch {
      // File doesn't exist yet - that's fine
    }

    // Create parent directories if needed
    if (createDirectories) {
      const dir = path.dirname(absolutePath);
      await fs.mkdir(dir, { recursive: true });
    }

    // Write file content
    await fs.writeFile(absolutePath, content, encoding);

    // Get file stats
    const stats = await fs.stat(absolutePath);

    // Generate diff for UI display (includes accurate line counts)
    const { diff, linesAdded, linesRemoved } = generateDiff(
      oldContent,
      content,
      absolutePath
    );

    return {
      success: true,
      filePath: absolutePath,
      fileExisted,
      size: stats.size,
      created: stats.birthtime,
      modified: stats.mtime,
      linesAdded,
      linesRemoved,
      diff,
      oldContent,
      newContent: content,
    };
  } catch (error) {
    const err = error as Error;
    return {
      success: false,
      error: err.message,
    };
  }
}

/**
 * Tool metadata for agent system
 */
export const writeFileTool = {
  description: "Write content to a file, creating it if it doesn't exist",
  parameters: z.object({
    filePath: z
      .string()
      .describe("The path to the file to write (can be relative or absolute)"),
    content: z.string().describe("The content to write to the file"),
    encoding: z
      .enum(["utf8", "ascii", "base64", "binary", "hex"])
      .default("utf8")
      .describe("The encoding to use when writing the file"),
    createDirectories: z
      .boolean()
      .default(true)
      .describe("Whether to create parent directories if they don't exist"),
  }),
  execute: writeFile,
};

export default writeFileTool;
