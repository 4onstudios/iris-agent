import fs from "fs/promises";
import path from "path";
import { z } from "zod";

type SupportedLanguage = "javascript" | "typescript" | "python" | "java";
type SymbolKind =
  | "all"
  | "function"
  | "class"
  | "method"
  | "variable"
  | "interface"
  | "type"
  | "import"
  | "export";

type SymbolMatch = {
  name: string;
  line: number;
  text: string;
  type: string;
};

type LanguagePatternMap = Partial<Record<Exclude<SymbolKind, "all">, RegExp>>;

type GetSymbolsParams = {
  filePath: string;
  symbolType?: SymbolKind;
};

type GetSymbolsResult =
  | {
      success: true;
      filePath: string;
      language: SupportedLanguage;
      symbolType: SymbolKind;
      totalSymbols: number;
      symbols: Partial<Record<Exclude<SymbolKind, "all">, SymbolMatch[]>>;
    }
  | {
      success: false;
      error: string;
    };

// Simple code parser for common languages
const LANGUAGE_PATTERNS: Record<SupportedLanguage, LanguagePatternMap> = {
  javascript: {
    function:
      /(?:async\s+)?function\s+(\w+)\s*\(|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\([^)]*\)\s*=>/g,
    class: /class\s+(\w+)/g,
    method: /(\w+)\s*\([^)]*\)\s*{/g,
    variable: /(?:const|let|var)\s+(\w+)\s*=/g,
    import: /import\s+.*\s+from\s+['"]([^'"]+)['"]/g,
    export: /export\s+(?:default\s+)?(?:class|function|const|let|var)\s+(\w+)/g,
  },
  typescript: {
    function:
      /(?:async\s+)?function\s+(\w+)\s*\(|(?:const|let|var)\s+(\w+)\s*:\s*\([^)]*\)\s*=>/g,
    class: /class\s+(\w+)/g,
    interface: /interface\s+(\w+)/g,
    type: /type\s+(\w+)\s*=/g,
    method: /(\w+)\s*\([^)]*\)\s*:\s*\w+\s*{/g,
    variable: /(?:const|let|var)\s+(\w+)\s*:/g,
    import: /import\s+.*\s+from\s+['"]([^'"]+)['"]/g,
    export:
      /export\s+(?:default\s+)?(?:class|function|const|let|var|interface|type)\s+(\w+)/g,
  },
  python: {
    function: /def\s+(\w+)\s*\(/g,
    class: /class\s+(\w+)/g,
    method: /def\s+(\w+)\s*\(self/g,
    import: /(?:from\s+(\S+)\s+)?import\s+(\w+)/g,
    variable: /^(\w+)\s*=/gm,
  },
  java: {
    class: /(?:public\s+)?class\s+(\w+)/g,
    interface: /(?:public\s+)?interface\s+(\w+)/g,
    method: /(?:public|private|protected)\s+(?:\w+\s+)?(\w+)\s*\([^)]*\)\s*{/g,
    import: /import\s+([\w.]+);/g,
  },
};

/**
 * Tool for getting symbols (functions, classes, methods, variables) from a file
 * @param {Object} params - The parameters for getting symbols
 * @param {string} params.filePath - The path to the file to analyze
 * @param {string} [params.symbolType] - Type of symbols to find (function, class, method, variable, all)
 * @returns {Promise<Object>} Object containing symbols found or error
 */
export async function getSymbols({
  filePath,
  symbolType = "all",
}: GetSymbolsParams): Promise<GetSymbolsResult> {
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
      await fs.access(absolutePath, fs.constants.R_OK);
    } catch (err) {
      return {
        success: false,
        error: `File not found or not readable: ${filePath}`,
      };
    }

    // Detect language from file extension
    const ext = path.extname(absolutePath).slice(1).toLowerCase();
    const languageMap: Record<string, SupportedLanguage> = {
      js: "javascript",
      jsx: "javascript",
      ts: "typescript",
      tsx: "typescript",
      py: "python",
      java: "java",
      // Add more mappings as needed
    };

    const language = languageMap[ext];
    if (!language) {
      return {
        success: false,
        error: `Unsupported file type: ${ext}. Supported: ${Object.keys(
          languageMap
        ).join(", ")}`,
      };
    }

    // Read file content
    const content = await fs.readFile(absolutePath, "utf8");
    const lines = content.split("\n");

    // Get patterns for detected language
    const patterns = LANGUAGE_PATTERNS[language];
    const symbols: Partial<Record<Exclude<SymbolKind, "all">, SymbolMatch[]>> = {};

    // Extract symbols based on type
    const typesToExtract =
      symbolType === "all"
        ? (Object.keys(patterns) as Array<Exclude<SymbolKind, "all">>)
        : [symbolType];

    for (const type of typesToExtract) {
      if (!patterns[type]) continue;

      const pattern = patterns[type];
      if (!pattern) continue;

      const matches: SymbolMatch[] = [];
      let match: RegExpExecArray | null;

      // Reset regex state
      pattern.lastIndex = 0;

      while ((match = pattern.exec(content)) !== null) {
        // Find line number
        const position = match.index;
        const lineNumber = content.substring(0, position).split("\n").length;

        // Get the symbol name (could be in different capture groups)
        const symbolName = match[1] || match[2] || "unknown";

        matches.push({
          name: symbolName,
          line: lineNumber,
          text: lines[lineNumber - 1]?.trim() || "",
          type,
        });
      }

      if (matches.length > 0) {
        symbols[type] = matches;
      }
    }

    // Count total symbols
    const totalSymbols = Object.values(symbols).reduce(
      (sum, arr) => sum + arr.length,
      0
    );

    return {
      success: true,
      filePath: absolutePath,
      language,
      symbolType,
      totalSymbols,
      symbols,
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
export const getSymbolsTool = {
  description:
    "Get symbols (functions, classes, methods, variables) from a code file",
  parameters: z.object({
    filePath: z.string().describe("The path to the file to analyze"),
    symbolType: z
      .enum([
        "all",
        "function",
        "class",
        "method",
        "variable",
        "interface",
        "type",
        "import",
        "export",
      ])
      .default("all")
      .describe("Type of symbols to find"),
  }),
  execute: getSymbols,
};

export default getSymbolsTool;
