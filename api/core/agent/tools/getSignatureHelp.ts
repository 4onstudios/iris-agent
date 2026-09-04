/**
 * Get Signature Help Tool
 * Uses LSP to provide parameter hints when calling functions or methods.
 */

import { coreLsp } from "../../library/lsp/coreLsp";
import fs from "fs/promises";

type SignatureParameter = {
  label: string | [number, number];
  documentation?: string | { value?: string };
};

type SignatureInfo = {
  label: string;
  documentation?: string | { value?: string };
  parameters?: SignatureParameter[];
};

type SignatureHelpResult = {
  signatures?: SignatureInfo[];
  activeSignature?: number;
  activeParameter?: number;
};

type GetSignatureHelpParams = {
  filePath: string;
  line: number;
  character: number;
};

type GetSignatureHelpResult =
  | {
      success: true;
      filePath: string;
      position: { line: number; character: number };
      activeSignature: number;
      activeParameter: number;
      signatures: Array<{
        label: string;
        documentation: string;
        parameters: Array<{ label: string; documentation: string }>;
      }>;
      activeSignatureLabel: string;
    }
  | {
      success: false;
      message?: string;
      error?: string;
      filePath: string;
      position: { line: number; character: number };
    };

const getSignatureHelpTool = {
  name: "getSignatureHelp",
  description: `Get function/method signature help and parameter hints at a specific position.
Shows available overloads, parameter names, types, and documentation while typing a function call.

Use this when you need to:
- See what parameters a function accepts
- Understand parameter order and types
- Get documentation for a specific parameter
- Check all available overloads for a method`,

  parameters: {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description: "Absolute path to the file",
      },
      line: {
        type: "number",
        description: "Line number (1-based) inside a function call",
      },
      character: {
        type: "number",
        description: "Character position (1-based) inside the argument list",
      },
    },
    required: ["filePath", "line", "character"],
  },

  async execute({ filePath, line, character }: GetSignatureHelpParams): Promise<GetSignatureHelpResult> {
    try {
      await fs.access(filePath);

      const result = (await coreLsp.getSignatureHelp(filePath, line, character)) as SignatureHelpResult | null;

      if (!result || !result.signatures || result.signatures.length === 0) {
        return {
          success: false,
          message: `No signature help available at ${filePath}:${line}:${character}`,
          filePath,
          position: { line, character },
        };
      }

      const extractDoc = (doc?: string | { value?: string }): string => {
        if (!doc) return "";
        if (typeof doc === "string") return doc;
        return doc.value || "";
      };

      const signatures = result.signatures.map((sig) => ({
        label: sig.label,
        documentation: extractDoc(sig.documentation),
        parameters: (sig.parameters || []).map((param) => ({
          label: typeof param.label === "string" ? param.label : sig.label.slice(param.label[0], param.label[1]),
          documentation: extractDoc(param.documentation),
        })),
      }));

      const activeIndex = result.activeSignature ?? 0;
      const activeSig = signatures[activeIndex] ?? signatures[0];

      return {
        success: true,
        filePath,
        position: { line, character },
        activeSignature: activeIndex,
        activeParameter: result.activeParameter ?? 0,
        signatures,
        activeSignatureLabel: activeSig?.label ?? "",
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

export default getSignatureHelpTool;
