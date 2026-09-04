/**
 * Get Workspace Symbols Tool
 * Uses LSP to search for symbols across the entire workspace by name/query.
 */

import { coreLsp } from "../../library/lsp/coreLsp";
import { fileURLToPath } from "url";

type LspWorkspaceSymbol = {
  name?: string;
  kind?: number;
  containerName?: string;
  location?: {
    uri?: string;
    range?: {
      start?: { line?: number; character?: number };
    };
  };
};

type GetWorkspaceSymbolsParams = {
  query: string;
  languageId?: string;
  maxResults?: number;
};

type WorkspaceSymbol = {
  name: string;
  kind: string;
  containerName: string;
  filePath: string;
  line: number;
  character: number;
};

type GetWorkspaceSymbolsResult =
  | {
      success: true;
      query: string;
      totalSymbols: number;
      symbols: WorkspaceSymbol[];
      byKind: Record<string, WorkspaceSymbol[]>;
    }
  | {
      success: false;
      message?: string;
      error?: string;
      query: string;
    };

const symbolKindNames: Record<number, string> = {
  1: "File", 2: "Module", 3: "Namespace", 4: "Package", 5: "Class",
  6: "Method", 7: "Property", 8: "Field", 9: "Constructor", 10: "Enum",
  11: "Interface", 12: "Function", 13: "Variable", 14: "Constant",
  15: "String", 16: "Number", 17: "Boolean", 18: "Array", 19: "Object",
  20: "Key", 21: "Null", 22: "EnumMember", 23: "Struct", 24: "Event",
  25: "Operator", 26: "TypeParameter",
};

const getWorkspaceSymbolsTool = {
  name: "getWorkspaceSymbols",
  description: `Search for symbols (functions, classes, variables, types) across the entire workspace by name.
Returns matching symbols with their file locations and kinds.

Use this when you need to:
- Find where a class or function is defined without knowing the file
- Search for all symbols matching a pattern across the project
- Get a list of all exports or public API symbols
- Locate a symbol quickly by partial name`,

  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query — partial name or pattern to match symbols against",
      },
      languageId: {
        type: "string",
        description: "Optional language ID to limit search to one language server (e.g. 'typescript')",
      },
      maxResults: {
        type: "number",
        description: "Maximum number of results to return (default: 50)",
      },
    },
    required: ["query"],
  },

  async execute({ query, languageId, maxResults = 50 }: GetWorkspaceSymbolsParams): Promise<GetWorkspaceSymbolsResult> {
    try {
      const result = (await coreLsp.getWorkspaceSymbols(query, languageId)) as
        | LspWorkspaceSymbol[]
        | null;

      if (!result || result.length === 0) {
        return {
          success: false,
          message: `No workspace symbols found matching "${query}"`,
          query,
        };
      }

      const symbols: WorkspaceSymbol[] = result
        .slice(0, maxResults)
        .map((sym) => {
          const uri = sym.location?.uri ?? "";
          let filePath = uri;
          try {
            filePath = uri.startsWith("file://") ? fileURLToPath(uri) : uri;
          } catch {
            filePath = uri.replace("file://", "");
          }

          return {
            name: sym.name ?? "",
            kind: symbolKindNames[sym.kind ?? 0] ?? `Unknown(${sym.kind})`,
            containerName: sym.containerName ?? "",
            filePath,
            line: (sym.location?.range?.start?.line ?? 0) + 1,
            character: (sym.location?.range?.start?.character ?? 0) + 1,
          };
        });

      const byKind: Record<string, WorkspaceSymbol[]> = {};
      for (const sym of symbols) {
        if (!byKind[sym.kind]) byKind[sym.kind] = [];
        byKind[sym.kind].push(sym);
      }

      return {
        success: true,
        query,
        totalSymbols: symbols.length,
        symbols,
        byKind,
      };
    } catch (error) {
      const err = error as Error;
      return {
        success: false,
        error: err.message,
        query,
      };
    }
  },
};

export default getWorkspaceSymbolsTool;
