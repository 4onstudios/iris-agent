import path from "path";
import type { NextFunction, Request, Response, Router } from "express";
import { coreLsp } from "../core/library/lsp/coreLsp";

type LspRangeRequestBody = {
  filePath?: string;
  workspaceRoot?: string;
  startLine?: number;
  startCharacter?: number;
  endLine?: number;
  endCharacter?: number;
};

type LspSemanticTokensFullRequestBody = {
  filePath?: string;
  workspaceRoot?: string;
  previousResultId?: string;
};

type AuthMiddleware = (req: Request, res: Response, next: NextFunction) => void;

const resolveAbsolutePath = (workspacePath: string, filePath: string): string =>
  path.isAbsolute(filePath) ? filePath : path.join(workspacePath, filePath);

export const registerLspSemanticDocumentRoutes = (
  router: Router,
  requireDesktopAuth: AuthMiddleware,
): void => {
  router.post(
    "/lsp/semantic-tokens-range",
    requireDesktopAuth,
    async (req: Request<{}, {}, LspRangeRequestBody>, res: Response) => {
      try {
        const {
          filePath,
          workspaceRoot,
          startLine,
          startCharacter,
          endLine,
          endCharacter,
        } = req.body;
        if (typeof filePath !== "string" || filePath.trim().length === 0) {
          return res.status(400).json({ success: false, error: "filePath is required" });
        }
        if (
          typeof startLine !== "number" ||
          typeof startCharacter !== "number" ||
          typeof endLine !== "number" ||
          typeof endCharacter !== "number"
        ) {
          return res.status(400).json({
            success: false,
            error: "startLine, startCharacter, endLine, and endCharacter are required",
          });
        }

        const workspacePath = workspaceRoot || process.cwd();
        const absolutePath = resolveAbsolutePath(workspacePath, filePath);
        coreLsp.setRootPath(workspacePath);

        const semanticTokens = await coreLsp.getSemanticTokensRange(
          absolutePath,
          startLine,
          startCharacter,
          endLine,
          endCharacter,
        );

        if (!semanticTokens) {
          return res.json({ success: false, error: "No semantic tokens available" });
        }

        return res.json({
          success: true,
          data: semanticTokens.data,
          legend: semanticTokens.legend,
          languageId: semanticTokens.languageId,
        });
      } catch (error) {
        const err = error as Error;
        return res
          .status(500)
          .json({ success: false, error: err.message || "Failed to get semantic tokens" });
      }
    },
  );

  router.post(
    "/lsp/semantic-tokens-full",
    requireDesktopAuth,
    async (req: Request<{}, {}, LspSemanticTokensFullRequestBody>, res: Response) => {
      try {
        const { filePath, workspaceRoot } = req.body;
        if (typeof filePath !== "string" || filePath.trim().length === 0) {
          return res.status(400).json({ success: false, error: "filePath is required" });
        }

        const workspacePath = workspaceRoot || process.cwd();
        const absolutePath = resolveAbsolutePath(workspacePath, filePath);
        coreLsp.setRootPath(workspacePath);

        const semanticTokens = await coreLsp.getSemanticTokensFull(absolutePath);

        if (!semanticTokens) {
          return res.json({ success: false, error: "No semantic tokens available" });
        }

        return res.json({
          success: true,
          data: semanticTokens.data,
          resultId: semanticTokens.resultId,
          legend: semanticTokens.legend,
          languageId: semanticTokens.languageId,
        });
      } catch (error) {
        const err = error as Error;
        return res
          .status(500)
          .json({ success: false, error: err.message || "Failed to get semantic tokens" });
      }
    },
  );

  router.post(
    "/lsp/semantic-tokens-delta",
    requireDesktopAuth,
    async (req: Request<{}, {}, LspSemanticTokensFullRequestBody>, res: Response) => {
      try {
        const { filePath, workspaceRoot, previousResultId } = req.body;
        if (typeof filePath !== "string" || filePath.trim().length === 0) {
          return res.status(400).json({ success: false, error: "filePath is required" });
        }

        const workspacePath = workspaceRoot || process.cwd();
        const absolutePath = resolveAbsolutePath(workspacePath, filePath);
        coreLsp.setRootPath(workspacePath);

        const semanticTokens = await coreLsp.getSemanticTokensDocumentDelta(
          absolutePath,
          typeof previousResultId === "string" ? previousResultId : undefined,
        );

        if (!semanticTokens) {
          return res.json({ success: false, error: "No semantic token delta available" });
        }

        return res.json({
          success: true,
          data: semanticTokens.data,
          resultId: semanticTokens.resultId,
          edits: semanticTokens.edits,
          legend: semanticTokens.legend,
          languageId: semanticTokens.languageId,
        });
      } catch (error) {
        const err = error as Error;
        return res
          .status(500)
          .json({ success: false, error: err.message || "Failed to get semantic token delta" });
      }
    },
  );
};
