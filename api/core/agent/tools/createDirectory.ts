import fs from "fs/promises";
import path from "path";
import { z } from "zod";

type CreateDirectoryParams = {
  dirPath: string;
  recursive?: boolean;
};

type CreateDirectorySuccessResult = {
  success: true;
  dirPath: string;
  created?: Date;
  alreadyExists: boolean;
  message: string;
};

type CreateDirectoryErrorResult = {
  success: false;
  error: string;
};

type CreateDirectoryResult =
  | CreateDirectorySuccessResult
  | CreateDirectoryErrorResult;

/**
 * Tool for creating directories
 * @param {Object} params - The parameters for creating a directory
 * @param {string} params.dirPath - The path to the directory to create
 * @param {boolean} [params.recursive=true] - Whether to create parent directories
 * @returns {Promise<Object>} Object containing success status and directory info or error
 */
export async function createDirectory({
  dirPath,
  recursive = true,
}: CreateDirectoryParams): Promise<CreateDirectoryResult> {
  try {
    // Validate input
    if (!dirPath) {
      return {
        success: false,
        error: "Directory path is required",
      };
    }

    // Resolve to absolute path
    const absolutePath = path.resolve(dirPath);

    // Check if directory already exists
    try {
      const stats = await fs.stat(absolutePath);
      if (stats.isDirectory()) {
        return {
          success: true,
          dirPath: absolutePath,
          alreadyExists: true,
          message: "Directory already exists",
        };
      } else {
        return {
          success: false,
          error: "Path exists but is not a directory",
        };
      }
    } catch (err) {
      // Directory doesn't exist, continue with creation
    }

    // Create the directory
    await fs.mkdir(absolutePath, { recursive });

    // Get directory stats
    const stats = await fs.stat(absolutePath);

    return {
      success: true,
      dirPath: absolutePath,
      created: stats.birthtime,
      alreadyExists: false,
      message: "Directory created successfully",
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
export const createDirectoryTool = {
  description: "Create a new directory, optionally creating parent directories",
  parameters: z.object({
    dirPath: z.string().describe("The path to the directory to create"),
    recursive: z
      .boolean()
      .default(true)
      .describe("Whether to create parent directories if they don't exist"),
  }),
  execute: createDirectory,
};

export default createDirectoryTool;
