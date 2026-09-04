/**
 * Environment Snapshot Generator
 * Pre-gathers environment information at conversation start
 * Reduces exploratory turns and provides immediate context
 */

import fs from "fs/promises";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

type SnapshotPackageInfo = {
  name?: string;
  version?: string;
  description?: string;
  scripts: string[];
  dependencies: string[];
  devDependencies: string[];
};

type EnvironmentSnapshot = {
  cwd: string;
  fileTree: string;
  readme: string | null;
  packageInfo: SnapshotPackageInfo | null;
  git: {
    branch: string;
    status: string;
  };
  environment: {
    python: string;
    node: string;
    npm: string;
  };
  generatedAt: string;
};

type FileTreeOptions = {
  maxDepth?: number;
  currentDepth?: number;
  ignorePatterns?: string[];
};

/**
 * Read file if it exists, return null otherwise
 * @param {string} filePath - Path to file
 * @returns {Promise<string|null>} File content or null
 */
const readFileIfExists = async (filePath: string): Promise<string | null> => {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return content;
  } catch (error) {
    return null;
  }
};

/**
 * Generate file tree with depth limit
 * @param {string} dirPath - Directory path
 * @param {object} options - Options {maxDepth, currentDepth}
 * @returns {Promise<string>} File tree string
 */
const generateFileTree = async (
  dirPath: string,
  options: FileTreeOptions = {}
): Promise<string> => {
  const {
    maxDepth = 3,
    currentDepth = 0,
    ignorePatterns = ["node_modules", ".git", "dist", "build", "coverage"],
  } = options;

  if (currentDepth >= maxDepth) {
    return "";
  }

  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    let tree = "";

    for (const entry of entries) {
      // Skip ignored patterns
      if (ignorePatterns.includes(entry.name)) {
        continue;
      }

      const indent = "  ".repeat(currentDepth);
      const prefix = entry.isDirectory() ? "📁 " : "📄 ";
      tree += `${indent}${prefix}${entry.name}\n`;

      if (entry.isDirectory()) {
        const subPath = path.join(dirPath, entry.name);
        const subTree = await generateFileTree(subPath, {
          maxDepth,
          currentDepth: currentDepth + 1,
          ignorePatterns,
        });
        tree += subTree;
      }
    }

    return tree;
  } catch (error) {
    return "";
  }
};

/**
 * Run command safely, return output or empty string on error
 * @param {string} command - Command to run
 * @param {object} options - Exec options
 * @returns {Promise<string>} Command output
 */
const runCommandSafe = async (
  command: string,
  options: Parameters<typeof execAsync>[1] = {}
): Promise<string> => {
  try {
    const { stdout } = await execAsync(command, {
      timeout: 5000,
      maxBuffer: 1024 * 1024, // 1MB
      ...options,
    });
    return String(stdout).trim();
  } catch (error) {
    return "";
  }
};

/**
 * Generate comprehensive environment snapshot
 * @param {string} workspacePath - Workspace root path
 * @returns {Promise<object>} Environment snapshot data
 */
export const getEnvironmentSnapshot = async (
  workspacePath: string
): Promise<EnvironmentSnapshot> => {
  console.log("📸 Generating environment snapshot...");
  const startTime = Date.now();

  // Run operations in parallel where possible
  const [
    cwd,
    fileTree,
    readme,
    packageJson,
    gitBranch,
    gitStatus,
    pythonVersion,
    nodeVersion,
    npmVersion,
  ] = await Promise.all([
    // Current working directory
    Promise.resolve(workspacePath),

    // File tree (limited depth)
    generateFileTree(workspacePath, { maxDepth: 3 }),

    // README
    readFileIfExists(path.join(workspacePath, "README.md")),

    // package.json
    readFileIfExists(path.join(workspacePath, "package.json")),

    // Git info
    runCommandSafe("git branch --show-current", { cwd: workspacePath }),
    runCommandSafe("git status --short", { cwd: workspacePath }),

    // Environment versions
    runCommandSafe("python --version || python3 --version"),
    runCommandSafe("node --version"),
    runCommandSafe("npm --version"),
  ]);

  // Parse package.json if available
  let packageInfo: SnapshotPackageInfo | null = null;
  if (packageJson) {
    try {
      const pkg = JSON.parse(packageJson) as Record<string, unknown>;
      packageInfo = {
        name: typeof pkg.name === "string" ? pkg.name : undefined,
        version: typeof pkg.version === "string" ? pkg.version : undefined,
        description: typeof pkg.description === "string" ? pkg.description : undefined,
        scripts: Object.keys((pkg.scripts as Record<string, unknown> | undefined) || {}),
        dependencies: Object.keys((pkg.dependencies as Record<string, unknown> | undefined) || {}),
        devDependencies: Object.keys((pkg.devDependencies as Record<string, unknown> | undefined) || {}),
      };
    } catch (error) {
      packageInfo = null;
    }
  }

  const elapsed = Date.now() - startTime;
  console.log(`✅ Environment snapshot generated in ${elapsed}ms`);

  return {
    cwd,
    fileTree,
    readme: readme ? readme.substring(0, 2000) : null, // Limit README size
    packageInfo,
    git: {
      branch: gitBranch || "unknown",
      status: gitStatus || "",
    },
    environment: {
      python: pythonVersion || "not installed",
      node: nodeVersion || "not installed",
      npm: npmVersion || "not installed",
    },
    generatedAt: new Date().toISOString(),
  };
};

/**
 * Format snapshot as markdown for agent consumption
 * @param {object} snapshot - Environment snapshot from getEnvironmentSnapshot
 * @returns {string} Formatted markdown
 */
export const formatSnapshotAsMarkdown = (snapshot: EnvironmentSnapshot): string => {
  let markdown = `## Initial Environment State

Generated at: ${snapshot.generatedAt}

### Working Directory
\`\`\`
${snapshot.cwd}
\`\`\`

`;

  // File tree
  if (snapshot.fileTree) {
    markdown += `### File Structure (depth 3)
\`\`\`
${snapshot.fileTree}
\`\`\`

`;
  }

  // Package info
  if (snapshot.packageInfo) {
    markdown += `### Project: ${snapshot.packageInfo.name}
- **Version:** ${snapshot.packageInfo.version}
${
  snapshot.packageInfo.description
    ? `- **Description:** ${snapshot.packageInfo.description}`
    : ""
}

**Available Scripts:**
${snapshot.packageInfo.scripts.map((s) => `- \`npm run ${s}\``).join("\n")}

**Dependencies:** ${snapshot.packageInfo.dependencies.length} packages
**Dev Dependencies:** ${snapshot.packageInfo.devDependencies.length} packages

`;
  }

  // Git info
  if (snapshot.git.branch !== "unknown") {
    markdown += `### Git
- **Branch:** ${snapshot.git.branch}
${
  snapshot.git.status
    ? `- **Status:**\n\`\`\`\n${snapshot.git.status}\n\`\`\`\n`
    : ""
}
`;
  }

  // Environment
  markdown += `### Environment
- **Node:** ${snapshot.environment.node}
- **NPM:** ${snapshot.environment.npm}
- **Python:** ${snapshot.environment.python}

`;

  // README excerpt
  if (snapshot.readme) {
    markdown += `### README.md (excerpt)
\`\`\`
${snapshot.readme}
${snapshot.readme.length >= 2000 ? "\n... (truncated)" : ""}
\`\`\`

`;
  }

  return markdown;
};
