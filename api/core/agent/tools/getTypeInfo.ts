/**
 * Get Type Information Tool
 * Uses LSP to retrieve type information for a symbol at a specific position
 */

import { coreLsp } from "../../library/lsp/coreLsp";
import fs from "fs/promises";

type HoverRange = {
  start: { line: number; character: number };
  end: { line: number; character: number };
};

type MarkupContent = {
  value?: string;
};

type HoverInfo = {
  contents: string | MarkupContent | Array<string | MarkupContent>;
  range?: HoverRange;
};

type GetTypeInfoParams = {
  filePath: string;
  line: number;
  character: number;
};

type GetTypeInfoResult =
  | {
      success: true;
      filePath: string;
      position: { line: number; character: number };
      range?: HoverRange;
      typeInfo: string;
      raw: HoverInfo;
    }
  | {
      success: false;
      message?: string;
      error?: string;
      filePath: string;
      position: { line: number; character: number };
    };

const getTypeInfoTool = {
  name: "getTypeInfo",
  description: `Get type information and documentation for a symbol at a specific position in a file.
Returns hover information including type definitions, function signatures, and documentation.
Requires line and character position (1-based indexing).

Use this when you need to:
- Understand what type a variable has
- See function signatures and parameters
- Read inline documentation
- Understand API contracts`,

  parameters: {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description: "Absolute path to the file",
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
  }: GetTypeInfoParams): Promise<GetTypeInfoResult> {
    try {
      // Verify file exists
      await fs.access(filePath);

      // Get hover information from LSP
      const hoverInfo = (await coreLsp.getHover(
        filePath,
        line,
        character
      )) as HoverInfo | null;

      if (!hoverInfo || !hoverInfo.contents) {
        return {
          success: false,
          message: `No type information available at ${filePath}:${line}:${character}`,
          filePath,
          position: { line, character },
        };
      }

      // Extract content (can be string or MarkupContent)
      let content = "";
      if (typeof hoverInfo.contents === "string") {
        content = hoverInfo.contents;
      } else if (
        !Array.isArray(hoverInfo.contents) &&
        hoverInfo.contents.value
      ) {
        content = hoverInfo.contents.value;
      } else if (Array.isArray(hoverInfo.contents)) {
        content = hoverInfo.contents
          .map((c) => (typeof c === "string" ? c : c.value || ""))
          .join("\n\n");
      }

      return {
        success: true,
        filePath,
        position: { line, character },
        range: hoverInfo.range,
        typeInfo: content,
        raw: hoverInfo,
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

export default getTypeInfoTool;
