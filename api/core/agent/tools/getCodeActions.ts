/**
 * Get Code Actions Tool
 * Uses LSP to retrieve available code actions (quick fixes, refactors) for a range.
 */

import { coreLsp } from "../../library/lsp/coreLsp";
import fs from "fs/promises";

type LspWorkspaceEdit = {
  changes?: Record<string, unknown[]>;
  documentChanges?: unknown[];
};

type LspCommand = {
  title: string;
  command: string;
  arguments?: unknown[];
};

type LspCodeAction = {
  title?: string;
  kind?: string;
  diagnostics?: unknown[];
  edit?: LspWorkspaceEdit;
  command?: LspCommand;
  isPreferred?: boolean;
};

type GetCodeActionsParams = {
  filePath: string;
  startLine: number;
  startCharacter: number;
  endLine?: number;
  endCharacter?: number;
  only?: string[];
};

type ParsedCodeAction = {
  title: string;
  kind: string;
  isPreferred: boolean;
  hasEdit: boolean;
  hasCommand: boolean;
};

type GetCodeActionsResult =
  | {
      success: true;
      filePath: string;
      range: { startLine: number; startCharacter: number; endLine: number; endCharacter: number };
      count: number;
      actions: ParsedCodeAction[];
      quickFixes: ParsedCodeAction[];
      refactors: ParsedCodeAction[];
    }
  | {
      success: false;
      message?: string;
      error?: string;
      filePath: string;
    };

const getCodeActionsTool = {
  name: "getCodeActions",
  description: `Get available code actions (quick fixes, refactors, source actions) for a range in a file.
Returns actionable suggestions provided by the language server such as:
- Quick fixes for errors and warnings
- Refactoring options (extract function, rename, etc.)
- Import organization
- Code generation

Use this when you need to:
- See what quick fixes are available for a diagnostic
- Find refactoring opportunities
- Organise imports
- Apply suggested code improvements`,

  parameters: {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description: "Absolute path to the file",
      },
      startLine: {
        type: "number",
        description: "Start line number (1-based) of the selection or cursor",
      },
      startCharacter: {
        type: "number",
        description: "Start character (1-based) of the selection",
      },
      endLine: {
        type: "number",
        description: "End line number (1-based, defaults to startLine)",
      },
      endCharacter: {
        type: "number",
        description: "End character (1-based, defaults to startCharacter)",
      },
      only: {
        type: "array",
        items: { type: "string" },
        description: "Optional list of code action kinds to request e.g. [\"quickfix\", \"refactor\"]",
      },
    },
    required: ["filePath", "startLine", "startCharacter"],
  },

  async execute({
    filePath,
    startLine,
    startCharacter,
    endLine,
    endCharacter,
    only,
  }: GetCodeActionsParams): Promise<GetCodeActionsResult> {
    try {
      await fs.access(filePath);

      const resolvedEndLine = endLine ?? startLine;
      const resolvedEndCharacter = endCharacter ?? startCharacter;

      const result = (await coreLsp.getCodeActions(
        filePath,
        startLine,
        startCharacter,
        resolvedEndLine,
        resolvedEndCharacter,
        only ? { only } : {},
      )) as LspCodeAction[] | null;

      if (!result || result.length === 0) {
        return {
          success: false,
          message: `No code actions available at ${filePath}:${startLine}:${startCharacter}`,
          filePath,
        };
      }

      const parsed: ParsedCodeAction[] = result.map((action) => ({
        title: action.title ?? "Unnamed action",
        kind: action.kind ?? "unknown",
        isPreferred: action.isPreferred ?? false,
        hasEdit: !!(action.edit?.changes || action.edit?.documentChanges),
        hasCommand: !!action.command,
      }));

      return {
        success: true,
        filePath,
        range: {
          startLine,
          startCharacter,
          endLine: resolvedEndLine,
          endCharacter: resolvedEndCharacter,
        },
        count: parsed.length,
        actions: parsed,
        quickFixes: parsed.filter((a) => a.kind.startsWith("quickfix")),
        refactors: parsed.filter((a) => a.kind.startsWith("refactor")),
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

export default getCodeActionsTool;
