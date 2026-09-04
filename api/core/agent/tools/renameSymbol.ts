/**
 * Rename Symbol Tool
 * Uses LSP to rename a symbol across the whole workspace.
 */

import { coreLsp } from "../../library/lsp/coreLsp";
import fs from "fs/promises";
import { fileURLToPath } from "url";

type TextEdit = {
  range?: {
    start?: { line?: number; character?: number };
    end?: { line?: number; character?: number };
  };
  newText?: string;
};

type WorkspaceEdit = {
  changes?: Record<string, TextEdit[]>;
  documentChanges?: Array<{
    textDocument?: { uri?: string };
    edits?: TextEdit[];
  }>;
};

type RenameSymbolParams = {
  filePath: string;
  line: number;
  character: number;
  newName: string;
};

type FileChange = {
  filePath: string;
  editCount: number;
  edits: Array<{
    startLine: number;
    startCharacter: number;
    endLine: number;
    endCharacter: number;
    newText: string;
  }>;
};

type RenameSymbolResult =
  | {
      success: true;
      filePath: string;
      position: { line: number; character: number };
      newName: string;
      totalFiles: number;
      totalEdits: number;
      files: FileChange[];
    }
  | {
      success: false;
      message?: string;
      error?: string;
      filePath: string;
      position: { line: number; character: number };
    };

const renameSymbolTool = {
  name: "renameSymbol",
  description: `Rename a symbol (variable, function, class, etc.) across the entire workspace using LSP.
Safely renames all references to the symbol at the given position.

Use this when you need to:
- Rename a function, class, or variable consistently everywhere it is used
- Refactor code with confidence that all call sites are updated
- Understand the full scope of a rename before applying it`,

  parameters: {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description: "Absolute path to the file containing the symbol",
      },
      line: {
        type: "number",
        description: "Line number (1-based) of the symbol to rename",
      },
      character: {
        type: "number",
        description: "Character position (1-based) on the line",
      },
      newName: {
        type: "string",
        description: "The new name for the symbol",
      },
    },
    required: ["filePath", "line", "character", "newName"],
  },

  async execute({ filePath, line, character, newName }: RenameSymbolParams): Promise<RenameSymbolResult> {
    try {
      await fs.access(filePath);

      const result = (await coreLsp.renameSymbol(filePath, line, character, newName)) as WorkspaceEdit | null;

      if (!result) {
        return {
          success: false,
          message: `No rename result for symbol at ${filePath}:${line}:${character}`,
          filePath,
          position: { line, character },
        };
      }

      const files: FileChange[] = [];

      const processEdits = (uri: string, edits: TextEdit[]) => {
        let filePath: string;
        try {
          filePath = uri.startsWith("file://") ? fileURLToPath(uri) : uri;
        } catch {
          filePath = uri.replace("file://", "");
        }

        files.push({
          filePath,
          editCount: edits.length,
          edits: edits.map((edit) => ({
            startLine: (edit.range?.start?.line ?? 0) + 1,
            startCharacter: (edit.range?.start?.character ?? 0) + 1,
            endLine: (edit.range?.end?.line ?? 0) + 1,
            endCharacter: (edit.range?.end?.character ?? 0) + 1,
            newText: edit.newText ?? newName,
          })),
        });
      };

      if (result.changes) {
        for (const [uri, edits] of Object.entries(result.changes)) {
          processEdits(uri, edits);
        }
      } else if (result.documentChanges) {
        for (const change of result.documentChanges) {
          if (change.textDocument?.uri) {
            processEdits(change.textDocument.uri, change.edits ?? []);
          }
        }
      }

      const totalEdits = files.reduce((sum, f) => sum + f.editCount, 0);

      return {
        success: true,
        filePath,
        position: { line, character },
        newName,
        totalFiles: files.length,
        totalEdits,
        files,
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

export default renameSymbolTool;
