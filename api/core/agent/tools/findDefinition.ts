/**
 * Find Definition Tool
 * Uses LSP to find where a symbol is defined (go to definition)
 */

import { coreLsp } from "../../library/lsp/coreLsp";
import fs from "fs/promises";

type LocationRange = {
  start: { line: number; character: number };
  end: { line: number; character: number };
};

type LspDefinitionLocation = {
  uri?: string;
  targetUri?: string;
  range?: LocationRange;
  targetRange?: LocationRange;
};

type ParsedDefinitionLocation = {
  filePath: string;
  line: number;
  character: number;
  endLine: number;
  endCharacter: number;
  range: LocationRange;
};

type FindDefinitionParams = {
  filePath: string;
  line: number;
  character: number;
};

type FindDefinitionResult =
  | {
      success: true;
      sourceFile: string;
      sourcePosition: { line: number; character: number };
      definitions: ParsedDefinitionLocation[];
      primaryDefinition: ParsedDefinitionLocation;
      context: string | null;
      count: number;
    }
  | {
      success: false;
      message?: string;
      error?: string;
      filePath: string;
      position: { line: number; character: number };
    };

const findDefinitionTool = {
  name: "findDefinition",
  description: `Find the definition location of a symbol at a specific position.
Goes to where a function, class, variable, or import is defined.
Returns file path, line, and character of the definition.

Use this when you need to:
- Navigate to function/class definition
- Find where a variable is declared
- Trace imports to their source
- Understand symbol origins`,

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
    },
    required: ["filePath", "line", "character"],
  },

  async execute({
    filePath,
    line,
    character,
  }: FindDefinitionParams): Promise<FindDefinitionResult> {
    try {
      // Verify file exists
      await fs.access(filePath);

      // Get definition from LSP
      const definitions = await coreLsp.getDefinition(
        filePath,
        line,
        character,
      );

      if (
        !definitions ||
        (Array.isArray(definitions) && definitions.length === 0)
      ) {
        return {
          success: false,
          message: `No definition found for symbol at ${filePath}:${line}:${character}`,
          filePath,
          position: { line, character },
        };
      }

      // Handle both single location and array of locations
      const locations = (Array.isArray(definitions)
        ? definitions
        : [definitions]) as LspDefinitionLocation[];

      // Parse locations
      const parsedLocations = locations.map((loc): ParsedDefinitionLocation => {
        const uri = loc.uri || loc.targetUri;
        const range = loc.range || loc.targetRange;

        if (!uri || !range) {
          throw new Error("Definition location is missing uri or range");
        }

        // Convert file:// URI to path
        const definitionPath = uri.replace("file://", "");

        return {
          filePath: definitionPath,
          line: range.start.line + 1, // Convert to 1-based
          character: range.start.character + 1,
          endLine: range.end.line + 1,
          endCharacter: range.end.character + 1,
          range,
        };
      });

      // Read context from definition location
      const primaryLocation = parsedLocations[0];
      let context = null;

      try {
        const fileContent = await fs.readFile(
          primaryLocation.filePath,
          "utf-8",
        );
        const lines = fileContent.split("\n");

        // Get 3 lines before and after for context
        const startLine = Math.max(0, primaryLocation.line - 4);
        const endLine = Math.min(lines.length, primaryLocation.line + 3);

        context = lines.slice(startLine, endLine).join("\n");
      } catch (err) {
        const error = err as Error;
        console.warn(
          "Could not read definition context:",
          error.message || String(err) || "Unknown error",
        );
      }

      return {
        success: true,
        sourceFile: filePath,
        sourcePosition: { line, character },
        definitions: parsedLocations,
        primaryDefinition: primaryLocation,
        context,
        count: parsedLocations.length,
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

export default findDefinitionTool;
