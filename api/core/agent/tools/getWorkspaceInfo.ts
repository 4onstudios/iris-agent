import fs from "fs/promises";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { z } from "zod";
import { countNodes, getMaxDepth, findAllNodes } from "./treeTraversal";

type WorkspaceInfoParams = {
  workspacePath?: string;
  includeTree?: boolean;
  maxDepth?: number;
};

type GitInfo = {
  isGitRepo: boolean;
  branch?: string;
  remote?: string;
  rootPath?: string;
  hasUncommittedChanges?: boolean;
  uncommittedFiles?: number;
};

type PackageInfo = {
  name?: string;
  version?: string;
  description?: string;
  dependencies: string[];
  devDependencies: string[];
  scripts: string[];
};

type TreeNode = {
  name: string;
  path: string;
  type: "directory" | "file";
  depth: number;
  children: TreeNode[];
};

type TreeStats = {
  totalNodes: number;
  totalFiles: number;
  totalDirectories: number;
  maxDepth: number;
};

type WorkspaceInfoResult =
  | {
      success: true;
      workspacePath: string;
      workspaceName: string;
      projectTypes: string[];
      fileCount: number;
      dirCount: number;
      git: GitInfo | null;
      package: PackageInfo | null;
      directoryTree: TreeNode | null;
      treeStats: TreeStats | null;
    }
  | {
      success: false;
      error: string;
    };

const execAsync = promisify(exec);

/**
 * Tool for getting workspace information
 * @param {Object} params - The parameters for getting workspace info
 * @param {string} [params.workspacePath] - The path to the workspace
 * @param {boolean} [params.includeTree] - Whether to include directory tree
 * @param {number} [params.maxDepth] - Maximum depth for directory tree
 * @returns {Promise<Object>} Object containing workspace information or error
 */
