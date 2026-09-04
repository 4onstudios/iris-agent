import path from "path";
import type { NextFunction, Request, Response, Router } from "express";
import { coreLsp } from "../core/library/lsp/coreLsp";

type LspPositionRequestBody = {
  filePath?: string;
  workspaceRoot?: string;
  line?: number;
  character?: number;
  text?: string;
};

type LspRawLocation = {
  uri?: string;
  targetUri?: string;
  range?: { start?: { line?: number; character?: number } };
  targetRange?: { start?: { line?: number; character?: number } };
};

type LspReferenceLocation = {
  uri?: string;
  range?: { start?: { line?: number; character?: number } };
};

type AuthMiddleware = (req: Request, res: Response, next: NextFunction) => void;

const resolveAbsolutePath = (workspacePath: string, filePath: string): string =>
  path.isAbsolute(filePath) ? filePath : path.join(workspacePath, filePath);

const normalizeLocationResults = (raw: unknown) => {
  const rawLocations = (Array.isArray(raw) ? raw : raw ? [raw] : []) as LspRawLocation[];
  return rawLocations.map((loc) => {
    const uri = loc.uri || loc.targetUri || "";
    const range = loc.range || loc.targetRange;
    return {
      filePath: uri.replace("file://", ""),
      uri,
      line: (range?.start?.line ?? 0) + 1,
      character: (range?.start?.character ?? 0) + 1,
    };
  });
};

export const registerLspPositionRoutes = (
  router: Router,
  requireDesktopAuth: AuthMiddleware,
): void => {
  router.post(
    "/lsp/hover",
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
        const result = await coreLsp.getHover(absolutePath, line, character);
        return res.json({ success: true, hover: result });
      } catch (error) {
        const err = error as Error;
        return res.status(500).json({ success: false, error: err.message || "Failed to get hover" });
      }
    },
  );

  router.post(
    "/lsp/definition",
    requireDesktopAuth,
    async (req: Request<{}, {}, LspPositionRequestBody>, res: Response) => {
      try {
        const { filePath, workspaceRoot, line, character, text } = req.body;
        if (typeof filePath !== "string" || filePath.trim().length === 0) {
          return res.status(400).json({ success: false, error: "filePath is required" });
        }
        if (typeof line !== "number" || typeof character !== "number") {
          return res.status(400).json({ success: false, error: "line and character are required" });
        }

        const workspacePath = workspaceRoot || process.cwd();
        const absolutePath = resolveAbsolutePath(workspacePath, filePath);
        coreLsp.setRootPath(workspacePath);
        const raw = await coreLsp.getDefinition(absolutePath, line, character, text);
        const locations = normalizeLocationResults(raw);

        return res.json({ success: true, locations });
      } catch (error) {
        const err = error as Error;
        return res.status(500).json({ success: false, error: err.message || "Failed to get definition" });
      }
    },
  );

  router.post(
    "/lsp/declaration",
    requireDesktopAuth,
    async (req: Request<{}, {}, LspPositionRequestBody>, res: Response) => {
      try {
        const { filePath, workspaceRoot, line, character, text } = req.body;
        if (typeof filePath !== "string" || filePath.trim().length === 0) {
          return res.status(400).json({ success: false, error: "filePath is required" });
        }
        if (typeof line !== "number" || typeof character !== "number") {
          return res.status(400).json({ success: false, error: "line and character are required" });
        }

        const workspacePath = workspaceRoot || process.cwd();
        const absolutePath = resolveAbsolutePath(workspacePath, filePath);
        coreLsp.setRootPath(workspacePath);
        const raw = await coreLsp.getDeclaration(absolutePath, line, character, text);
        const locations = normalizeLocationResults(raw);

        return res.json({ success: true, locations });
      } catch (error) {
        const err = error as Error;
        return res.status(500).json({ success: false, error: err.message || "Failed to get declaration" });
      }
    },
  );

  router.post(
    "/lsp/type-definition",
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
        const raw = await coreLsp.getTypeDefinition(absolutePath, line, character);
        const locations = normalizeLocationResults(raw);

        return res.json({ success: true, locations });
      } catch (error) {
        const err = error as Error;
        return res.status(500).json({
          success: false,
          error: err.message || "Failed to get type definition",
        });
      }
    },
  );

  router.post(
    "/lsp/implementation",
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
        const raw = await coreLsp.getImplementation(absolutePath, line, character);
        const locations = normalizeLocationResults(raw);

        return res.json({ success: true, locations });
      } catch (error) {
        const err = error as Error;
        return res.status(500).json({
          success: false,
          error: err.message || "Failed to get implementation",
        });
      }
    },
  );

  router.post(
    "/lsp/references",
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
        const raw = (await coreLsp.getReferences(absolutePath, line, character)) as LspReferenceLocation[] | null;
        const references = (raw || []).map((ref) => ({
          filePath: (ref.uri || "").replace("file://", ""),
          uri: ref.uri || "",
          line: (ref.range?.start?.line ?? 0) + 1,
          character: (ref.range?.start?.character ?? 0) + 1,
        }));
        return res.json({ success: true, count: references.length, references });
      } catch (error) {
        const err = error as Error;
        return res.status(500).json({ success: false, error: err.message || "Failed to get references" });
      }
    },
  );

  router.post(
    "/lsp/document-highlight",
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
        const highlights = await coreLsp.getDocumentHighlight(absolutePath, line, character);
        return res.json({ success: true, highlights: Array.isArray(highlights) ? highlights : [] });
      } catch (error) {
        const err = error as Error;
        return res.status(500).json({
          success: false,
          error: err.message || "Failed to get document highlights",
        });
      }
    },
  );

  router.post(
    "/lsp/moniker",
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
        const monikers = await coreLsp.getMoniker(absolutePath, line, character);
        return res.json({ success: true, monikers: Array.isArray(monikers) ? monikers : [] });
      } catch (error) {
        const err = error as Error;
        return res.status(500).json({ success: false, error: err.message || "Failed to get moniker" });
      }
    },
  );

  router.post(
    "/lsp/completion",
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
        const completion = await coreLsp.getCompletion(absolutePath, line, character);
        return res.json({ success: true, completion });
      } catch (error) {
        const err = error as Error;
        return res.status(500).json({ success: false, error: err.message || "Failed to get completion" });
      }
    },
  );

  router.post(
    "/lsp/selection-range",
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

        const ranges = await coreLsp.getSelectionRange(absolutePath, line, character);
        return res.json({ success: true, ranges: Array.isArray(ranges) ? ranges : [] });
      } catch (error) {
        const err = error as Error;
        return res.status(500).json({
          success: false,
          error: err.message || "Failed to get selection range",
        });
      }
    },
  );

  router.post(
    "/lsp/linked-editing-range",
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

        const ranges = await coreLsp.getLinkedEditingRange(absolutePath, line, character);
        return res.json({ success: true, ranges });
      } catch (error) {
        const err = error as Error;
        return res.status(500).json({
          success: false,
          error: err.message || "Failed to get linked editing range",
        });
      }
    },
  );
};
