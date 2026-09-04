import path from "path";
import type { NextFunction, Request, Response, Router } from "express";
import { coreLsp } from "../core/library/lsp/coreLsp";

type LspResolveRequestBody = {
  workspaceRoot?: string;
  languageId?: string;
  filePath?: string;
  item?: Record<string, unknown>;
};

type AuthMiddleware = (req: Request, res: Response, next: NextFunction) => void;

const resolveAbsolutePath = (workspacePath: string, filePath?: string): string | undefined => {
  if (typeof filePath !== "string" || filePath.length === 0) {
    return undefined;
  }

  return path.isAbsolute(filePath) ? filePath : path.join(workspacePath, filePath);
};

export const registerLspResolveRoutes = (
  router: Router,
  requireDesktopAuth: AuthMiddleware,
): void => {
  router.post(
    "/lsp/completion/resolve",
    requireDesktopAuth,
    async (req: Request<{}, {}, LspResolveRequestBody>, res: Response) => {
      try {
        const { workspaceRoot, languageId, filePath, item } = req.body;
        if (!item || typeof item !== "object") {
          return res.status(400).json({ success: false, error: "item is required" });
        }

        const workspacePath = workspaceRoot || process.cwd();
        coreLsp.setRootPath(workspacePath);
        const absolutePath = resolveAbsolutePath(workspacePath, filePath);

        const resolved = await coreLsp.resolveCompletionItem(
          item,
          typeof languageId === "string" ? languageId : undefined,
          absolutePath,
        );
        return res.json({ success: true, item: resolved });
      } catch (error) {
        const err = error as Error;
        return res
          .status(500)
          .json({ success: false, error: err.message || "Failed to resolve completion item" });
      }
    },
  );

  router.post(
    "/lsp/code-action/resolve",
    requireDesktopAuth,
    async (req: Request<{}, {}, LspResolveRequestBody>, res: Response) => {
      try {
        const { workspaceRoot, languageId, filePath, item } = req.body;
        if (!item || typeof item !== "object") {
          return res.status(400).json({ success: false, error: "item is required" });
        }

        const workspacePath = workspaceRoot || process.cwd();
        coreLsp.setRootPath(workspacePath);
        const absolutePath = resolveAbsolutePath(workspacePath, filePath);

        const resolved = await coreLsp.resolveCodeAction(
          item,
          typeof languageId === "string" ? languageId : undefined,
          absolutePath,
        );
        return res.json({ success: true, item: resolved });
      } catch (error) {
        const err = error as Error;
        return res
          .status(500)
          .json({ success: false, error: err.message || "Failed to resolve code action" });
      }
    },
  );

  router.post(
    "/lsp/code-lens/resolve",
    requireDesktopAuth,
    async (req: Request<{}, {}, LspResolveRequestBody>, res: Response) => {
      try {
        const { workspaceRoot, languageId, filePath, item } = req.body;
        if (!item || typeof item !== "object") {
          return res.status(400).json({ success: false, error: "item is required" });
        }

        const workspacePath = workspaceRoot || process.cwd();
        coreLsp.setRootPath(workspacePath);
        const absolutePath = resolveAbsolutePath(workspacePath, filePath);

        const resolved = await coreLsp.resolveCodeLens(
          item,
          typeof languageId === "string" ? languageId : undefined,
          absolutePath,
        );
        return res.json({ success: true, item: resolved });
      } catch (error) {
        const err = error as Error;
        return res
          .status(500)
          .json({ success: false, error: err.message || "Failed to resolve code lens" });
      }
    },
  );

  router.post(
    "/lsp/document-link/resolve",
    requireDesktopAuth,
    async (req: Request<{}, {}, LspResolveRequestBody>, res: Response) => {
      try {
        const { workspaceRoot, languageId, filePath, item } = req.body;
        if (!item || typeof item !== "object") {
          return res.status(400).json({ success: false, error: "item is required" });
        }

        const workspacePath = workspaceRoot || process.cwd();
        coreLsp.setRootPath(workspacePath);
        const absolutePath = resolveAbsolutePath(workspacePath, filePath);

        const resolved = await coreLsp.resolveDocumentLink(
          item,
          typeof languageId === "string" ? languageId : undefined,
          absolutePath,
        );
        return res.json({ success: true, item: resolved });
      } catch (error) {
        const err = error as Error;
        return res
          .status(500)
          .json({ success: false, error: err.message || "Failed to resolve document link" });
      }
    },
  );

  router.post(
    "/lsp/workspace-symbol/resolve",
    requireDesktopAuth,
    async (req: Request<{}, {}, LspResolveRequestBody>, res: Response) => {
      try {
        const { workspaceRoot, languageId, item } = req.body;
        if (!item || typeof item !== "object") {
          return res.status(400).json({ success: false, error: "item is required" });
        }

        const workspacePath = workspaceRoot || process.cwd();
        coreLsp.setRootPath(workspacePath);

        const resolved = await coreLsp.resolveWorkspaceSymbol(
          item,
          typeof languageId === "string" ? languageId : undefined,
        );
        return res.json({ success: true, item: resolved });
      } catch (error) {
        const err = error as Error;
        return res
          .status(500)
          .json({ success: false, error: err.message || "Failed to resolve workspace symbol" });
      }
    },
  );

  router.post(
    "/lsp/inlay-hint/resolve",
    requireDesktopAuth,
    async (req: Request<{}, {}, LspResolveRequestBody>, res: Response) => {
      try {
        const { workspaceRoot, languageId, filePath, item } = req.body;
        if (!item || typeof item !== "object") {
          return res.status(400).json({ success: false, error: "item is required" });
        }

        const workspacePath = workspaceRoot || process.cwd();
        coreLsp.setRootPath(workspacePath);
        const absolutePath = resolveAbsolutePath(workspacePath, filePath);

        const resolved = await coreLsp.resolveInlayHint(
          item,
          typeof languageId === "string" ? languageId : undefined,
          absolutePath,
        );
        return res.json({ success: true, item: resolved });
      } catch (error) {
        const err = error as Error;
        return res
          .status(500)
          .json({ success: false, error: err.message || "Failed to resolve inlay hint" });
      }
    },
  );

  router.post(
    "/lsp/inline-completion/resolve",
    requireDesktopAuth,
    async (req: Request<{}, {}, LspResolveRequestBody>, res: Response) => {
      try {
        const { workspaceRoot, languageId, filePath, item } = req.body;
        if (!item || typeof item !== "object") {
          return res.status(400).json({ success: false, error: "item is required" });
        }

        const workspacePath = workspaceRoot || process.cwd();
        coreLsp.setRootPath(workspacePath);
        const absolutePath = resolveAbsolutePath(workspacePath, filePath);

        const resolved = await coreLsp.resolveInlineCompletionItem(
          item,
          typeof languageId === "string" ? languageId : undefined,
          absolutePath,
        );
        return res.json({ success: true, item: resolved });
      } catch (error) {
        const err = error as Error;
        return res.status(500).json({
          success: false,
          error: err.message || "Failed to resolve inline completion item",
        });
      }
    },
  );
};
