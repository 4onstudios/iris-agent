import path from "path";
import type { NextFunction, Request, Response, Router } from "express";
import { coreLsp } from "../core/library/lsp/coreLsp";

type LspPositionRequestBody = {
  filePath?: string;
  workspaceRoot?: string;
  line?: number;
  character?: number;
};

type LspHierarchyItemRequestBody = {
  workspaceRoot?: string;
  item?: Record<string, unknown>;
};

type AuthMiddleware = (req: Request, res: Response, next: NextFunction) => void;

const resolveAbsolutePath = (workspacePath: string, filePath: string): string =>
  path.isAbsolute(filePath) ? filePath : path.join(workspacePath, filePath);

export const registerLspHierarchyRoutes = (
  router: Router,
  requireDesktopAuth: AuthMiddleware,
): void => {
  router.post(
    "/lsp/call-hierarchy/prepare",
    requireDesktopAuth,
    async (req: Request<{}, {}, LspPositionRequestBody>, res: Response) => {
      try {
        const { filePath, workspaceRoot, line, character } = req.body;
        if (typeof filePath !== "string" || filePath.trim().length === 0) {
          return res.status(400).json({ success: false, error: "filePath is required" });
        }
        if (typeof line !== "number" || typeof character !== "number") {
          return res.status(400).json({ success: false, error: "line and character are required" });
        }

        const workspacePath = workspaceRoot || process.cwd();
        const absolutePath = resolveAbsolutePath(workspacePath, filePath);
        coreLsp.setRootPath(workspacePath);

        const items = await coreLsp.prepareCallHierarchy(absolutePath, line, character);
        return res.json({ success: true, items: Array.isArray(items) ? items : [] });
      } catch (error) {
        const err = error as Error;
        return res
          .status(500)
          .json({ success: false, error: err.message || "Failed to prepare call hierarchy" });
      }
    },
  );

  router.post(
    "/lsp/call-hierarchy/incoming",
    requireDesktopAuth,
    async (req: Request<{}, {}, LspHierarchyItemRequestBody>, res: Response) => {
      try {
        const { workspaceRoot, item } = req.body;
        if (!item || typeof item !== "object") {
          return res.status(400).json({ success: false, error: "item is required" });
        }

        const workspacePath = workspaceRoot || process.cwd();
        coreLsp.setRootPath(workspacePath);
        const calls = await coreLsp.getIncomingCalls(item);
        return res.json({ success: true, calls: Array.isArray(calls) ? calls : [] });
      } catch (error) {
        const err = error as Error;
        return res
          .status(500)
          .json({ success: false, error: err.message || "Failed to get incoming calls" });
      }
    },
  );

  router.post(
    "/lsp/call-hierarchy/outgoing",
    requireDesktopAuth,
    async (req: Request<{}, {}, LspHierarchyItemRequestBody>, res: Response) => {
      try {
        const { workspaceRoot, item } = req.body;
        if (!item || typeof item !== "object") {
          return res.status(400).json({ success: false, error: "item is required" });
        }

        const workspacePath = workspaceRoot || process.cwd();
        coreLsp.setRootPath(workspacePath);
        const calls = await coreLsp.getOutgoingCalls(item);
        return res.json({ success: true, calls: Array.isArray(calls) ? calls : [] });
      } catch (error) {
        const err = error as Error;
        return res
          .status(500)
          .json({ success: false, error: err.message || "Failed to get outgoing calls" });
      }
    },
  );

  router.post(
    "/lsp/type-hierarchy/prepare",
    requireDesktopAuth,
    async (req: Request<{}, {}, LspPositionRequestBody>, res: Response) => {
      try {
        const { filePath, workspaceRoot, line, character } = req.body;
        if (typeof filePath !== "string" || filePath.trim().length === 0) {
          return res.status(400).json({ success: false, error: "filePath is required" });
        }
        if (typeof line !== "number" || typeof character !== "number") {
          return res.status(400).json({ success: false, error: "line and character are required" });
        }

        const workspacePath = workspaceRoot || process.cwd();
        const absolutePath = resolveAbsolutePath(workspacePath, filePath);
        coreLsp.setRootPath(workspacePath);

        const items = await coreLsp.prepareTypeHierarchy(absolutePath, line, character);
        return res.json({ success: true, items: Array.isArray(items) ? items : [] });
      } catch (error) {
        const err = error as Error;
        return res
          .status(500)
          .json({ success: false, error: err.message || "Failed to prepare type hierarchy" });
      }
    },
  );

  router.post(
    "/lsp/type-hierarchy/supertypes",
    requireDesktopAuth,
    async (req: Request<{}, {}, LspHierarchyItemRequestBody>, res: Response) => {
      try {
        const { workspaceRoot, item } = req.body;
        if (!item || typeof item !== "object") {
          return res.status(400).json({ success: false, error: "item is required" });
        }

        const workspacePath = workspaceRoot || process.cwd();
        coreLsp.setRootPath(workspacePath);
        const items = await coreLsp.getTypeHierarchySupertypes(item);
        return res.json({ success: true, items: Array.isArray(items) ? items : [] });
      } catch (error) {
        const err = error as Error;
        return res.status(500).json({
          success: false,
          error: err.message || "Failed to get type hierarchy supertypes",
        });
      }
    },
  );

  router.post(
    "/lsp/type-hierarchy/subtypes",
    requireDesktopAuth,
    async (req: Request<{}, {}, LspHierarchyItemRequestBody>, res: Response) => {
      try {
        const { workspaceRoot, item } = req.body;
        if (!item || typeof item !== "object") {
          return res.status(400).json({ success: false, error: "item is required" });
        }

        const workspacePath = workspaceRoot || process.cwd();
        coreLsp.setRootPath(workspacePath);
        const items = await coreLsp.getTypeHierarchySubtypes(item);
        return res.json({ success: true, items: Array.isArray(items) ? items : [] });
      } catch (error) {
        const err = error as Error;
        return res
          .status(500)
          .json({ success: false, error: err.message || "Failed to get type hierarchy subtypes" });
      }
    },
  );
};
