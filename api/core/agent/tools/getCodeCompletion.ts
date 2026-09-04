/**
 * Get Code Completion Tool
 * Uses LSP to provide intelligent code completion suggestions
 */

import { coreLsp } from "../../library/lsp/coreLsp";
import fs from "fs/promises";

type CompletionRange = {
  start: { line: number; character: number };
  end: { line: number; character: number };
};

type CompletionTextEdit = {
  newText?: string;
  range?: CompletionRange;
  insert?: {
    newText?: string;
    range?: CompletionRange;
  };
};

type CompletionDocumentation = string | { value?: string };

type CompletionItem = {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: CompletionDocumentation;
  insertText?: string;
  textEdit?: CompletionTextEdit;
  sortText?: string;
  filterText?: string;
  deprecated?: boolean;
  preselect?: boolean;
};

type CompletionList = {
  items?: CompletionItem[];
  isIncomplete?: boolean;
};

type ParsedCompletionItem = {
  label: string;
  kind: string;
  detail?: string;
  documentation?: string;
  insertText: string;
  sortText: string;
  filterText: string;
  deprecated: boolean;
  preselect: boolean;
};

type GetCodeCompletionParams = {
  filePath: string;
  line: number;
  character: number;
  triggerCharacter?: string;
};

type GetCodeCompletionResult =
  | {
      success: true;
      filePath: string;
      position: { line: number; character: number };
      triggerCharacter?: string;
      totalItems: number;
      itemsReturned: number;
      isIncomplete: boolean;
      topSuggestions: ParsedCompletionItem[];
      allSuggestions: ParsedCompletionItem[];
      byKind: Record<string, ParsedCompletionItem[]>;
      summary: Array<{ kind: string; count: number }>;
    }
  | {
      success: false;
      message?: string;
      error?: string;
      filePath: string;
      position: { line: number; character: number };
    };

const getCodeCompletionTool = {
  name: "getCodeCompletion",
  description: `Get intelligent code completion suggestions at a specific position in a file.
Provides context-aware suggestions including:
- Variable names and properties
- Function names and parameters
- Type suggestions
- Import suggestions
- Snippet completions

Use this when you need to:
- Autocomplete code while writing
- Discover available methods/properties
- Find correct function signatures
- Get import suggestions`,

  parameters: {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description: "Absolute path to the file",
      },
      line: {
        type: "number",
        description: "Line number (1-based) where completion is needed",
      },
      character: {
        type: "number",
        description: "Character position (1-based) within the line",
      },
      triggerCharacter: {
        type: "string",
        description:
          "Optional trigger character like '.', '(' that initiated completion",
      },
    },
    required: ["filePath", "line", "character"],
  },

  async execute({
    filePath,
    line,
    character,
    triggerCharacter,
  }: GetCodeCompletionParams): Promise<GetCodeCompletionResult> {
    try {
      // Verify file exists
      await fs.access(filePath);

      // Get completion from LSP
      const completionResult = (await coreLsp.getCompletion(
        filePath,
        line,
        character
      )) as CompletionItem[] | CompletionList | null;

      if (!completionResult) {
        return {
          success: false,
          message: `No completions available at ${filePath}:${line}:${character}`,
          filePath,
          position: { line, character },
        };
      }

      // Handle both CompletionList and CompletionItem[] formats
      let items: CompletionItem[] = [];
      let isIncomplete = false;

      if (Array.isArray(completionResult)) {
        items = completionResult;
      } else if (completionResult.items) {
        items = completionResult.items;
        isIncomplete = completionResult.isIncomplete || false;
      }

      if (items.length === 0) {
        return {
          success: false,
          message: `No completion suggestions at ${filePath}:${line}:${character}`,
          filePath,
          position: { line, character },
        };
      }

      // Parse completion items
      const completionKindNames: Record<number, string> = {
        1: "Text",
        2: "Method",
        3: "Function",
        4: "Constructor",
        5: "Field",
        6: "Variable",
        7: "Class",
        8: "Interface",
        9: "Module",
        10: "Property",
        11: "Unit",
        12: "Value",
        13: "Enum",
        14: "Keyword",
        15: "Snippet",
        16: "Color",
        17: "File",
        18: "Reference",
        19: "Folder",
        20: "EnumMember",
        21: "Constant",
        22: "Struct",
        23: "Event",
        24: "Operator",
        25: "TypeParameter",
      };

      const parsedItems: ParsedCompletionItem[] = items.slice(0, 50).map((item) => {
        // Extract text to insert
        let insertText = item.insertText || item.label;
        let textEdit = null;

        if (item.textEdit) {
          textEdit = {
            newText: item.textEdit.newText || item.textEdit.insert?.newText,
            range: item.textEdit.range || item.textEdit.insert?.range,
          };
          insertText = textEdit.newText ?? insertText;
        }

        return {
          label: item.label,
          kind:
            item.kind !== undefined
              ? completionKindNames[item.kind] || "Unknown"
              : "Unknown",
          detail: item.detail || undefined,
          documentation:
            typeof item.documentation === "string"
              ? item.documentation
              : item.documentation?.value || undefined,
          insertText,
          sortText: item.sortText || item.label,
          filterText: item.filterText || item.label,
          deprecated: item.deprecated || false,
          preselect: item.preselect || false,
        };
      });

      // Group by kind for easier consumption
      const byKind: Record<string, ParsedCompletionItem[]> = {};
      parsedItems.forEach((item) => {
        if (!byKind[item.kind]) {
          byKind[item.kind] = [];
        }
        byKind[item.kind].push(item);
      });

      // Top suggestions (preselected or first 10)
      const topSuggestions = parsedItems
        .filter((item) => item.preselect)
        .slice(0, 5);

      if (topSuggestions.length === 0) {
        topSuggestions.push(...parsedItems.slice(0, 10));
      }

      return {
        success: true,
        filePath,
        position: { line, character },
        triggerCharacter,
        totalItems: items.length,
        itemsReturned: parsedItems.length,
        isIncomplete,
        topSuggestions,
        allSuggestions: parsedItems,
        byKind,
        summary: Object.keys(byKind).map((kind) => ({
          kind,
          count: byKind[kind].length,
        })),
      };
    } catch (error) {
      const err = error as Error;
      return {
        success: false,
        error: err.message,
        filePath,
        position: { line, character },
      };
    }
  },
};

export default getCodeCompletionTool;
