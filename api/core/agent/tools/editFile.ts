import fs from "fs/promises";
import path from "path";
import { z } from "zod";
import { generateDiff } from "../utils/diffUtils";

type EditFileParams = {
  filePath: string;
  oldContent?: string;
  newContent?: string;
  startLine?: number;
  endLine?: number;
  lineContent?: string;
  encoding?: BufferEncoding;
};

type EditFileSuccessResult = {
  success: true;
  filePath: string;
  fileExisted: true;
  size: number;
  modified: Date;
  linesAdded: number;
  linesRemoved: number;
  diff: string;
  oldContent: string;
  newContent: string;
};

type EditFileErrorResult = {
  success: false;
  error: string;
};

type EditFileResult = EditFileSuccessResult | EditFileErrorResult;

const countOccurrences = (source: string, token: string): number => {
  if (!token) return 0;
  let count = 0;
  let from = 0;
  while (true) {
    const index = source.indexOf(token, from);
    if (index === -1) return count;
    count += 1;
    from = index + token.length;
  }
};

/**
 * Tool for editing files by replacing content or specific lines
 * @param {Object} params - The parameters for editing a file
 * @param {string} params.filePath - The path to the file to edit
 * @param {string} [params.oldContent] - The old content to replace (must match exactly)
 * @param {string} [params.newContent] - The new content to replace with
 * @param {number} [params.startLine] - Starting line number to replace (1-indexed)
 * @param {number} [params.endLine] - Ending line number to replace (1-indexed)
 * @param {string} [params.lineContent] - New content for the line range
 * @param {string} [params.encoding='utf8'] - The encoding to use
 * @returns {Promise<Object>} Object containing success status and edit info or error
 */
export async function editFile({
  filePath,
  oldContent,
  newContent,
  startLine,
  endLine,
  lineContent,
  encoding = "utf8",
}: EditFileParams): Promise<EditFileResult> {
  try {
    // Validate input
    if (!filePath) {
      return {
        success: false,
        error: "File path is required",
      };
    }

    // Resolve to absolute path
    const absolutePath = path.resolve(filePath);

    // Check if file exists
    try {
      await fs.access(absolutePath, fs.constants.R_OK | fs.constants.W_OK);
    } catch (err) {
      return {
        success: false,
        error: `File not found or not writable: ${filePath}`,
      };
    }

    // Read current content
    const currentContent = await fs.readFile(absolutePath, encoding);

    let updatedContent: string;

    // Mode 1: Replace by content matching
    if (oldContent !== undefined && newContent !== undefined) {
      const matches = countOccurrences(currentContent, oldContent);
      if (matches === 0) {
        return {
          success: false,
          error: "Old content not found in file. Content must match exactly.",
        };
      }

      if (matches > 1) {
        return {
          success: false,
          error:
            "Old content appears multiple times. Provide a unique anchor (for example line-based edit with matching oldContent).",
        };
      }

      updatedContent = currentContent.replace(oldContent, newContent);
    }
    // Mode 2: Replace by line numbers
    else if (startLine !== undefined && lineContent !== undefined) {
      const lines = currentContent.split("\n");

      if (startLine < 1 || startLine > lines.length) {
        return {
          success: false,
          error: `Start line ${startLine} is out of range (file has ${lines.length} lines)`,
        };
      }

      const start = startLine - 1; // Convert to 0-indexed
      const end = endLine !== undefined ? endLine : startLine;

      if (end < startLine || end > lines.length) {
        return {
          success: false,
          error: `End line ${end} is invalid`,
        };
      }

      const selectedLines = lines.slice(startLine - 1, end);
      const selectedContent = selectedLines.join("\n");

      if (oldContent === undefined) {
        return {
          success: false,
          error:
            "Line-based edits require oldContent to match the current line range exactly.",
        };
      }

      if (selectedContent !== oldContent) {
        return {
          success: false,
          error:
            "Line range content does not match oldContent. Re-read the file and retry with current content.",
        };
      }

      // Replace the line range
      lines.splice(start, end - startLine + 1, lineContent);
      updatedContent = lines.join("\n");
    } else {
      return {
        success: false,
        error:
          "Must provide either (oldContent + newContent) or (startLine + lineContent)",
      };
    }

    // Write updated content
    await fs.writeFile(absolutePath, updatedContent, encoding);

    // Get file stats
    const stats = await fs.stat(absolutePath);

    // Generate diff for UI display (includes accurate line counts)
    const { diff, linesAdded, linesRemoved } = generateDiff(
      currentContent,
      updatedContent,
      absolutePath
    );

    return {
      success: true,
      filePath: absolutePath,
      fileExisted: true,
      size: stats.size,
      modified: stats.mtime,
      linesAdded,
      linesRemoved,
      diff,
      oldContent: currentContent,
      newContent: updatedContent,
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
export const editFileTool = {
  description:
    "Edit a file by replacing uniquely matched content or a line range anchored by exact oldContent",
  parameters: z.object({
    filePath: z.string().describe("The path to the file to edit"),
    oldContent: z
      .string()
      .optional()
      .describe(
        "The current file content to replace or the exact current content of the target line range",
      ),
    newContent: z
      .string()
      .optional()
      .describe("The new content to replace with"),
    startLine: z
      .number()
      .optional()
      .describe("Starting line number to replace (1-indexed)"),
    endLine: z
      .number()
      .optional()
      .describe("Ending line number to replace (1-indexed)"),
    lineContent: z
      .string()
      .optional()
      .describe(
        "New content for the line range (requires oldContent to match the current range)",
      ),
    encoding: z
      .enum(["utf8", "ascii", "base64", "binary", "hex"])
      .default("utf8")
      .describe("The encoding to use"),
  }),
  execute: editFile,
};

export default editFileTool;
