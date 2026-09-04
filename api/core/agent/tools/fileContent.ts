import fs from "fs/promises";
import path from "path";
import { z } from "zod";
import { getWorkspaceTree } from "../../library/workspaceIdentity";

type FindFileContentParams = {
  rootFolder: string;
  fileName: string;
  concurrency?: number;
  isWebMode?: boolean;
};

type FileContentSuccessResult = {
  found: true;
  path: string;
  content: string | null;
  error?: string;
};

type FileContentErrorResult = {
  found: false;
  error: string;
};

type FileContentResult = FileContentSuccessResult | FileContentErrorResult;

type WorkspaceStructureNode = {
  name: string;
  path?: string;
  type: "folder" | "file";
  children?: WorkspaceStructureNode[];
};

type StructureSearchResult =
  | {
      found: true;
      path: string;
      node: WorkspaceStructureNode;
    }
  | {
      found: false;
    };

async function getFileHandleFromPath(
  rootHandle: FileSystemDirectoryHandle,
  filePath: string,
): Promise<FileSystemFileHandle> {
  const parts = filePath.split("/").filter(Boolean);
  let currentHandle = rootHandle;

  for (let i = 0; i < parts.length - 1; i++) {
    currentHandle = await currentHandle.getDirectoryHandle(parts[i]);
  }

  return currentHandle.getFileHandle(parts[parts.length - 1]);
}

function searchInStructure(
  node: WorkspaceStructureNode,
  fileName: string,
  currentPath = "",
): StructureSearchResult {
  const nodePath = currentPath ? `${currentPath}/${node.name}` : node.name;

  if (node.type === "file" && node.name === fileName) {
    return {
      found: true,
      path: node.path || nodePath,
      node,
    };
  }

  if (node.type === "folder" && node.children) {
    for (const child of node.children) {
      const result = searchInStructure(child, fileName, nodePath);
      if (result.found) {
        return result;
      }
    }
  }

  return { found: false };
}

/**
 * Tool for finding and reading file content by searching through directory tree
 * Supports both filesystem (Node.js) and web-based File System Access API
 *
 * @param {Object} params - The parameters for finding file content
 * @param {string} params.rootFolder - Root directory to start searching from
 * @param {string} params.fileName - Exact file name to search for (including extension)
 * @param {number} [params.concurrency=32] - Maximum number of parallel filesystem operations
 * @param {boolean} [params.isWebMode=false] - Whether running in web mode (uses File System Access API)
 * @returns {Promise<Object>} Object containing found status, file path, and content or error
 */
export async function findFileContent({
  rootFolder,
  fileName,
  concurrency = 32,
  isWebMode = false,
}: FindFileContentParams): Promise<FileContentResult> {
  try {
    // Web mode: Use File System Access API via window.directoryHandle
    if (isWebMode) {
      console.log(
        "🌐 Web mode: searching for",
        fileName,
        "in workspace structure"
      );

      // Check if we have access to the workspace structure
      const workspaceStructure =
        typeof window === "undefined"
          ? undefined
          : (getWorkspaceTree() as WorkspaceStructureNode | null) || undefined;

      if (!workspaceStructure) {
        return {
          found: false,
          error:
            "No workspace structure available in web mode. Please open a folder first.",
        };
      }

      const searchResult = searchInStructure(workspaceStructure, fileName);

      if (!searchResult.found) {
        return {
          found: false,
          error: `File not found: ${fileName}`,
        };
      }

      // Now read the file content using File System Access API
      const directoryHandle = (window as any).directoryHandle;
      if (!directoryHandle) {
        return {
          found: true,
          path: searchResult.path,
          content: null,
          error:
            "File found but no directory handle available to read content. File must be opened in the editor first.",
        };
      }

      try {
        const fileHandle = await getFileHandleFromPath(
          directoryHandle,
          searchResult.path,
        );

        // Request permission if needed
        const permission = await (fileHandle as any).queryPermission({ mode: "read" });
        if (permission !== "granted") {
          const newPermission = await (fileHandle as any).requestPermission({
            mode: "read",
          });
          if (newPermission !== "granted") {
            return {
              found: true,
              path: searchResult.path,
              content: null,
              error: "Permission denied to read file",
            };
          }
        }

        // Read the file
        const fileData = await fileHandle.getFile();
        const content = await fileData.text();

        return {
          found: true,
          path: searchResult.path,
          content,
        };
      } catch (err) {
        const error = err as Error;
        return {
          found: true,
          path: searchResult.path,
          content: null,
          error: `Error reading file: ${error.message}`,
        };
      }
    }

    // Node.js filesystem mode (default)
    const maxConcurrency = Math.max(1, Math.min(concurrency, 128));

    // Validate root folder
    try {
      const stat = await fs.stat(rootFolder);
      if (!stat.isDirectory()) {
        return {
          found: false,
          error: `rootFolder is not a directory: ${rootFolder}`,
        };
      }
    } catch (err) {
      void err;
      return {
        found: false,
        error: `rootFolder does not exist or is not accessible: ${rootFolder}`,
      };
    }

    const queue = [rootFolder];
    let found = false;
    let foundPath = "";
    let content = "";

    const workers = Array.from({ length: maxConcurrency }, async () => {
      while (!found) {
        const dir = queue.shift();
        if (!dir) {
          // Nothing left for this worker
          break;
        }

        let entries;
        try {
          entries = await fs.readdir(dir);
        } catch (err) {
          void err;
          // unreadable dir; skip
          continue;
        }

        for (const entry of entries) {
          if (found) break;

          const fullPath = path.join(dir, entry);

          let stat;
          try {
            stat = await fs.stat(fullPath);
          } catch (err) {
            void err;
            // cannot stat; skip
            continue;
          }

          if (stat.isFile() && entry === fileName) {
            try {
              content = await fs.readFile(fullPath, "utf8");
              foundPath = fullPath;
              found = true;
              break;
            } catch (err) {
              void err;
              // can't read; keep searching
              continue;
            }
          }

          if (stat.isDirectory()) {
            queue.push(fullPath);
          }
        }
      }
    });

    await Promise.all(workers);

    if (!found) {
      return {
        found: false,
        error: `File not found: ${fileName}`,
      };
    }

    return {
      found: true,
      path: foundPath,
      content,
    };
  } catch (error) {
    const err = error as Error;
    return {
      found: false,
      error: err.message,
    };
  }
}

/**
 * Tool metadata for agent system
 */
export const findFileContentTool = {
  description:
    "Traverse a folder tree starting at rootFolder and return the content of the first file whose name matches fileName. Supports both Node.js filesystem and web-based File System Access API. Useful for finding configuration files, specific source files, or any file by exact name across a directory structure.",
  parameters: z.object({
    rootFolder: z.string().describe("Root directory to start searching from"),
    fileName: z
      .string()
      .describe("Exact file name to search for (including extension)"),
    concurrency: z
      .number()
      .int()
      .positive()
      .max(128)
      .default(32)
      .describe(
        "Maximum number of parallel filesystem operations (default: 32, max: 128). Only used in Node.js mode."
      ),
    isWebMode: z
      .boolean()
      .default(false)
      .describe(
        "Whether running in web mode (uses File System Access API via the active workspace tree)"
      ),
  }),
  execute: findFileContent,
};

export default findFileContentTool;
