import path from "path";
import type { NextFunction, Request, Response, Router } from "express";
import { coreLsp } from "../core/library/lsp/coreLsp";

type LspDocumentRequestBody = {
  filePath?: string;
  workspaceRoot?: string;
  text?: string;
};

type AuthMiddleware = (req: Request, res: Response, next: NextFunction) => void;

const resolveAbsolutePath = (workspacePath: string, filePath: string): string =>
  path.isAbsolute(filePath) ? filePath : path.join(workspacePath, filePath);

export const registerLspDocumentRoutes = (
  router: Router,
  requireDesktopAuth: AuthMiddleware,
): void => {
  router.post(
    "/lsp/document/open",
    requireDesktopAuth,
    async (req: Request<{}, {}, LspDocumentRequestBody>, res: Response) => {
      try {
        const { filePath, workspaceRoot, text } = req.body;

        if (typeof filePath !== "string" || filePath.trim().length === 0) {
          return res.status(400).json({ success: false, error: "filePath is required" });
        }

        const workspacePath = workspaceRoot || process.cwd();
        const absolutePath = resolveAbsolutePath(workspacePath, filePath);

        coreLsp.setRootPath(workspacePath);
        const opened = await coreLsp.openDocument(
          absolutePath,
          typeof text === "string" ? text : undefined,
        );

        return res.json({ success: opened });
      } catch (error) {
        const err = error as Error;
        return res
          .status(500)
          .json({ success: false, error: err.message || "Failed to open LSP document" });
      }
    },
  );

  router.post(
    "/lsp/document/change",
    requireDesktopAuth,
    async (req: Request<{}, {}, LspDocumentRequestBody>, res: Response) => {
      try {
        const { filePath, workspaceRoot, text } = req.body;

        if (typeof filePath !== "string" || filePath.trim().length === 0) {
          return res.status(400).json({ success: false, error: "filePath is required" });
        }

        if (typeof text !== "string") {
          return res.status(400).json({ success: false, error: "text is required" });
        }

        const workspacePath = workspaceRoot || process.cwd();
        const absolutePath = resolveAbsolutePath(workspacePath, filePath);

        coreLsp.setRootPath(workspacePath);
        const changed = await coreLsp.changeDocument(absolutePath, text);

        return res.json({ success: changed });
      } catch (error) {
        const err = error as Error;
        return res
          .status(500)
          .json({ success: false, error: err.message || "Failed to change LSP document" });
      }
    },
  );

  router.post(
    "/lsp/document/save",
    requireDesktopAuth,
    async (req: Request<{}, {}, LspDocumentRequestBody>, res: Response) => {
      try {
        const { filePath, workspaceRoot } = req.body;

        if (typeof filePath !== "string" || filePath.trim().length === 0) {
          return res.status(400).json({ success: false, error: "filePath is required" });
        }

        const workspacePath = workspaceRoot || process.cwd();
        const absolutePath = resolveAbsolutePath(workspacePath, filePath);

        coreLsp.setRootPath(workspacePath);
        const saved = await coreLsp.saveDocument(absolutePath);

        return res.json({ success: saved });
      } catch (error) {
        const err = error as Error;
        return res
          .status(500)
          .json({ success: false, error: err.message || "Failed to save LSP document" });
      }
    },
  );

  router.post(
    "/lsp/document/close",
    requireDesktopAuth,
    async (req: Request<{}, {}, LspDocumentRequestBody>, res: Response) => {
      try {
        const { filePath, workspaceRoot } = req.body;

        if (typeof filePath !== "string" || filePath.trim().length === 0) {
          return res.status(400).json({ success: false, error: "filePath is required" });
        }

        const workspacePath = workspaceRoot || process.cwd();
        const absolutePath = resolveAbsolutePath(workspacePath, filePath);

        coreLsp.setRootPath(workspacePath);
        const closed = await coreLsp.closeDocument(absolutePath);

        return res.json({ success: closed });
      } catch (error) {
        const err = error as Error;
        return res
          .status(500)
          .json({ success: false, error: err.message || "Failed to close LSP document" });
      }
    },
  );
};