export async function getWorkspaceInfo({
  workspacePath = process.cwd(),
  includeTree = false,
  maxDepth = 3,
}: WorkspaceInfoParams): Promise<WorkspaceInfoResult> {
  try {
    const absolutePath = path.resolve(workspacePath);

    // Check if path exists
    try {
      await fs.access(absolutePath, fs.constants.R_OK);
    } catch (err) {
      return {
        success: false,
        error: `Workspace path not found or not readable: ${workspacePath}`,
      };
    }

    const stats = await fs.stat(absolutePath);
    if (!stats.isDirectory()) {
      return {
        success: false,
        error: "Workspace path is not a directory",
      };
    }

    // Get workspace name
    const workspaceName = path.basename(absolutePath);

    // Try to get git information
    let gitInfo: GitInfo | null = null;
    try {
      const { stdout: branch } = await execAsync(
        "git rev-parse --abbrev-ref HEAD",
        { cwd: absolutePath },
      );
      const { stdout: remote } = await execAsync(
        "git config --get remote.origin.url",
        { cwd: absolutePath },
      );
      const { stdout: rootPath } = await execAsync(
        "git rev-parse --show-toplevel",
        { cwd: absolutePath },
      );

      gitInfo = {
        isGitRepo: true,
        branch: branch.trim(),
        remote: remote.trim(),
        rootPath: rootPath.trim(),
      };

      // Check for uncommitted changes
      const { stdout: status } = await execAsync("git status --porcelain", {
        cwd: absolutePath,
      });
      gitInfo.hasUncommittedChanges = status.trim().length > 0;
      gitInfo.uncommittedFiles = status
        .trim()
        .split("\n")
        .filter(Boolean).length;
    } catch (err) {
      gitInfo = { isGitRepo: false };
    }

    // Try to detect project type by looking for common files
    const projectTypes = [];
    const commonFiles = [
      { file: "package.json", type: "Node.js/JavaScript" },
      { file: "requirements.txt", type: "Python" },
      { file: "Pipfile", type: "Python (Pipenv)" },
      { file: "pyproject.toml", type: "Python (Poetry)" },
      { file: "Cargo.toml", type: "Rust" },
      { file: "go.mod", type: "Go" },
      { file: "pom.xml", type: "Java (Maven)" },
      { file: "build.gradle", type: "Java (Gradle)" },
      { file: "Gemfile", type: "Ruby" },
      { file: "composer.json", type: "PHP" },
      { file: ".csproj", type: ".NET" },
    ];

    for (const { file, type } of commonFiles) {
      try {
        if (file.startsWith(".")) {
          // Special handling for extension-based files
          const files = await fs.readdir(absolutePath);
          if (files.some((f) => f.endsWith(file))) {
            projectTypes.push(type);
          }
        } else {
          await fs.access(path.join(absolutePath, file), fs.constants.F_OK);
          projectTypes.push(type);
        }
      } catch (err) {
        // File doesn't exist, skip
      }
    }

    // Try to read package.json if it exists
    let packageInfo: PackageInfo | null = null;
    try {
      const packageJsonPath = path.join(absolutePath, "package.json");
      const packageJsonContent = await fs.readFile(packageJsonPath, "utf8");
      const packageJson = JSON.parse(packageJsonContent) as Record<string, unknown>;
      packageInfo = {
        name: typeof packageJson.name === "string" ? packageJson.name : undefined,
        version: typeof packageJson.version === "string" ? packageJson.version : undefined,
        description:
          typeof packageJson.description === "string"
            ? packageJson.description
            : undefined,
        dependencies: Object.keys(
          (packageJson.dependencies as Record<string, unknown> | undefined) || {}
        ),
        devDependencies: Object.keys(
          (packageJson.devDependencies as Record<string, unknown> | undefined) || {}
        ),
        scripts: Object.keys(
          (packageJson.scripts as Record<string, unknown> | undefined) || {}
        ),
      };
    } catch (err) {
      // package.json doesn't exist or is invalid
    }

    // Count files and directories
    let fileCount = 0;
    let dirCount = 0;
    try {
      const entries = await fs.readdir(absolutePath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        if (entry.isDirectory()) dirCount++;
        else fileCount++;
      }
    } catch (err) {
      // Unable to count
    }

    // Optionally build directory tree structure
    let directoryTree: TreeNode | null = null;
    let treeStats: TreeStats | null = null;
    if (includeTree) {
      try {
        directoryTree = await buildDirectoryTree(absolutePath, maxDepth);

        // Calculate tree statistics using efficient traversal utilities
        if (directoryTree) {
          const allFiles = findAllNodes(
            directoryTree,
            (node) => node.type === "file",
          );
          const allDirs = findAllNodes(
            directoryTree,
            (node) => node.type === "directory",
          );

          treeStats = {
            totalNodes: countNodes(directoryTree),
            totalFiles: allFiles.length,
            totalDirectories: allDirs.length,
            maxDepth: getMaxDepth(directoryTree),
          };
        }
      } catch (err) {
        console.error("Failed to build directory tree:", err);
      }
    }

    return {
      success: true,
      workspacePath: absolutePath,
      workspaceName,
      projectTypes,
      fileCount,
      dirCount,
      git: gitInfo,
      package: packageInfo,
      directoryTree,
      treeStats,
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
 * Build a directory tree structure using BFS (Breadth-First Search)
 * More efficient than recursive DFS, prevents stack overflow on deep trees
 */
async function buildDirectoryTree(
  dirPath: string,
  maxDepth = 3
): Promise<TreeNode> {
  const ignorePatterns = [
    "node_modules",
    ".git",
    "dist",
    "build",
    ".next",
    "target",
    "coverage",
    ".cache",
    ".vscode",
    ".idea",
  ];

  // Root node
  const root: TreeNode = {
    name: path.basename(dirPath),
    path: dirPath,
    type: "directory",
    children: [],
    depth: 0,
  };

  // Queue for BFS traversal: [node, parentNode]
  const queue: Array<[string, TreeNode, number]> = [[dirPath, root, 0]];

  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) {
      continue;
    }

    const [currentPath, parentNode, currentDepth] = next;

    // Stop if max depth reached
    if (currentDepth >= maxDepth) continue;

    try {
      const entries = await fs.readdir(currentPath, { withFileTypes: true });

      // Sort entries: directories first, then files alphabetically
      const sortedEntries = entries.sort((a, b) => {
        if (a.isDirectory() === b.isDirectory()) {
          return a.name.localeCompare(b.name);
        }
        return a.isDirectory() ? -1 : 1;
      });

      for (const entry of sortedEntries) {
        // Skip hidden files and ignored patterns
        if (entry.name.startsWith(".") || ignorePatterns.includes(entry.name)) {
          continue;
        }

        const children = parentNode.children ?? (parentNode.children = []);

        const childPath = path.join(currentPath, entry.name);

        if (entry.isDirectory()) {
          const dirNode: TreeNode = {
            name: entry.name,
            path: childPath,
            type: "directory",
            children: [],
            depth: currentDepth + 1,
          };
          children.push(dirNode);

          // Add to queue for further exploration
          queue.push([childPath, dirNode, currentDepth + 1]);
        } else {
          // Add file node
          children.push({
            name: entry.name,
            path: childPath,
            type: "file",
            depth: currentDepth + 1,
            children: [],
          });
        }
      }
    } catch (err) {
      const error = err as Error;
      // Skip directories we can't read (permissions, etc.)
      console.error(
        `Cannot read directory ${currentPath}:`,
        error.message || String(err) || "Unknown error",
      );
    }
  }

  return root;
}

/**
 * Tool metadata for agent system
 */
export const getWorkspaceInfoTool = {
  description:
    "Get information about the current workspace including git status, project type, and structure. IMPORTANT: Leave workspacePath empty to use the current workspace - do NOT pass project names like 'my-project'. Can optionally include the full directory tree to understand the folder structure.",
  parameters: z.object({
    workspacePath: z
      .string()
      .optional()
      .describe(
        "Leave empty to use current workspace. Only provide an absolute path if you need a different workspace.",
      ),
    includeTree: z
      .boolean()
      .default(false)
      .describe(
        "Whether to include the full directory tree structure (useful for understanding folder organization)",
      ),
    maxDepth: z
      .number()
      .default(3)
      .describe(
        "Maximum depth for directory tree (only used if includeTree is true)",
      ),
  }),
  execute: getWorkspaceInfo,
};

export default getWorkspaceInfoTool;
