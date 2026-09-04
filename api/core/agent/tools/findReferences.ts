/**
 * Find References Tool
 * Uses LSP to find all references to a symbol in the workspace
 */

import { coreLsp } from "../../library/lsp/coreLsp";
import fs from "fs/promises";

type LocationRange = {
  start: { line: number; character: number };
  end: { line: number; character: number };
};

type LspReference = {
  uri: string;
  range: LocationRange;
};

type ReferenceLocation = {
  line: number;
  character: number;
  endLine: number;
  endCharacter: number;
  range: LocationRange;
  context?: string;
};

type ReferenceFileGroup = {
  filePath: string;
  references: ReferenceLocation[];
  count: number;
  error?: string;
};

type FindReferencesParams = {
  filePath: string;
  line: number;
  character: number;
  includeDeclaration?: boolean;
};

type FindReferencesResult =
  | {
      success: true;
      sourceFile: string;
      sourcePosition: { line: number; character: number };
      totalReferences: number;
      totalFiles: number;
      files: ReferenceFileGroup[];
      hasMore: boolean;
      allFiles: string[];
    }
  | {
      success: false;
      message?: string;
      error?: string;
      filePath: string;
      position: { line: number; character: number };
      count?: number;
    };

const findReferencesTool = {
  name: "findReferences",
  description: `Find all references to a symbol in the workspace.
Shows everywhere a function, class, variable, or type is used.
Useful for impact analysis before refactoring.

Use this when you need to:
- See all usages of a function/class
- Understand impact of changes
- Find where a symbol is called
- Prepare for safe refactoring`,

  parameters: {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description: "Absolute path to the file containing the symbol",
      },
      line: {
        type: "number",
        description: "Line number (1-based) where the symbol is located",
      },
      character: {
        type: "number",
        description: "Character position (1-based) within the line",
      },
      includeDeclaration: {
        type: "boolean",
        description:
          "Whether to include the declaration in results (default: true)",
        default: true,
      },
    },
    required: ["filePath", "line", "character"],
  },

  async execute({
    filePath,
    line,
    character,
    includeDeclaration = true,
  }: FindReferencesParams): Promise<FindReferencesResult> {
    try {
      // Verify file exists
      await fs.access(filePath);

      // Get references from LSP
      const referencesResult = await coreLsp.getReferences(
        filePath,
        line,
        character,
        includeDeclaration,
      );
      const references = referencesResult as LspReference[] | null;

      if (!references || references.length === 0) {
        return {
          success: false,
          message: `No references found for symbol at ${filePath}:${line}:${character}`,
          filePath,
          position: { line, character },
          count: 0,
        };
      }

      // Group references by file
      const referencesByFile = new Map<string, ReferenceLocation[]>();

      for (const ref of references) {
        const uri = ref.uri;
        const range = ref.range;

        if (!uri || !range?.start || !range?.end) {
          continue;
        }

        // Convert file:// URI to path
        const refPath = uri.replace("file://", "");

        if (!referencesByFile.has(refPath)) {
          referencesByFile.set(refPath, []);
        }

        referencesByFile.get(refPath)!.push({
          line: range.start.line + 1, // Convert to 1-based
          character: range.start.character + 1,
          endLine: range.end.line + 1,
          endCharacter: range.end.character + 1,
          range,
        });
      }

      // Read context for each reference (limit to first 5 files to avoid huge responses)
      const filesWithContext = [];
      const fileEntries = Array.from(referencesByFile.entries()).slice(0, 5);

      for (const [refPath, locations] of fileEntries) {
        try {
          const fileContent = await fs.readFile(refPath, "utf-8");
          const lines = fileContent.split("\n");

          const locationsWithContext = locations.map((loc) => {
            // Get context line
            const contextLine = lines[loc.line - 1] || "";

            return {
              ...loc,
              context: contextLine.trim(),
            };
          });

          filesWithContext.push({
            filePath: refPath,
            references: locationsWithContext,
            count: locationsWithContext.length,
          });
        } catch (err) {
            const error = err as Error;
          console.warn(
            "Could not read reference context:",
              error.message || String(err) || "Unknown error",
          );
          filesWithContext.push({
            filePath: refPath,
            references: locations,
            count: locations.length,
            error: "Could not read file",
          });
        }
      }

      // Summary statistics
      const totalFiles = referencesByFile.size;
      const totalReferences = references.length;

      return {
        success: true,
        sourceFile: filePath,
        sourcePosition: { line, character },
        totalReferences,
        totalFiles,
        files: filesWithContext,
        hasMore: totalFiles > 5,
        allFiles: Array.from(referencesByFile.keys()),
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

export default findReferencesTool;
