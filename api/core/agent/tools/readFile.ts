import fs from "fs/promises";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { z } from "zod";
import { knowledgeGraph } from "../../library/knowledgeGraph";
import {
  findFilesViaRepoMap,
  rankFileCandidates,
} from "../utils/repoMapIndex";
import { buildRecoveryQueries } from "../utils/pathRecovery";

const execFileAsync = promisify(execFile);
const MAX_READ_LINES = 500;

const normalizeRelativeInputPath = (value: string): string =>
  value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\//, "");

const isPathInsideBase = (basePath: string, targetPath: string): boolean => {
  const relative = path.relative(basePath, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

const findFileViaTerminal = async (
  cwd: string,
  query: string,
): Promise<string | null> => {
  const normalizedQuery = normalizeRelativeInputPath(query);
  const baseName = path.basename(normalizedQuery);

  const attempts: Array<string[]> = [];

  if (normalizedQuery && normalizedQuery !== baseName) {
    attempts.push([
      ".",
      "-type",
      "f",
      "-path",
      `./${normalizedQuery}`,
    ]);
  }

  if (baseName) {
    attempts.push([".", "-type", "f", "-name", baseName]);
  }

  for (const args of attempts) {
    try {
      const { stdout } = await execFileAsync("find", args, {
        cwd,
        maxBuffer: 1024 * 1024 * 4,
      });

      const firstMatch = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

      const rankedMatches = await rankFileCandidates(
        cwd,
        query,
        firstMatch.map((match) => path.resolve(cwd, match)),
      );

      const bestMatch = rankedMatches[0];

      if (bestMatch) {
        return bestMatch;
      }
    } catch {
      // Ignore and continue to next fallback strategy.
    }
  }

  return null;
};

type ReadFileParams = {
  filePath: string;
  workspaceRoot?: string;
  encoding?: BufferEncoding;
  parseWithKnowledgeGraph?: boolean;
  startLine?: number;
  endLine?: number;
  withLineNumbers?: boolean;
};

type ReadFileErrorResult = {
  success: false;
  error: string;
  attemptedPath?: string;
};

type ReadFileComponent = {
  type: string;
  name: string;
  line: number | undefined;
};

type KnowledgeGraphParseResult =
  | {
      parsed: true;
      language: string;
      components: ReadFileComponent[];
      tokenCount: number;
      relationships: Array<{
        type: string;
        target: string;
      }>;
    }
  | {
      parsed: false;
      error: string;
    };

type ReadFileSuccessResult = {
  success: true;
  filePath: string;
  resolvedBy: "direct" | "repo_map" | "terminal_find";
  content: string;
  startLine?: number;
  endLine?: number;
  totalLines?: number;
  hasMore?: boolean;
  nextStartLine?: number;
  nextEndLine?: number;
  size: number;
  lastModified: Date;
  knowledgeGraph: KnowledgeGraphParseResult | null;
};

type ReadFileResult = ReadFileSuccessResult | ReadFileErrorResult;

/**
 * Detect language from file extension
 */
function detectLanguage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase().replace(/^\./, "");
  if (!ext) {
    return "text";
  }
  switch (ext) {
    case "js":
      return "javascript";
    case "jsx":
      return "jsx";
    case "ts":
      return "typescript";
    case "tsx":
      return "tsx";
    case "py":
      return "python";
    case "java":
      return "java";
    case "go":
      return "go";
    case "cpp":
      return "cpp";
    case "c":
      return "c";
    case "cs":
      return "csharp";
    case "rb":
      return "ruby";
    case "php":
      return "php";
    default:
      return "text";
  }
}

/**
 * Tool for reading file contents
 * @param {Object} params - The parameters for reading a file
 * @param {string} params.filePath - The path to the file to read
 * @param {string} [params.encoding='utf8'] - The encoding to use when reading the file
 * @param {boolean} [params.parseWithKnowledgeGraph=true] - Whether to parse file with knowledge graph
 * @returns {Promise<Object>} Object containing success status and file content or error
 */
export async function readFile({
  filePath,
  workspaceRoot,
  encoding = "utf8",
  parseWithKnowledgeGraph = true,
  startLine,
  endLine,
  withLineNumbers,
}: ReadFileParams): Promise<ReadFileResult> {
  try {
    // Validate input
    if (!filePath) {
      return {
        success: false,
        error: "File path is required",
      };
    }

    if ((startLine === undefined) !== (endLine === undefined)) {
      return {
        success: false,
        error: "Both startLine and endLine must be provided together",
      };
    }

    if (startLine !== undefined && endLine !== undefined) {
      const validatedEndLine = endLine;
      if (
        !Number.isInteger(startLine)
        || !Number.isInteger(validatedEndLine)
        || startLine < 1
        || validatedEndLine < 1
      ) {
        return {
          success: false,
          error: "startLine and endLine must be positive integers",
        };
      }
    }

    if (
      startLine !== undefined
      && endLine !== undefined
      && startLine > endLine
    ) {
      return {
        success: false,
        error: "startLine cannot be greater than endLine",
      };
    }

    // Prefer the active workspace root when provided so reads keep working
    // after the UI switches folders without changing the server cwd.
    const effectiveWorkspaceRoot = workspaceRoot || process.cwd();
    const absoluteWorkspaceRoot = path.resolve(effectiveWorkspaceRoot);

    // If path is already absolute, use it; otherwise resolve from workspace root.
    // Reads are allowed outside the workspace root when the resolved path is
    // directly readable, so callers can inspect sibling repos and shared files.
    const absolutePath = path.isAbsolute(filePath)
      ? path.resolve(filePath)
      : path.join(effectiveWorkspaceRoot, filePath);
    let readablePath = absolutePath;
    let resolvedBy: ReadFileSuccessResult["resolvedBy"] = "direct";

    // Check if file exists
    try {
      await fs.access(readablePath, fs.constants.R_OK);
    } catch {
      const recoveryQueries = buildRecoveryQueries(filePath, absoluteWorkspaceRoot);
      let recoveredPath: string | null = null;
      let recoveredByRepoMap = false;

      for (const query of recoveryQueries) {
        const fromRepoMap = await findFilesViaRepoMap(effectiveWorkspaceRoot, query, 1);
        const recoveredPathCandidate =
          fromRepoMap[0] || (await findFileViaTerminal(effectiveWorkspaceRoot, query));
        const safeRecoveredPath = recoveredPathCandidate
          && isPathInsideBase(absoluteWorkspaceRoot, path.resolve(recoveredPathCandidate))
          ? recoveredPathCandidate
          : null;

        if (safeRecoveredPath) {
          recoveredPath = safeRecoveredPath;
          recoveredByRepoMap = Boolean(fromRepoMap[0]);
          break;
        }
      }

      if (!recoveredPath) {
        return {
          success: false,
          error: `File not found or not readable: ${filePath}`,
          attemptedPath: absolutePath,
        };
      }

      readablePath = recoveredPath;
      resolvedBy = recoveredByRepoMap ? "repo_map" : "terminal_find";
    }

    // Get file stats
    const stats = await fs.stat(readablePath);

    if (!stats.isFile()) {
      return {
        success: false,
        error: `Path is not a file: ${filePath}`,
      };
    }

    // Read file content
    const fullContent = await fs.readFile(readablePath, encoding);
    let content = fullContent;
    let selectedStartLine: number | undefined;
    let selectedEndLine: number | undefined;
    let totalLines: number | undefined;

    const shouldChunkText = encoding === "utf8" || encoding === "ascii";
    if (shouldChunkText) {
      const lines = fullContent.split("\n");
      totalLines = lines.length;
      const requestedStartLine = startLine ?? 1;
      const requestedEndLine = endLine ?? totalLines;

      if (requestedStartLine > totalLines) {
        return {
          success: false,
          error: `Start line ${requestedStartLine} exceeds file length (${totalLines} lines)`,
        };
      }

      selectedStartLine = requestedStartLine;
      selectedEndLine = Math.min(
        requestedEndLine,
        selectedStartLine + MAX_READ_LINES - 1,
        totalLines,
      );

      const selectedLines = lines.slice(selectedStartLine - 1, selectedEndLine);
      const shouldAddLineNumbers = withLineNumbers ?? startLine !== undefined;
      content = shouldAddLineNumbers
        ? selectedLines
            .map((line, index) => `${selectedStartLine! + index}:${line}`)
            .join("\n")
        : selectedLines.join("\n");
    }

    // Parse with knowledge graph if enabled and file is code
    let parseResult: KnowledgeGraphParseResult | null = null;
    const language = detectLanguage(readablePath);
    const codeLanguages = [
      "javascript",
      "jsx",
      "typescript",
      "tsx",
      "python",
      "java",
      "go",
    ];

    if (parseWithKnowledgeGraph && codeLanguages.includes(language)) {
      try {
        knowledgeGraph.indexFile({
          path: readablePath,
          name: path.basename(readablePath),
          content: fullContent,
          language,
        });

        // Get code summary from knowledge graph
        const node = knowledgeGraph.nodes.get(readablePath);
        if (node) {
          const parsedComponents: ReadFileComponent[] = Array.from(
            knowledgeGraph.nodes.values(),
          )
            .filter(
              (n) => n.metadata.filePath === readablePath && n.id !== readablePath,
            )
            .map((n) => ({
              type: n.type,
              name: String(n.metadata.name || n.id.split(":").pop() || ""),
              line: n.metadata.startLine,
            }));

          parseResult = {
            parsed: true,
            language,
            components: parsedComponents,
            tokenCount: node.tokenCount,
            relationships: Array.from(node.relationships).map((rel) => ({
              type: rel.type,
              target: rel.nodeId,
            })),
          };
        }
      } catch (parseError) {
        const error = parseError as Error;
        console.error("Knowledge graph parsing error:", parseError);
        parseResult = {
          parsed: false,
          error: error.message,
        };
      }
    }

    return {
      success: true,
      filePath: readablePath,
      resolvedBy,
      content,
      ...(selectedStartLine !== undefined
        ? {
            startLine: selectedStartLine,
            endLine: selectedEndLine,
            totalLines,
            hasMore: selectedEndLine! < totalLines!,
            ...(selectedEndLine! < totalLines!
              ? {
                  nextStartLine: selectedEndLine! + 1,
                  nextEndLine: Math.min(selectedEndLine! + MAX_READ_LINES, totalLines!),
                }
              : {}),
          }
        : {}),
      size: stats.size,
      lastModified: stats.mtime,
      knowledgeGraph: parseResult,
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
export const readFileTool = {
  name: "read_file",
  description:
    "Read up to 500 lines of a file. Use startLine and endLine with the returned next range to continue reading large files",
  parameters: z.object({
    filePath: z
      .string()
      .describe("The path to the file to read (can be relative or absolute)"),
    workspaceRoot: z
      .string()
      .optional()
      .describe("Workspace root used for path validation and recovery"),
    encoding: z
      .enum(["utf8", "ascii", "base64", "binary", "hex"])
      .default("utf8")
      .describe("The encoding to use when reading the file"),
    startLine: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("First line to return (1-based, inclusive). Must be provided together with endLine"),
    endLine: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Last line to return (1-based, inclusive). Must be provided together with startLine"),
    withLineNumbers: z
      .boolean()
      .optional()
      .describe("Prefix each returned line with its line number. Defaults to true when a range is requested"),
    parseWithKnowledgeGraph: z
      .boolean()
      .default(true)
      .describe(
        "Whether to automatically parse code files with the knowledge graph for enhanced analysis"
      ),
  }),
  execute: readFile,
};

export default readFileTool;
