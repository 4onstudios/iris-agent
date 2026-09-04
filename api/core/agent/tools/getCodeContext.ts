import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import fs from "fs/promises";
import path from "path";

type CodeContextParams = {
  query: string;
  targetFiles?: string[];
  symbols?: string[];
  includeDefinitions?: boolean;
  includeUsages?: boolean;
  maxResults?: number;
  cwd?: string;
};

type SnippetResult = {
  code: string;
  startLine: number;
  endLine: number;
  totalLines: number;
};

type SymbolMatch = {
  line: number;
  type: "definition" | "usage";
  text: string;
};

type CodeReference = {
  filePath: string;
  code: string;
  startLine: number;
  endLine: number;
  description: string;
  symbol?: string;
  type: "definition" | "usage" | "match";
};

type CodeContextResult = {
  success: boolean;
  query: string;
  codeReferences: CodeReference[];
  summary?: string;
  error?: string;
};

/**
 * getCodeContext tool - Fetches relevant code snippets for answering questions
 * Similar to how VS Code Copilot finds and references code
 */
const getCodeContextTool = createTool({
  id: "getCodeContext",
  description: `Get code context and snippets relevant to a user's question. Use this tool when:
- User asks about how code works or what it does
- User wants to understand a specific function, class, or variable
- User asks about connections between different parts of the code
- User needs context about a specific file or feature

This tool searches for relevant code and returns snippets with file paths and line numbers,
formatted for display with proper code references (like VS Code Copilot style).`,
  inputSchema: z.object({
    query: z
      .string()
      .describe(
        "The question or topic to find code context for (e.g., 'how does authentication work', 'where is the API called')"
      ),
    targetFiles: z
      .array(z.string())
      .optional()
      .describe("Specific files to search in (relative paths)"),
    symbols: z
      .array(z.string())
      .optional()
      .describe(
        "Specific symbol names to look for (function names, class names, variables)"
      ),
    includeDefinitions: z
      .boolean()
      .optional()
      .default(true)
      .describe("Whether to include symbol definitions"),
    includeUsages: z
      .boolean()
      .optional()
      .default(true)
      .describe("Whether to include where symbols are used"),
    maxResults: z
      .number()
      .optional()
      .default(5)
      .describe("Maximum number of code snippets to return"),
    cwd: z.string().optional().describe("Working directory (workspace root)"),
  }),
  execute: async ({
    query,
    targetFiles,
    symbols,
    includeDefinitions = true,
    includeUsages = true,
    maxResults = 5,
    cwd,
  }: CodeContextParams): Promise<CodeContextResult> => {
    const workspacePath = cwd || process.cwd();
    const results: CodeContextResult = {
      success: true,
      query,
      codeReferences: [],
      summary: "",
    };

    try {
      // Helper to read file and extract snippet around a line
      const extractSnippet = async (
        filePath: string,
        targetLine: number,
        contextLines = 5
      ): Promise<SnippetResult | null> => {
        try {
          const absolutePath = path.isAbsolute(filePath)
            ? filePath
            : path.join(workspacePath, filePath);
          const content = await fs.readFile(absolutePath, "utf-8");
          const lines = content.split("\n");

          const startLine = Math.max(0, targetLine - contextLines - 1);
          const endLine = Math.min(
            lines.length - 1,
            targetLine + contextLines - 1
          );

          return {
            code: lines.slice(startLine, endLine + 1).join("\n"),
            startLine: startLine + 1,
            endLine: endLine + 1,
            totalLines: lines.length,
          };
        } catch {
          return null;
        }
      };

      // Helper to find symbol definitions in a file
      const findSymbolInFile = async (
        filePath: string,
        symbolName: string
      ): Promise<SymbolMatch[]> => {
        try {
          const absolutePath = path.isAbsolute(filePath)
            ? filePath
            : path.join(workspacePath, filePath);
          const content = await fs.readFile(absolutePath, "utf-8");
          const lines = content.split("\n");
          const matches: SymbolMatch[] = [];

          // Patterns for different types of definitions
          const patterns = [
            // Function declarations
            new RegExp(
              `^\\s*(async\\s+)?function\\s+${symbolName}\\s*\\(`,
              "m"
            ),
            // Arrow functions and const/let/var declarations
            new RegExp(
              `^\\s*(export\\s+)?(const|let|var)\\s+${symbolName}\\s*=`,
              "m"
            ),
            // Class declarations
            new RegExp(`^\\s*(export\\s+)?class\\s+${symbolName}\\b`, "m"),
            // Method definitions in classes
            new RegExp(
              `^\\s*(async\\s+)?${symbolName}\\s*\\([^)]*\\)\\s*{`,
              "m"
            ),
            // TypeScript interface/type
            new RegExp(
              `^\\s*(export\\s+)?(interface|type)\\s+${symbolName}\\b`,
              "m"
            ),
            // Object property (for enums, etc.)
            new RegExp(`\\b${symbolName}\\s*[:=]\\s*`, "m"),
          ];

          lines.forEach((line, index) => {
            for (const pattern of patterns) {
              if (pattern.test(line)) {
                matches.push({
                  line: index + 1,
                  type: "definition",
                  text: line.trim(),
                });
                break;
              }
            }
          });

          return matches;
        } catch {
          return [];
        }
      };

      // Helper to find symbol usages in a file
      const findUsagesInFile = async (
        filePath: string,
        symbolName: string
      ): Promise<SymbolMatch[]> => {
        try {
          const absolutePath = path.isAbsolute(filePath)
            ? filePath
            : path.join(workspacePath, filePath);
          const content = await fs.readFile(absolutePath, "utf-8");
          const lines = content.split("\n");
          const usages: SymbolMatch[] = [];

          const usagePattern = new RegExp(`\\b${symbolName}\\b`, "g");

          lines.forEach((line, index) => {
            if (usagePattern.test(line)) {
              // Skip if it's an import statement
              if (!line.trim().startsWith("import ")) {
                usages.push({
                  line: index + 1,
                  type: "usage",
                  text: line.trim(),
                });
              }
            }
          });

          return usages;
        } catch {
          return [];
        }
      };

      // Get list of files to search
      let filesToSearch = targetFiles || [];

      // If no specific files, get relevant files from workspace
      if (filesToSearch.length === 0) {
        try {
          const { glob } = await import("glob");
          const pattern =
            "**/*.{js,jsx,ts,tsx,py,java,swift,kt,go,rs,c,cpp,cs}";
          const files = await glob(pattern, {
            cwd: workspacePath,
            ignore: [
              "**/node_modules/**",
              "**/dist/**",
              "**/build/**",
              "**/.git/**",
            ],
            nodir: true,
          });
          filesToSearch = files.slice(0, 20); // Limit to 20 files for performance
        } catch (e) {
          console.error("Error globbing files:", e);
        }
      }

      // Search for symbols if provided
      if (symbols && symbols.length > 0) {
        for (const symbol of symbols) {
          for (const file of filesToSearch) {
            // Find definitions
            if (includeDefinitions) {
              const definitions = await findSymbolInFile(file, symbol);
              for (const def of definitions) {
                const snippet = await extractSnippet(file, def.line, 8);
                if (snippet) {
                  results.codeReferences.push({
                    filePath: file,
                    code: snippet.code,
                    startLine: snippet.startLine,
                    endLine: snippet.endLine,
                    description: `Definition of \`${symbol}\``,
                    symbol,
                    type: "definition",
                  });
                }
              }
            }

            // Find usages
            if (includeUsages) {
              const usages = await findUsagesInFile(file, symbol);
              // Limit usages per file
              for (const usage of usages.slice(0, 3)) {
                const snippet = await extractSnippet(file, usage.line, 3);
                if (snippet) {
                  results.codeReferences.push({
                    filePath: file,
                    code: snippet.code,
                    startLine: snippet.startLine,
                    endLine: snippet.endLine,
                    description: `Usage of \`${symbol}\``,
                    symbol,
                    type: "usage",
                  });
                }
              }
            }
          }
        }
      }

      // If query contains code snippet, search for it
      const codePatterns = query.match(/`([^`]+)`/g);
      if (codePatterns) {
        for (const pattern of codePatterns) {
          const searchTerm = pattern.replace(/`/g, "");
          for (const file of filesToSearch) {
            try {
              const absolutePath = path.isAbsolute(file)
                ? file
                : path.join(workspacePath, file);
              const content = await fs.readFile(absolutePath, "utf-8");

              if (content.includes(searchTerm)) {
                const lines = content.split("\n");
                const lineIndex = lines.findIndex((l) =>
                  l.includes(searchTerm)
                );
                if (lineIndex >= 0) {
                  const snippet = await extractSnippet(file, lineIndex + 1, 5);
                  if (snippet) {
                    results.codeReferences.push({
                      filePath: file,
                      code: snippet.code,
                      startLine: snippet.startLine,
                      endLine: snippet.endLine,
                      description: `Contains \`${searchTerm}\``,
                      type: "match",
                    });
                  }
                }
              }
            } catch {
              // Skip files that can't be read
            }
          }
        }
      }

      // Limit results
      results.codeReferences = results.codeReferences.slice(0, maxResults);

      // Generate summary
      if (results.codeReferences.length > 0) {
        const defCount = results.codeReferences.filter(
          (r) => r.type === "definition"
        ).length;
        const usageCount = results.codeReferences.filter(
          (r) => r.type === "usage"
        ).length;
        const matchCount = results.codeReferences.filter(
          (r) => r.type === "match"
        ).length;

        const parts = [];
        if (defCount > 0) parts.push(`${defCount} definition(s)`);
        if (usageCount > 0) parts.push(`${usageCount} usage(s)`);
        if (matchCount > 0) parts.push(`${matchCount} match(es)`);

        results.summary = `Found ${parts.join(", ")} across ${
          new Set(results.codeReferences.map((r) => r.filePath)).size
        } file(s)`;
      } else {
        results.summary = "No relevant code found for the query";
      }

      return results;
    } catch (error) {
      const err = error as Error;
      return {
        success: false,
        error: err.message,
        query,
        codeReferences: [],
      };
    }
  },
});

export default getCodeContextTool;
