import fs from "fs/promises";
import path from "path";
import { z } from "zod";

type DeleteFileParams = {
  filePath: string;
};

type DeleteFileSuccessResult = {
  success: true;
  filePath: string;
  deletedSize: number;
  message: string;
};

type DeleteFileErrorResult = {
  success: false;
  error: string;
};

type DeleteFileResult = DeleteFileSuccessResult | DeleteFileErrorResult;

/**
 * Tool for deleting files
 * @param {Object} params - The parameters for deleting a file
 * @param {string} params.filePath - The path to the file to delete
 * @returns {Promise<Object>} Object containing success status and deletion info or error
 */
export async function deleteFile({
  filePath,
}: DeleteFileParams): Promise<DeleteFileResult> {
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
      await fs.access(absolutePath, fs.constants.F_OK);
    } catch (err) {
      return {
        success: false,
        error: `File not found: ${filePath}`,
      };
    }

    // Get file stats before deletion
    const stats = await fs.stat(absolutePath);

    if (!stats.isFile()) {
      return {
        success: false,
        error: `Path is not a file: ${filePath}`,
      };
    }

    // Delete the file
    await fs.unlink(absolutePath);

    return {
      success: true,
      filePath: absolutePath,
      deletedSize: stats.size,
      message: "File deleted successfully",
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
export const deleteFileTool = {
  description: "Delete a file from the file system",
  parameters: z.object({
    filePath: z.string().describe("The path to the file to delete"),
  }),
  execute: deleteFile,
};

export default deleteFileTool;
