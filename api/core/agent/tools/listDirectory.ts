import fs from "fs/promises";
import path from "path";
import { z } from "zod";

type ListDirectoryParams = {
  dirPath: string;
  recursive?: boolean;
  includeHidden?: boolean;
  maxDepth?: number;
};

type DirectoryItem = {
  name: string;
  path: string;
  relativePath: string;
  type: "directory" | "file";
  size: number;
  modified: Date;
  created: Date;
  depth: number;
};

type ListDirectorySuccessResult = {
  success: true;
  dirPath: string;
  totalItems: number;
  fileCount: number;
  directoryCount: number;
  contents: DirectoryItem[];
  files: DirectoryItem[];
  directories: DirectoryItem[];
};

type ListDirectoryErrorResult = {
  success: false;
  error: string;
};

type ListDirectoryResult = ListDirectorySuccessResult | ListDirectoryErrorResult;

/**
 * Tool for listing directory contents
 * @param {Object} params - The parameters for listing a directory
 * @param {string} params.dirPath - The path to the directory to list
 * @param {boolean} [params.recursive=false] - Whether to list recursively
 * @param {boolean} [params.includeHidden=false] - Whether to include hidden files
 * @param {number} [params.maxDepth=3] - Maximum depth for recursive listing
 * @returns {Promise<Object>} Object containing success status and directory contents or error
 */
export async function listDirectory({
  dirPath,
  recursive = false,
  includeHidden = false,
  maxDepth = 3,
}: ListDirectoryParams): Promise<ListDirectoryResult> {
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

    // Check if directory exists
    try {
      await fs.access(absolutePath, fs.constants.R_OK);
    } catch (err) {
      return {
        success: false,
        error: `Directory not found or not readable: ${dirPath}`,
      };
    }

    // Check if it's a directory
    const stats = await fs.stat(absolutePath);
    if (!stats.isDirectory()) {
      return {
        success: false,
        error: `Path is not a directory: ${dirPath}`,
      };
    }

    // List directory contents using BFS for better performance
    const listDir = async (): Promise<DirectoryItem[]> => {
      if (!recursive) {
        // Non-recursive: simple single-level listing
        const entries = await fs.readdir(absolutePath, { withFileTypes: true });
        const items: DirectoryItem[] = [];

        for (const entry of entries) {
          if (!includeHidden && entry.name.startsWith(".")) {
            continue;
          }

          const fullPath = path.join(absolutePath, entry.name);
          const relativePath = path.relative(absolutePath, fullPath);
          const itemStats = await fs.stat(fullPath);

          items.push({
            name: entry.name,
            path: fullPath,
            relativePath,
            type: entry.isDirectory() ? "directory" : "file",
            size: itemStats.size,
            modified: itemStats.mtime,
            created: itemStats.birthtime,
            depth: 0,
          });
        }

        return items;
      }

      // Recursive: use BFS with queue (more efficient than DFS recursion)
      const items: DirectoryItem[] = [];
      const queue: Array<[string, number]> = [[absolutePath, 0]]; // [path, depth]

      while (queue.length > 0) {
        const next = queue.shift();
        if (!next) {
          continue;
        }

        const [currentPath, currentDepth] = next;

        // Stop if max depth reached
        if (currentDepth > maxDepth) continue;

        try {
          const entries = await fs.readdir(currentPath, {
            withFileTypes: true,
          });

          for (const entry of entries) {
            if (!includeHidden && entry.name.startsWith(".")) {
              continue;
            }

            const fullPath = path.join(currentPath, entry.name);
            const relativePath = path.relative(absolutePath, fullPath);
            const itemStats = await fs.stat(fullPath);

            const item: DirectoryItem = {
              name: entry.name,
              path: fullPath,
              relativePath,
              type: entry.isDirectory() ? "directory" : "file",
              size: itemStats.size,
              modified: itemStats.mtime,
              created: itemStats.birthtime,
              depth: currentDepth,
            };

            items.push(item);

            // Add subdirectories to queue for exploration
            if (entry.isDirectory()) {
              queue.push([fullPath, currentDepth + 1]);
            }
          }
        } catch (err) {
          const error = err as Error;
          // Skip directories we can't read
          console.error(
            `Cannot read directory ${currentPath}:`,
            error.message || String(err) || "Unknown error",
          );
        }
      }

      return items;
    };

    const contents = await listDir();

    // Separate files and directories
    const files = contents.filter((item) => item.type === "file");
    const directories = contents.filter((item) => item.type === "directory");

    return {
      success: true,
      dirPath: absolutePath,
      totalItems: contents.length,
      fileCount: files.length,
      directoryCount: directories.length,
      contents,
      files,
      directories,
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
export const listDirectoryTool = {
  description: "List the contents of a directory, optionally recursively",
  parameters: z.object({
    dirPath: z.string().describe("The path to the directory to list"),
    recursive: z
      .boolean()
      .default(false)
      .describe("Whether to list recursively"),
    includeHidden: z
      .boolean()
      .default(false)
      .describe("Whether to include hidden files (starting with .)"),
    maxDepth: z
      .number()
      .default(3)
      .describe("Maximum depth for recursive listing"),
  }),
  execute: listDirectory,
};

export default listDirectoryTool;
