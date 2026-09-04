import fs from "fs/promises";
import path from "path";
import { z } from "zod";

type RenameFileParams = {
  oldPath: string;
  newPath: string;
  overwrite?: boolean;
};

type RenameFileSuccessResult = {
  success: true;
  oldPath: string;
  newPath: string;
  size: number;
  isMove: boolean;
  message: string;
};

type RenameFileErrorResult = {
  success: false;
  error: string;
};

type RenameFileResult = RenameFileSuccessResult | RenameFileErrorResult;

/**
 * Tool for renaming or moving files
 * @param {Object} params - The parameters for renaming a file
 * @param {string} params.oldPath - The current path of the file
 * @param {string} params.newPath - The new path for the file
 * @param {boolean} [params.overwrite=false] - Whether to overwrite if destination exists
 * @returns {Promise<Object>} Object containing success status and rename info or error
 */
export async function renameFile({
  oldPath,
  newPath,
  overwrite = false,
}: RenameFileParams): Promise<RenameFileResult> {
  try {
    // Validate input
    if (!oldPath || !newPath) {
      return {
        success: false,
        error: "Both oldPath and newPath are required",
      };
    }

    // Resolve to absolute paths
    const absoluteOldPath = path.resolve(oldPath);
    const absoluteNewPath = path.resolve(newPath);

    // Check if source file exists
    try {
      await fs.access(absoluteOldPath, fs.constants.F_OK);
    } catch (err) {
      return {
        success: false,
        error: `Source file not found: ${oldPath}`,
      };
    }

    // Check if destination exists
    try {
      await fs.access(absoluteNewPath, fs.constants.F_OK);
      if (!overwrite) {
        return {
          success: false,
          error: `Destination already exists: ${newPath}. Set overwrite=true to replace.`,
        };
      }
    } catch (err) {
      // Destination doesn't exist, which is fine
    }

    // Create destination directory if it doesn't exist
    const destDir = path.dirname(absoluteNewPath);
    await fs.mkdir(destDir, { recursive: true });

    // Get file stats before moving
    const stats = await fs.stat(absoluteOldPath);

    // Rename/move the file
    await fs.rename(absoluteOldPath, absoluteNewPath);

    return {
      success: true,
      oldPath: absoluteOldPath,
      newPath: absoluteNewPath,
      size: stats.size,
      isMove: path.dirname(absoluteOldPath) !== path.dirname(absoluteNewPath),
      message: "File renamed/moved successfully",
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
export const renameFileTool = {
  description: "Rename or move a file to a new location",
  parameters: z.object({
    oldPath: z.string().describe("The current path of the file"),
    newPath: z.string().describe("The new path for the file"),
    overwrite: z
      .boolean()
      .default(false)
      .describe("Whether to overwrite if destination exists"),
  }),
  execute: renameFile,
};

export default renameFileTool;
