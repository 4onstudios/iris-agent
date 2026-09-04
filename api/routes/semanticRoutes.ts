import path from "path";
import type { Request, Response, Router } from "express";
import { coreLsp } from "../core/library/lsp/coreLsp";

type SemanticTokensRequestBody = {
  code?: string;
  language?: string;
  filePath?: string;
  workspaceRoot?: string;
  previousResultId?: string;
};

const LANGUAGE_ID_MAP: Record<string, string> = {
  ts: "typescript",
  tsx: "typescriptreact",
  typescript: "typescript",
  typescriptreact: "typescriptreact",
  js: "javascript",
  jsx: "javascriptreact",
  javascript: "javascript",
  javascriptreact: "javascriptreact",
  py: "python",
  python: "python",
};

const resolveSemanticLanguageId = (language: string): string | undefined =>
  LANGUAGE_ID_MAP[language.toLowerCase()];

const resolveSemanticFilePath = ({
  filePath,
  workspacePath,
  languageId,
}: {
  filePath?: string;
  workspacePath: string;
  languageId: string;
}): string => {
  if (filePath) {
    return path.isAbsolute(filePath) ? filePath : path.join(workspacePath, filePath);
  }

  return path.join(
    workspacePath,
    `.iris-semantic-preview.${
      languageId.startsWith("typescript")
        ? "ts"
        : languageId === "python"
          ? "py"
          : "js"
    }`,
  );
};

export const registerSemanticRoutes = (router: Router): void => {
  // POST /api/agent/semantic-tokens - Get semantic tokens for supported LSP snippets
  router.post(
    "/semantic-tokens",
    async (req: Request<{}, {}, SemanticTokensRequestBody>, res: Response) => {
      try {
        const { code, language, filePath, workspaceRoot } = req.body;

        if (typeof code !== "string") {
          return res.status(400).json({ success: false, error: "Code is required" });
        }

        if (typeof language !== "string" || language.length === 0) {
          return res.status(400).json({ success: false, error: "Language is required" });
        }

        const languageId = resolveSemanticLanguageId(language);
        if (!languageId) {
          return res.status(400).json({
            success: false,
            error: `Semantic tokens are not supported for language: ${language}`,
          });
        }

        const workspacePath = workspaceRoot || process.cwd();
        const semanticFilePath = resolveSemanticFilePath({
          filePath,
          workspacePath,
          languageId,
        });

        coreLsp.setRootPath(workspacePath);
        const semanticTokens = await coreLsp.getSemanticTokensForCode(
          semanticFilePath,
          languageId,
          code,
        );

        if (!semanticTokens) {
          // Distinguish "the language server can never start here" from a
          // transient cold-start miss so the client knows not to retry.
          const unavailable = coreLsp.isLanguageUnavailable(languageId);
          return res.json({
            success: false,
            unavailable,
            error: unavailable
              ? `No language server available for ${languageId} in this workspace`
              : "No semantic tokens available",
          });
        }

        return res.json({
          success: true,
          data: semanticTokens.data,
          legend: semanticTokens.legend,
          languageId: semanticTokens.languageId,
        });
      } catch (error) {
        const err = error as Error;
        console.error("Semantic tokens error:", error);
        return res.status(500).json({
          success: false,
          error: err.message || "Failed to fetch semantic tokens",
        });
      }
    },
  );

  // POST /api/agent/semantic-tokens-delta - Get semantic token deltas for supported LSP snippets
  router.post(
    "/semantic-tokens-delta",
    async (req: Request<{}, {}, SemanticTokensRequestBody>, res: Response) => {
      try {
        const { code, language, filePath, workspaceRoot, previousResultId } = req.body;

        if (typeof code !== "string") {
          return res.status(400).json({ success: false, error: "Code is required" });
        }

        if (typeof language !== "string" || language.length === 0) {
          return res.status(400).json({ success: false, error: "Language is required" });
        }

        const languageId = resolveSemanticLanguageId(language);
        if (!languageId) {
          return res.status(400).json({
            success: false,
            error: `Semantic tokens are not supported for language: ${language}`,
          });
        }

        const workspacePath = workspaceRoot || process.cwd();
        const semanticFilePath = resolveSemanticFilePath({
          filePath,
          workspacePath,
          languageId,
        });

        coreLsp.setRootPath(workspacePath);
        const semanticTokens = await coreLsp.getSemanticTokensDelta(
          semanticFilePath,
          languageId,
          code,
          typeof previousResultId === "string" ? previousResultId : undefined,
        );

        if (!semanticTokens) {
          return res.json({ success: false, error: "No semantic tokens available" });
        }

        return res.json({
          success: true,
          data: semanticTokens.data,
          edits: semanticTokens.edits,
          resultId: semanticTokens.resultId,
          legend: semanticTokens.legend,
          languageId: semanticTokens.languageId,
        });
      } catch (error) {
        const err = error as Error;
        console.error("Semantic tokens delta error:", error);
        return res.status(500).json({
          success: false,
          error: err.message || "Failed to fetch semantic token delta",
        });
      }
    },
  );
};
