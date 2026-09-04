/**
 * Format Document Tool
 * Uses LSP to format an entire file according to language server formatting rules.
 */

import { coreLsp } from "../../library/lsp/coreLsp";
import fs from "fs/promises";

type TextEdit = {
  range?: {
    start?: { line?: number; character?: number };
    end?: { line?: number; character?: number };
  };
  newText?: string;
};

type FormatDocumentParams = {
  filePath: string;
  tabSize?: number;
  insertSpaces?: boolean;
  trimTrailingWhitespace?: boolean;
  insertFinalNewline?: boolean;
  trimFinalNewlines?: boolean;
};

type FormattingEdit = {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
  newText: string;
};

type FormatDocumentResult =
  | {
      success: true;
      filePath: string;
      editCount: number;
      edits: FormattingEdit[];
      summary: string;
    }
  | {
      success: false;
      message?: string;
      error?: string;
      filePath: string;
    };

const formatDocumentTool = {
  name: "formatDocument",
  description: `Format an entire file using the language server's formatting provider.
Applies consistent formatting rules such as indentation, spacing, and line endings.

Use this when you need to:
- Clean up code formatting after edits
- Ensure a file follows project style conventions
- Normalise whitespace, indentation, or brace placement`,

  parameters: {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description: "Absolute path to the file to format",
      },
      tabSize: {
        type: "number",
        description: "Number of spaces per indentation level (default: 2)",
      },
      insertSpaces: {
        type: "boolean",
        description: "Use spaces instead of tabs (default: true)",
      },
      trimTrailingWhitespace: {
        type: "boolean",
        description: "Remove trailing whitespace from each line (default: true)",
      },
      insertFinalNewline: {
        type: "boolean",
        description: "Ensure file ends with a newline (default: true)",
      },
      trimFinalNewlines: {
        type: "boolean",
        description: "Remove extra blank lines at end of file (default: true)",
      },
    },
    required: ["filePath"],
  },

  async execute({
    filePath,
    tabSize = 2,
    insertSpaces = true,
    trimTrailingWhitespace = true,
    insertFinalNewline = true,
    trimFinalNewlines = true,
  }: FormatDocumentParams): Promise<FormatDocumentResult> {
    try {
      await fs.access(filePath);

      const result = (await coreLsp.formatDocument(filePath, {
        tabSize,
        insertSpaces,
        trimTrailingWhitespace,
        insertFinalNewline,
        trimFinalNewlines,
      })) as TextEdit[] | null;

      if (!result || result.length === 0) {
        return {
          success: true,
          filePath,
          editCount: 0,
          edits: [],
          summary: "No formatting changes required",
        };
      }

      const edits: FormattingEdit[] = result.map((edit) => ({
        startLine: (edit.range?.start?.line ?? 0) + 1,
        startCharacter: (edit.range?.start?.character ?? 0) + 1,
        endLine: (edit.range?.end?.line ?? 0) + 1,
        endCharacter: (edit.range?.end?.character ?? 0) + 1,
        newText: edit.newText ?? "",
      }));

      return {
        success: true,
        filePath,
        editCount: edits.length,
        edits,
        summary: `${edits.length} formatting edit${edits.length === 1 ? "" : "s"} produced`,
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

export default formatDocumentTool;
