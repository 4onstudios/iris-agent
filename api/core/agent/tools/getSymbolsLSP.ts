/**
 * Get Symbols Tool (LSP-based)
 * Uses Language Server Protocol to extract symbols from a file
 * More accurate than regex-based parsing
 */

import { coreLsp } from "../../library/lsp/coreLsp";
import fs from "fs/promises";

type SymbolRange = {
  start: { line: number; character: number };
  end: { line: number; character: number };
};

type LspDocumentSymbol = {
  name: string;
  kind: number;
  detail?: string;
  range?: SymbolRange;
  selectionRange?: SymbolRange;
  location?: {
    range?: SymbolRange;
  };
  children?: LspDocumentSymbol[];
};

type ParsedSymbol = {
  name: string;
  kind: string;
  line: number;
  character: number;
  endLine: number;
  endCharacter: number;
  detail?: string;
  children?: ParsedSymbol[];
};

type FlatSymbol = {
  name: string;
  kind: string;
  line: number;
  detail?: string;
};

type SymbolsByKind = Record<string, FlatSymbol[]>;

type GetSymbolsLSPParams = {
  filePath: string;
};

type GetSymbolsLSPResult =
  | {
      success: true;
      filePath: string;
      totalSymbols: number;
      hierarchical: ParsedSymbol[];
      flat: FlatSymbol[];
      byKind: SymbolsByKind;
      summary: Array<{ kind: string; count: number }>;
    }
  | {
      success: false;
      message?: string;
      error?: string;
      filePath: string;
    };

const getSymbolsLSPTool = {
  name: "getSymbolsLSP",
  description: `Get all symbols (functions, classes, variables, types) from a file using LSP.
Provides accurate symbol information including:
- Symbol name and kind (function, class, variable, etc.)
- Exact location (line, character)
- Hierarchical structure (nested symbols)
- More accurate than regex-based parsing

Use this for:
- Understanding file structure
- Finding all functions/classes
- Navigation and code exploration
- Refactoring preparation`,

  parameters: {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description: "Absolute path to the file to analyze",
      },
    },
    required: ["filePath"],
  },

  async execute({ filePath }: GetSymbolsLSPParams): Promise<GetSymbolsLSPResult> {
    try {
      // Verify file exists
      await fs.access(filePath);

      // Get document symbols from LSP
      const symbolsResult = await coreLsp.getDocumentSymbols(filePath);
      const symbols = symbolsResult as LspDocumentSymbol[] | null;

      if (!symbols || symbols.length === 0) {
        return {
          success: false,
          message: `No symbols found in ${filePath}`,
          filePath,
        };
      }

      // Convert symbol kinds to readable names
      const symbolKindNames: Record<number, string> = {
        1: "File",
        2: "Module",
        3: "Namespace",
        4: "Package",
        5: "Class",
        6: "Method",
        7: "Property",
        8: "Field",
        9: "Constructor",
        10: "Enum",
        11: "Interface",
        12: "Function",
        13: "Variable",
        14: "Constant",
        15: "String",
        16: "Number",
        17: "Boolean",
        18: "Array",
        19: "Object",
        20: "Key",
        21: "Null",
        22: "EnumMember",
        23: "Struct",
        24: "Event",
        25: "Operator",
        26: "TypeParameter",
      };

      // Parse symbols recursively
      const parseSymbol = (symbol: LspDocumentSymbol): ParsedSymbol => {
        const range = symbol.range || symbol.location?.range;
        const selectionRange = symbol.selectionRange || range;

        if (!range || !selectionRange) {
          throw new Error("Symbol is missing range information");
        }

        const parsed: ParsedSymbol = {
          name: symbol.name,
          kind: symbolKindNames[symbol.kind] || `Unknown(${symbol.kind})`,
          line: selectionRange.start.line + 1, // Convert to 1-based
          character: selectionRange.start.character + 1,
          endLine: range.end.line + 1,
          endCharacter: range.end.character + 1,
          detail: symbol.detail || undefined,
        };

        // Parse children recursively
        if (symbol.children && symbol.children.length > 0) {
          parsed.children = symbol.children.map(parseSymbol);
        }

        return parsed;
      };

      const parsedSymbols = symbols.map(parseSymbol);

      // Flatten symbols for summary (without children)
      const flattenSymbols = (
        symbols: ParsedSymbol[],
        prefix = ""
      ): FlatSymbol[] => {
        const result: FlatSymbol[] = [];
        for (const symbol of symbols) {
          const fullName = prefix ? `${prefix}.${symbol.name}` : symbol.name;
          result.push({
            name: fullName,
            kind: symbol.kind,
            line: symbol.line,
            detail: symbol.detail,
          });

          if (symbol.children) {
            result.push(...flattenSymbols(symbol.children, fullName));
          }
        }
        return result;
      };

      const flatSymbols = flattenSymbols(parsedSymbols);

      // Group by kind
      const symbolsByKind: SymbolsByKind = {};
      flatSymbols.forEach((symbol) => {
        if (!symbolsByKind[symbol.kind]) {
          symbolsByKind[symbol.kind] = [];
        }
        symbolsByKind[symbol.kind].push(symbol);
      });

      return {
        success: true,
        filePath,
        totalSymbols: flatSymbols.length,
        hierarchical: parsedSymbols,
        flat: flatSymbols,
        byKind: symbolsByKind,
        summary: Object.keys(symbolsByKind).map((kind) => ({
          kind,
          count: symbolsByKind[kind].length,
        })),
      };
    } catch (error) {
      const err = error as Error;
      return {
        success: false,
        error: err.message,
        filePath,
      };
    }
  },
};

export default getSymbolsLSPTool;
