import fs from "fs/promises";
import path from "path";
import { glob } from "glob";
import { execFile } from "child_process";
import { promisify } from "util";
import { z } from "zod";
import {
  findFilesViaRepoMap,
  rankFileCandidates,
} from "../utils/repoMapIndex";
import { buildRecoveryQueries } from "../utils/pathRecovery";

const execFileAsync = promisify(execFile);

const normalizeRelativeInputPath = (value: string): string =>
  value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\//, "");

const hasGlobMeta = (value: string): boolean => /[*?[\]{}]/.test(value);

const isNumber = (value: unknown): value is number => typeof value === "number";

const isPathInsideBase = (basePath: string, targetPath: string): boolean => {
  const relative = path.relative(basePath, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

const normalizeGlobPattern = (
  inputPattern: string,
): { patterns: string[]; anchoredToRoot: boolean } => {
  const normalized = inputPattern.replace(/\\/g, "/");
  const anchoredToRoot = normalized.startsWith("/");
  const primary = anchoredToRoot ? normalized.slice(1) : normalized;
  const patterns = [primary];

  if (primary.startsWith("**/")) {
    patterns.push(primary.slice(3));
  }

  return {
    patterns: Array.from(new Set(patterns.filter(Boolean))),
    anchoredToRoot,
  };
};

const findFilesViaTerminal = async (
  cwd: string,
  query: string,
): Promise<string[]> => {
  const normalizedQuery = normalizeRelativeInputPath(query);
  const baseName = path.basename(normalizedQuery);

  const attempts: Array<string[]> = [];

  // Exact relative path match first (most deterministic).
  if (normalizedQuery && normalizedQuery !== baseName) {
    attempts.push([
      ".",
      "-type",
      "f",
      "-path",
      `./${normalizedQuery}`,
    ]);
  }

  // Then basename match to recover from partial/incorrect relative paths.
  if (baseName) {
    attempts.push([".", "-type", "f", "-name", baseName]);
  }

  for (const args of attempts) {
    try {
      const { stdout } = await execFileAsync("find", args, {
        cwd,
        maxBuffer: 1024 * 1024 * 4,
      });

      const matches = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => path.resolve(cwd, line));

      if (matches.length > 0) {
        return rankFileCandidates(cwd, query, matches);
      }
    } catch {
      // Ignore and continue to next fallback strategy.
    }
  }

  return [];
};

type SearchFilesParams = {
  pattern?: string;
  filePath?: string;
  startLine?: number;
  endLine?: number;
  cwd?: string;
  encoding?: BufferEncoding;
};

type FileSearchResult = {
  path: string;
  relativePath: string;
  size: number;
  lastModified: Date;
};

type SearchFilesReadSuccessResult = {
  success: true;
  filePath: string;
  resolvedBy: "direct" | "repo_map" | "terminal_find";
  startLine?: number;
  endLine?: number;
  totalLines: number;
  content: string;
  lines: string[];
  size: number;
  lastModified: Date;
};

type SearchFilesPatternSuccessResult = {
  success: true;
  message?: string;
  pattern: string;
  resolvedBy?: "glob" | "repo_map" | "terminal_find" | "repo_map_ranked";
  count?: number;
  files: FileSearchResult[];
};

type SearchFilesErrorResult = {
  success: false;
  error: string;
};

type SearchFilesResult =
  | SearchFilesReadSuccessResult
  | SearchFilesPatternSuccessResult
  | SearchFilesErrorResult;

/**
 * Tool for searching files and reading specific line ranges
 * @param {Object} params - The parameters for searching files
 * @param {string} [params.pattern] - Glob pattern to search for files
 * @param {string} [params.filePath] - Specific file path to read (alternative to pattern)
 * @param {number} [params.startLine] - Starting line number (1-indexed)
 * @param {number} [params.endLine] - Ending line number (1-indexed)
 * @param {string} [params.cwd] - Current working directory for search
 * @param {string} [params.encoding='utf8'] - The encoding to use when reading the file
 * @returns {Promise<Object>} Object containing success status and search results or file content
 */
export async function searchFiles({
  pattern,
  filePath,
  startLine,
  endLine,
  cwd = process.cwd(),
  encoding = "utf8",
}: SearchFilesParams): Promise<SearchFilesResult> {
  try {
    const requestedStartLine = startLine;
    const requestedEndLine = endLine;

    if (isNumber(requestedStartLine) || isNumber(requestedEndLine)) {
      if (!isNumber(requestedStartLine) || !isNumber(requestedEndLine)) {
        return {
          success: false,
          error: "Both startLine and endLine must be provided together",
        };
      }

      if (
        !Number.isInteger(requestedStartLine)
        || !Number.isInteger(requestedEndLine)
        || requestedStartLine < 1
        || requestedEndLine < 1
      ) {
        return {
          success: false,
          error: "startLine and endLine must be positive integers",
        };
      }

      if (requestedStartLine > requestedEndLine) {
        return {
          success: false,
          error: "startLine cannot be greater than endLine",
        };
      }
    }

    const absoluteCwd = path.resolve(cwd);

    // If filePath is provided, read that specific file
    if (filePath) {
      const absolutePath = path.isAbsolute(filePath)
        ? path.resolve(filePath)
        : path.resolve(absoluteCwd, filePath);

      // Reads are allowed outside the workspace root when the resolved path is
      // directly readable, so callers can inspect sibling repos and shared files.
      let readablePath = absolutePath;
      let resolvedBy: SearchFilesReadSuccessResult["resolvedBy"] = "direct";

      // Check if file exists
      try {
        await fs.access(readablePath, fs.constants.R_OK);
      } catch {
        const recoveryQueries = buildRecoveryQueries(filePath, absoluteCwd);
        const safeRecoveredMatches: string[] = [];
        let foundByRepoMap = false;

        for (const query of recoveryQueries) {
          const repoMapMatches = await findFilesViaRepoMap(cwd, query, 5);
          const recoveredMatches =
            repoMapMatches.length > 0
              ? repoMapMatches
              : await findFilesViaTerminal(cwd, query);
          const safeMatches = recoveredMatches.filter((candidate) =>
            isPathInsideBase(absoluteCwd, path.resolve(candidate))
          );

          if (safeMatches.length > 0) {
            safeRecoveredMatches.push(...safeMatches);
            foundByRepoMap = repoMapMatches.length > 0;
            break;
          }
        }

        if (safeRecoveredMatches.length === 0) {
          return {
            success: false,
            error: `File not found or not readable: ${filePath}`,
          };
        }

        readablePath = safeRecoveredMatches[0];
        resolvedBy = foundByRepoMap ? "repo_map" : "terminal_find";
      }

      // Read file content
      const content = await fs.readFile(readablePath, encoding);
      const lines = content.split("\n");

      // Get stats
      const stats = await fs.stat(readablePath);

      // If line range is specified, extract those lines
      if (startLine !== undefined && endLine !== undefined) {
        const start = startLine - 1; // Convert to 0-indexed
        const end = endLine;

        if (start >= lines.length) {
          return {
            success: false,
            error: `Start line ${startLine} exceeds file length (${lines.length} lines)`,
          };
        }

        const selectedLines = lines.slice(start, end);

        return {
          success: true,
          filePath: readablePath,
          resolvedBy,
          startLine: start + 1,
          endLine: Math.min(end, lines.length),
          totalLines: lines.length,
          content: selectedLines.join("\n"),
          lines: selectedLines,
          size: stats.size,
          lastModified: stats.mtime,
        };
      }

      // Return entire file if no line range specified
      return {
        success: true,
        filePath: readablePath,
        resolvedBy,
        totalLines: lines.length,
        content,
        lines,
        size: stats.size,
        lastModified: stats.mtime,
      };
    }

    // If pattern is provided, search for matching files
    if (pattern) {
      let resolvedBy: SearchFilesPatternSuccessResult["resolvedBy"] = "glob";
      const { patterns, anchoredToRoot } = normalizeGlobPattern(pattern);
      const fileSets = await Promise.all(
        patterns.map((singlePattern) =>
          glob(singlePattern, {
            cwd: absoluteCwd,
            absolute: true,
            nodir: true,
            dot: true,
            matchBase: !anchoredToRoot,
            ignore: [
              "**/node_modules/**",
              "**/dist/**",
              "**/build/**",
              "**/.git/**",
            ],
          })
        )
      );

      const files = Array.from(
        new Set(fileSets.flat().filter((candidate) => isPathInsideBase(absoluteCwd, path.resolve(candidate))))
      );

      let resolvedFiles = files;

      // Fallback to terminal file search for plain names/paths when glob misses.
      if (resolvedFiles.length === 0 && !hasGlobMeta(pattern)) {
        const repoMapMatches = await findFilesViaRepoMap(cwd, pattern, 50);
        const fallbackFiles =
          repoMapMatches.length > 0
            ? repoMapMatches
            : await findFilesViaTerminal(cwd, pattern);
        resolvedFiles = fallbackFiles.filter((candidate) =>
          isPathInsideBase(absoluteCwd, path.resolve(candidate))
        );
        resolvedBy = repoMapMatches.length > 0 ? "repo_map" : "terminal_find";
      } else if (resolvedFiles.length > 1 && !hasGlobMeta(pattern)) {
        resolvedFiles = await rankFileCandidates(cwd, pattern, resolvedFiles);
        resolvedBy = "repo_map_ranked";
      }

      if (resolvedFiles.length === 0) {
        return {
          success: true,
          message: "No files found matching the pattern",
          pattern,
          resolvedBy,
          files: [],
        };
      }

      // Get file details
      const fileDetails = await Promise.all(
        resolvedFiles.map(async (file) => {
          try {
            const stats = await fs.stat(file);
            return {
              path: file,
              relativePath: path.relative(absoluteCwd, file),
              size: stats.size,
              lastModified: stats.mtime,
            } satisfies FileSearchResult;
          } catch (err) {
            return null;
          }
        })
      );

      const validFiles = fileDetails.filter(
        (file): file is FileSearchResult => file !== null
      );

      return {
        success: true,
        pattern,
        resolvedBy,
        count: resolvedFiles.length,
        files: validFiles,
      };
    }

    return {
      success: false,
      error: "Either pattern or filePath must be provided",
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
export const searchFilesTool = {
  description: "Search for files using glob patterns or read specific line ranges from a file",
  parameters: z.object({
    pattern: z.string().optional().describe("Glob pattern to search for files (e.g., \"**/*.js\", \"src/**/*.json\")"),
    filePath: z.string().optional().describe("Specific file path to read (alternative to pattern)"),
    startLine: z.number().optional().describe("Starting line number to read (1-indexed, inclusive)"),
    endLine: z.number().optional().describe("Ending line number to read (1-indexed, inclusive)"),
    cwd: z.string().default(process.cwd()).describe("Current working directory for search"),
    encoding: z.enum(["utf8", "ascii", "base64", "binary", "hex"]).default("utf8").describe("The encoding to use when reading the file"),
  }),
  execute: searchFiles,
};

export default searchFilesTool;
