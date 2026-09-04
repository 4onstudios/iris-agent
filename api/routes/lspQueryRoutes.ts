import path from "path";
import type { NextFunction, Request, Response, Router } from "express";
import { coreLsp } from "../core/library/lsp/coreLsp";

type LspDiagnosticsRequestBody = {
  filePath?: string;
  workspaceRoot?: string;
  languageId?: string;
};

type LspCodeActionsRequestBody = {
  filePath?: string;
  workspaceRoot?: string;
  startLine?: number;
  startCharacter?: number;
  endLine?: number;
  endCharacter?: number;
  context?: {
    diagnostics?: unknown[];
    only?: string[];
    triggerKind?: number;
  };
};

type LspRenameRequestBody = {
  filePath?: string;
  workspaceRoot?: string;
  line?: number;
  character?: number;
  newName?: string;
};

type LspPositionRequestBody = {
  filePath?: string;
  workspaceRoot?: string;
  line?: number;
  character?: number;
  text?: string;
};

type LspFormatRequestBody = {
  filePath?: string;
  workspaceRoot?: string;
  options?: {
    tabSize?: number;
    insertSpaces?: boolean;
    trimTrailingWhitespace?: boolean;
    insertFinalNewline?: boolean;
    trimFinalNewlines?: boolean;
  };
};

type LspRangeFormatRequestBody = {
  filePath?: string;
  workspaceRoot?: string;
  startLine?: number;
  startCharacter?: number;
  endLine?: number;
  endCharacter?: number;
  options?: {
    tabSize?: number;
    insertSpaces?: boolean;
    trimTrailingWhitespace?: boolean;
    insertFinalNewline?: boolean;
    trimFinalNewlines?: boolean;
  };
};

type LspOnTypeFormatRequestBody = {
  filePath?: string;
  workspaceRoot?: string;
  line?: number;
  character?: number;
  ch?: string;
  options?: {
    tabSize?: number;
    insertSpaces?: boolean;
    trimTrailingWhitespace?: boolean;
    insertFinalNewline?: boolean;
    trimFinalNewlines?: boolean;
  };
};

type LspWorkspaceSymbolsRequestBody = {
  workspaceRoot?: string;
  query?: string;
  languageId?: string;
};

type LspSignatureHelpRequestBody = {
  filePath?: string;
  workspaceRoot?: string;
  line?: number;
  character?: number;
};

type LspConfigRequestBody = {
  workspaceRoot?: string;
  settings?: Record<string, unknown>;
};

type LspWatchedFilesRequestBody = {
  workspaceRoot?: string;
  changes?: Array<{
    filePath?: string;
    type?: number;
  }>;
};

type LspFileCreateDeleteRequestBody = {
  workspaceRoot?: string;
  filePaths?: string[];
};

type LspFileRenameRequestBody = {
  workspaceRoot?: string;
  files?: Array<{ oldFilePath?: string; newFilePath?: string }>;
};

type LspRangeRequestBody = {
  filePath?: string;
  workspaceRoot?: string;
  startLine?: number;
  startCharacter?: number;
  endLine?: number;
  endCharacter?: number;
};

type LspInlineValuesRequestBody = {
  filePath?: string;
  workspaceRoot?: string;
  startLine?: number;
  startCharacter?: number;
  endLine?: number;
  endCharacter?: number;
  frameId?: number;
  stoppedStartLine?: number;
  stoppedStartCharacter?: number;
  stoppedEndLine?: number;
  stoppedEndCharacter?: number;
};

type LspColorPresentationRequestBody = {
  filePath?: string;
  workspaceRoot?: string;
  color?: unknown;
  startLine?: number;
  startCharacter?: number;
  endLine?: number;
  endCharacter?: number;
};

type LspInlineCompletionRequestBody = {
  filePath?: string;
  workspaceRoot?: string;
  line?: number;
  character?: number;
  context?: Record<string, unknown>;
};

type LspWorkspaceFoldersRequestBody = {
  workspaceRoot?: string;
  added?: Array<{ uri?: string; name?: string }>;
  removed?: Array<{ uri?: string; name?: string }>;
};

type LspWillSaveRequestBody = {
  filePath?: string;
  workspaceRoot?: string;
  reason?: number;
};

type LspWillSaveWaitUntilRequestBody = {
  filePath?: string;
  workspaceRoot?: string;
  reason?: number;
};

type LspExecuteCommandRequestBody = {
  workspaceRoot?: string;
  command?: string;
  args?: unknown[];
  languageId?: string;
  filePath?: string;
};

type AuthMiddleware = (req: Request, res: Response, next: NextFunction) => void;

const resolveAbsolutePath = (workspacePath: string, filePath: string): string =>
  path.isAbsolute(filePath) ? filePath : path.join(workspacePath, filePath);

const buildFormatOptions = (options?: {
  tabSize?: number;
  insertSpaces?: boolean;
  trimTrailingWhitespace?: boolean;
  insertFinalNewline?: boolean;
  trimFinalNewlines?: boolean;
}) => ({
  tabSize: typeof options?.tabSize === "number" ? options.tabSize : 2,
  insertSpaces: typeof options?.insertSpaces === "boolean" ? options.insertSpaces : true,
  trimTrailingWhitespace:
    typeof options?.trimTrailingWhitespace === "boolean" ? options.trimTrailingWhitespace : true,
  insertFinalNewline:
    typeof options?.insertFinalNewline === "boolean" ? options.insertFinalNewline : true,
  trimFinalNewlines:
    typeof options?.trimFinalNewlines === "boolean" ? options.trimFinalNewlines : true,
});

export const registerLspQueryRoutes = (
  router: Router,
  requireDesktopAuth: AuthMiddleware,
): void => {
  router.post(
    "/lsp/diagnostics",
    requireDesktopAuth,
    async (req: Request<{}, {}, LspDiagnosticsRequestBody>, res: Response) => {
      try {
        const { filePath, workspaceRoot } = req.body;

        if (typeof filePath !== "string" || filePath.trim().length === 0) {
          return res.status(400).json({ success: false, error: "filePath is required" });
        }

        const workspacePath = workspaceRoot || process.cwd();
        const absolutePath = resolveAbsolutePath(workspacePath, filePath);

        coreLsp.setRootPath(workspacePath);
        const diagnostics = coreLsp.getDiagnosticsForFile(absolutePath);

        return res.json({ success: true, diagnostics });
      } catch (error) {
        const err = error as Error;
        return res.status(500).json({ success: false, error: err.message || "Failed to get diagnostics" });
      }
    },
  );

  router.post(
    "/lsp/diagnostic",
    requireDesktopAuth,
    async (req: Request<{}, {}, LspDiagnosticsRequestBody>, res: Response) => {
      try {
        const { filePath, workspaceRoot } = req.body;

        if (typeof filePath !== "string" || filePath.trim().length === 0) {
          return res.status(400).json({ success: false, error: "filePath is required" });
        }

        const workspacePath = workspaceRoot || process.cwd();
        const absolutePath = resolveAbsolutePath(workspacePath, filePath);

        coreLsp.setRootPath(workspacePath);
        const report = await coreLsp.getPullDiagnosticsForFile(absolutePath);

        if (!report) {
          return res.json({ success: false, error: "No diagnostic report available" });
        }

        return res.json({ success: true, report });
      } catch (error) {
        const err = error as Error;
        return res.status(500).json({ success: false, error: err.message || "Failed to get diagnostic report" });
      }
    },
  );

  router.post(
    "/lsp/workspace-diagnostic",
    requireDesktopAuth,
    async (req: Request<{}, {}, LspDiagnosticsRequestBody>, res: Response) => {
      try {
        const { workspaceRoot, languageId } = req.body;

        const workspacePath = workspaceRoot || process.cwd();
        coreLsp.setRootPath(workspacePath);

        const report = await coreLsp.getWorkspacePullDiagnostics(languageId);

        if (!report) {
          return res.json({ success: false, error: "No workspace diagnostic report available" });
        }

        return res.json({ success: true, report });
      } catch (error) {
        const err = error as Error;
        return res.status(500).json({ success: false, error: err.message || "Failed to get workspace diagnostic report" });
      }
    },
  );

  router.post(
    "/lsp/code-actions",
    requireDesktopAuth,
    async (req: Request<{}, {}, LspCodeActionsRequestBody>, res: Response) => {
      try {
        const {
          filePath,
          workspaceRoot,
          startLine,
          startCharacter,
          endLine,
          endCharacter,
          context,
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
        const actions = await coreLsp.getCodeActions(
          absolutePath,
          startLine,
          startCharacter,
          endLine,
          endCharacter,
          context,
        );

        return res.json({ success: true, actions });
      } catch (error) {
        const err = error as Error;
        return res.status(500).json({ success: false, error: err.message || "Failed to get code actions" });
      }
    },
  );

  router.post(
    "/lsp/rename",
    requireDesktopAuth,
    async (req: Request<{}, {}, LspRenameRequestBody>, res: Response) => {
      try {
        const { filePath, workspaceRoot, line, character, newName } = req.body;

        if (typeof filePath !== "string" || filePath.trim().length === 0) {
          return res.status(400).json({ success: false, error: "filePath is required" });
        }

        if (typeof line !== "number" || typeof character !== "number" || typeof newName !== "string") {
          return res.status(400).json({ success: false, error: "line, character, and newName are required" });
        }

        const workspacePath = workspaceRoot || process.cwd();
        const absolutePath = resolveAbsolutePath(workspacePath, filePath);

        coreLsp.setRootPath(workspacePath);
        const result = await coreLsp.renameSymbol(absolutePath, line, character, newName);

        return res.json({ success: true, edit: result });
      } catch (error) {
        const err = error as Error;
        return res.status(500).json({ success: false, error: err.message || "Failed to rename symbol" });
      }
    },
  );

  router.post(
    "/lsp/prepare-rename",
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
        const result = await coreLsp.prepareRename(absolutePath, line, character);

        return res.json({ success: true, range: result });
      } catch (error) {
        const err = error as Error;
        return res.status(500).json({ success: false, error: err.message || "Failed to prepare rename" });
      }
    },
  );

  router.post(
    "/lsp/format",
    requireDesktopAuth,
    async (req: Request<{}, {}, LspFormatRequestBody>, res: Response) => {
      try {
        const { filePath, workspaceRoot, options } = req.body;

        if (typeof filePath !== "string" || filePath.trim().length === 0) {
          return res.status(400).json({ success: false, error: "filePath is required" });
        }

        const workspacePath = workspaceRoot || process.cwd();
        const absolutePath = resolveAbsolutePath(workspacePath, filePath);
        const formatOptions = buildFormatOptions(options);

        coreLsp.setRootPath(workspacePath);
        const edits = await coreLsp.formatDocument(absolutePath, formatOptions);

        return res.json({ success: true, edits });
      } catch (error) {
        const err = error as Error;
        return res.status(500).json({ success: false, error: err.message || "Failed to format document" });
      }
    },
  );

  router.post(
    "/lsp/range-format",
    requireDesktopAuth,
    async (req: Request<{}, {}, LspRangeFormatRequestBody>, res: Response) => {
      try {
        const {
          filePath,
          workspaceRoot,
          startLine,
          startCharacter,
          endLine,
          endCharacter,
          options,
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
        const formatOptions = buildFormatOptions(options);

        coreLsp.setRootPath(workspacePath);
        const edits = await coreLsp.formatRange(
          absolutePath,
          startLine,
          startCharacter,
          endLine,
          endCharacter,
          formatOptions,
        );

        return res.json({ success: true, edits });
      } catch (error) {
        const err = error as Error;
        return res.status(500).json({ success: false, error: err.message || "Failed to format range" });
      }
    },
  );

  router.post(
    "/lsp/on-type-format",
    requireDesktopAuth,
    async (req: Request<{}, {}, LspOnTypeFormatRequestBody>, res: Response) => {
      try {
        const { filePath, workspaceRoot, line, character, ch, options } = req.body;

        if (typeof filePath !== "string" || filePath.trim().length === 0) {
          return res.status(400).json({ success: false, error: "filePath is required" });
        }

        if (
          typeof line !== "number" ||
          typeof character !== "number" ||
          typeof ch !== "string" ||
          ch.length === 0
        ) {
          return res.status(400).json({ success: false, error: "line, character, and ch are required" });
        }

        const workspacePath = workspaceRoot || process.cwd();
        const absolutePath = resolveAbsolutePath(workspacePath, filePath);
        const formatOptions = buildFormatOptions(options);

        coreLsp.setRootPath(workspacePath);
        const edits = await coreLsp.formatOnType(
          absolutePath,
          line,
          character,
          ch,
          formatOptions,
        );

        return res.json({ success: true, edits });
      } catch (error) {
        const err = error as Error;
        return res.status(500).json({ success: false, error: err.message || "Failed on type formatting" });
      }
    },
  );

  router.post(
    "/lsp/workspace-symbols",
    requireDesktopAuth,
    async (req: Request<{}, {}, LspWorkspaceSymbolsRequestBody>, res: Response) => {
      try {
        const { workspaceRoot, query, languageId } = req.body;

        if (typeof query !== "string") {
          return res.status(400).json({ success: false, error: "query is required" });
        }

        const workspacePath = workspaceRoot || process.cwd();
        coreLsp.setRootPath(workspacePath);

        const symbols = await coreLsp.getWorkspaceSymbols(query, languageId);
        return res.json({ success: true, symbols });
      } catch (error) {
        const err = error as Error;
        return res.status(500).json({ success: false, error: err.message || "Failed to get workspace symbols" });
      }
    },
  );

  router.post(
    "/lsp/signature-help",
    requireDesktopAuth,
    async (req: Request<{}, {}, LspSignatureHelpRequestBody>, res: Response) => {
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

        const signatureHelp = await coreLsp.getSignatureHelp(absolutePath, line, character);
        return res.json({ success: true, signatureHelp });
      } catch (error) {
        const err = error as Error;
        return res.status(500).json({ success: false, error: err.message || "Failed to get signature help" });
      }
    },
  );

  router.post(
    "/lsp/configuration",
    requireDesktopAuth,
    async (req: Request<{}, {}, LspConfigRequestBody>, res: Response) => {
      try {
        const { workspaceRoot, settings } = req.body;
        const workspacePath = workspaceRoot || process.cwd();
        coreLsp.setRootPath(workspacePath);

        await coreLsp.didChangeConfiguration(settings ?? {});
        return res.json({ success: true });
      } catch (error) {
        const err = error as Error;
        return res.status(500).json({ success: false, error: err.message || "Failed to update LSP configuration" });
      }
    },
  );

  router.post(
    "/lsp/watched-files",
    requireDesktopAuth,
    async (req: Request<{}, {}, LspWatchedFilesRequestBody>, res: Response) => {
      try {
        const { workspaceRoot, changes } = req.body;

        if (!Array.isArray(changes)) {
          return res.status(400).json({ success: false, error: "changes array is required" });
        }

        const normalizedChanges = changes
          .filter((change) => typeof change.filePath === "string" && typeof change.type === "number")
          .map((change) => ({
            filePath: String(change.filePath),
            type: change.type as 1 | 2 | 3,
          }));

        const workspacePath = workspaceRoot || process.cwd();
        coreLsp.setRootPath(workspacePath);

        await coreLsp.didChangeWatchedFiles(normalizedChanges);
        return res.json({ success: true, count: normalizedChanges.length });
      } catch (error) {
        const err = error as Error;
        return res.status(500).json({ success: false, error: err.message || "Failed to notify watched files" });
      }
    },
  );

  router.post(
    "/lsp/will-save",
    requireDesktopAuth,
    async (req: Request<{}, {}, LspWillSaveRequestBody>, res: Response) => {
      try {
        const { filePath, workspaceRoot, reason } = req.body;
        if (typeof filePath !== "string" || filePath.trim().length === 0) {
          return res.status(400).json({ success: false, error: "filePath is required" });
        }

        const workspacePath = workspaceRoot || process.cwd();
        const absolutePath = resolveAbsolutePath(workspacePath, filePath);
        coreLsp.setRootPath(workspacePath);

        coreLsp.willSaveDocument(absolutePath, typeof reason === "number" ? reason : 1);
        return res.json({ success: true });
      } catch (error) {
        const err = error as Error;
        return res.status(500).json({ success: false, error: err.message || "Failed to send willSave" });
      }
    },
  );

  router.post(
    "/lsp/workspace-folders",
    requireDesktopAuth,
    async (req: Request<{}, {}, LspWorkspaceFoldersRequestBody>, res: Response) => {
      try {
        const { workspaceRoot, added, removed } = req.body;

        const normalizeFolder = (f: { uri?: string; name?: string }) => ({
          uri: typeof f.uri === "string" ? f.uri : "",
          name: typeof f.name === "string" ? f.name : "",
        });

        const addedFolders = Array.isArray(added) ? added.map(normalizeFolder) : [];
        const removedFolders = Array.isArray(removed) ? removed.map(normalizeFolder) : [];

        const workspacePath = workspaceRoot || process.cwd();
        coreLsp.setRootPath(workspacePath);

        await coreLsp.didChangeWorkspaceFolders(addedFolders, removedFolders);
        return res.json({ success: true, added: addedFolders.length, removed: removedFolders.length });
      } catch (error) {
        const err = error as Error;
        return res.status(500).json({ success: false, error: err.message || "Failed to notify workspace folder changes" });
      }
    },
  );

  router.post(
    "/lsp/will-create-files",
    requireDesktopAuth,
    async (req: Request<{}, {}, LspFileCreateDeleteRequestBody>, res: Response) => {
      try {
        const { workspaceRoot, filePaths } = req.body;
        if (!Array.isArray(filePaths)) {
          return res.status(400).json({ success: false, error: "filePaths array is required" });
        }

        const workspacePath = workspaceRoot || process.cwd();
        const normalized = filePaths
          .filter((filePath) => typeof filePath === "string" && filePath.trim().length > 0)
          .map((filePath) => (path.isAbsolute(filePath) ? filePath : path.join(workspacePath, filePath)));

        coreLsp.setRootPath(workspacePath);
        const results = await coreLsp.willCreateFiles(normalized);
        return res.json({ success: true, count: normalized.length, results });
      } catch (error) {
        const err = error as Error;
        return res.status(500).json({ success: false, error: err.message || "Failed to notify willCreateFiles" });
      }
    },
  );

  router.post(
    "/lsp/did-create-files",
    requireDesktopAuth,
    async (req: Request<{}, {}, LspFileCreateDeleteRequestBody>, res: Response) => {
      try {
        const { workspaceRoot, filePaths } = req.body;
        if (!Array.isArray(filePaths)) {
          return res.status(400).json({ success: false, error: "filePaths array is required" });
        }

        const workspacePath = workspaceRoot || process.cwd();
        const normalized = filePaths
          .filter((filePath) => typeof filePath === "string" && filePath.trim().length > 0)
          .map((filePath) => (path.isAbsolute(filePath) ? filePath : path.join(workspacePath, filePath)));

        coreLsp.setRootPath(workspacePath);
        await coreLsp.didCreateFiles(normalized);
        return res.json({ success: true, count: normalized.length });
      } catch (error) {
        const err = error as Error;
        return res.status(500).json({ success: false, error: err.message || "Failed to notify didCreateFiles" });
      }
    },
  );

  router.post(
    "/lsp/will-rename-files",
    requireDesktopAuth,
    async (req: Request<{}, {}, LspFileRenameRequestBody>, res: Response) => {
      try {
        const { workspaceRoot, files } = req.body;
        if (!Array.isArray(files)) {
          return res.status(400).json({ success: false, error: "files array is required" });
        }

        const workspacePath = workspaceRoot || process.cwd();
        const normalized = files
          .filter(
            (file) =>
              typeof file.oldFilePath === "string" &&
              file.oldFilePath.trim().length > 0 &&
              typeof file.newFilePath === "string" &&
              file.newFilePath.trim().length > 0,
          )
          .map((file) => ({
            oldFilePath: path.isAbsolute(file.oldFilePath as string)
              ? (file.oldFilePath as string)
              : path.join(workspacePath, String(file.oldFilePath)),
            newFilePath: path.isAbsolute(file.newFilePath as string)
              ? (file.newFilePath as string)
              : path.join(workspacePath, String(file.newFilePath)),
          }));

        coreLsp.setRootPath(workspacePath);
        const results = await coreLsp.willRenameFiles(normalized);
        return res.json({ success: true, count: normalized.length, results });
      } catch (error) {
        const err = error as Error;
        return res.status(500).json({ success: false, error: err.message || "Failed to notify willRenameFiles" });
      }
    },
  );

  router.post(
    "/lsp/did-rename-files",
    requireDesktopAuth,
    async (req: Request<{}, {}, LspFileRenameRequestBody>, res: Response) => {
      try {
        const { workspaceRoot, files } = req.body;
        if (!Array.isArray(files)) {
          return res.status(400).json({ success: false, error: "files array is required" });
        }

        const workspacePath = workspaceRoot || process.cwd();
        const normalized = files
          .filter(
            (file) =>
              typeof file.oldFilePath === "string" &&
              file.oldFilePath.trim().length > 0 &&
              typeof file.newFilePath === "string" &&
              file.newFilePath.trim().length > 0,
          )
          .map((file) => ({
            oldFilePath: path.isAbsolute(file.oldFilePath as string)
              ? (file.oldFilePath as string)
              : path.join(workspacePath, String(file.oldFilePath)),
            newFilePath: path.isAbsolute(file.newFilePath as string)
              ? (file.newFilePath as string)
              : path.join(workspacePath, String(file.newFilePath)),
          }));

        coreLsp.setRootPath(workspacePath);
        await coreLsp.didRenameFiles(normalized);
        return res.json({ success: true, count: normalized.length });
      } catch (error) {
        const err = error as Error;
        return res.status(500).json({ success: false, error: err.message || "Failed to notify didRenameFiles" });
      }
    },
  );

  router.post(
    "/lsp/will-delete-files",
    requireDesktopAuth,
    async (req: Request<{}, {}, LspFileCreateDeleteRequestBody>, res: Response) => {
      try {
        const { workspaceRoot, filePaths } = req.body;
        if (!Array.isArray(filePaths)) {
          return res.status(400).json({ success: false, error: "filePaths array is required" });
        }

        const workspacePath = workspaceRoot || process.cwd();
        const normalized = filePaths
          .filter((filePath) => typeof filePath === "string" && filePath.trim().length > 0)
          .map((filePath) => (path.isAbsolute(filePath) ? filePath : path.join(workspacePath, filePath)));

        coreLsp.setRootPath(workspacePath);
        const results = await coreLsp.willDeleteFiles(normalized);
        return res.json({ success: true, count: normalized.length, results });
      } catch (error) {
        const err = error as Error;
        return res.status(500).json({ success: false, error: err.message || "Failed to notify willDeleteFiles" });
      }
    },
  );

  router.post(
    "/lsp/did-delete-files",
    requireDesktopAuth,
    async (req: Request<{}, {}, LspFileCreateDeleteRequestBody>, res: Response) => {
      try {
        const { workspaceRoot, filePaths } = req.body;
        if (!Array.isArray(filePaths)) {
          return res.status(400).json({ success: false, error: "filePaths array is required" });
        }

        const workspacePath = workspaceRoot || process.cwd();
        const normalized = filePaths
          .filter((filePath) => typeof filePath === "string" && filePath.trim().length > 0)
          .map((filePath) => (path.isAbsolute(filePath) ? filePath : path.join(workspacePath, filePath)));

        coreLsp.setRootPath(workspacePath);
        await coreLsp.didDeleteFiles(normalized);
        return res.json({ success: true, count: normalized.length });
      } catch (error) {
        const err = error as Error;
        return res.status(500).json({ success: false, error: err.message || "Failed to notify didDeleteFiles" });
      }
    },
  );

  router.post(
    "/lsp/document-symbols",
    requireDesktopAuth,
    async (req: Request<{}, {}, LspDiagnosticsRequestBody>, res: Response) => {
      try {
        const { filePath, workspaceRoot } = req.body;
        if (typeof filePath !== "string" || filePath.trim().length === 0) {
          return res.status(400).json({ success: false, error: "filePath is required" });
        }

        const workspacePath = workspaceRoot || process.cwd();
        const absolutePath = resolveAbsolutePath(workspacePath, filePath);
        coreLsp.setRootPath(workspacePath);

        const symbols = await coreLsp.getDocumentSymbols(absolutePath);
        return res.json({ success: true, symbols: Array.isArray(symbols) ? symbols : [] });
      } catch (error) {
        const err = error as Error;
        return res.status(500).json({ success: false, error: err.message || "Failed to get document symbols" });
      }
    },
  );

  router.post(
    "/lsp/code-lens",
    requireDesktopAuth,
    async (req: Request<{}, {}, LspDiagnosticsRequestBody>, res: Response) => {
      try {
        const { filePath, workspaceRoot } = req.body;
        if (typeof filePath !== "string" || filePath.trim().length === 0) {
          return res.status(400).json({ success: false, error: "filePath is required" });
        }

        const workspacePath = workspaceRoot || process.cwd();
        const absolutePath = resolveAbsolutePath(workspacePath, filePath);
        coreLsp.setRootPath(workspacePath);

        const codeLens = await coreLsp.getCodeLens(absolutePath);
        return res.json({ success: true, codeLens: Array.isArray(codeLens) ? codeLens : [] });
      } catch (error) {
        const err = error as Error;
        return res.status(500).json({ success: false, error: err.message || "Failed to get code lens" });
      }
    },
  );

  router.post(
    "/lsp/folding-ranges",
    requireDesktopAuth,
    async (req: Request<{}, {}, LspDiagnosticsRequestBody>, res: Response) => {
      try {
        const { filePath, workspaceRoot } = req.body;
        if (typeof filePath !== "string" || filePath.trim().length === 0) {
          return res.status(400).json({ success: false, error: "filePath is required" });
        }

        const workspacePath = workspaceRoot || process.cwd();
        const absolutePath = resolveAbsolutePath(workspacePath, filePath);
        coreLsp.setRootPath(workspacePath);

        const ranges = await coreLsp.getFoldingRange(absolutePath);
        return res.json({ success: true, ranges: Array.isArray(ranges) ? ranges : [] });
      } catch (error) {
        const err = error as Error;
        return res.status(500).json({ success: false, error: err.message || "Failed to get folding ranges" });
      }
    },
  );

  router.post(
    "/lsp/document-colors",
    requireDesktopAuth,
    async (req: Request<{}, {}, LspDiagnosticsRequestBody>, res: Response) => {
      try {
        const { filePath, workspaceRoot } = req.body;
        if (typeof filePath !== "string" || filePath.trim().length === 0) {
          return res.status(400).json({ success: false, error: "filePath is required" });
        }

        const workspacePath = workspaceRoot || process.cwd();
        const absolutePath = resolveAbsolutePath(workspacePath, filePath);
        coreLsp.setRootPath(workspacePath);

        const colors = await coreLsp.getDocumentColors(absolutePath);
        return res.json({ success: true, colors: Array.isArray(colors) ? colors : [] });
      } catch (error) {
        const err = error as Error;
        return res.status(500).json({ success: false, error: err.message || "Failed to get document colors" });
      }
    },
  );

  router.post(
    "/lsp/color-presentations",
    requireDesktopAuth,
    async (req: Request<{}, {}, LspColorPresentationRequestBody>, res: Response) => {
      try {
        const {
          filePath,
          workspaceRoot,
          color,
          startLine,
          startCharacter,
          endLine,
          endCharacter,
        } = req.body;
        if (typeof filePath !== "string" || filePath.trim().length === 0) {
          return res.status(400).json({ success: false, error: "filePath is required" });
        }
        if (
          color == null ||
          typeof startLine !== "number" ||
          typeof startCharacter !== "number" ||
          typeof endLine !== "number" ||
          typeof endCharacter !== "number"
        ) {
          return res.status(400).json({
            success: false,
            error: "color, startLine, startCharacter, endLine, and endCharacter are required",
          });
        }

        const workspacePath = workspaceRoot || process.cwd();
        const absolutePath = resolveAbsolutePath(workspacePath, filePath);
        coreLsp.setRootPath(workspacePath);

        const presentations = await coreLsp.getColorPresentations(
          absolutePath,
          color,
          startLine,
          startCharacter,
          endLine,
          endCharacter,
        );
        return res.json({ success: true, presentations: Array.isArray(presentations) ? presentations : [] });
      } catch (error) {
        const err = error as Error;
        return res.status(500).json({ success: false, error: err.message || "Failed to get color presentations" });
      }
    },
  );

  router.post(
    "/lsp/document-links",
    requireDesktopAuth,
    async (req: Request<{}, {}, LspDiagnosticsRequestBody>, res: Response) => {
      try {
        const { filePath, workspaceRoot } = req.body;
        if (typeof filePath !== "string" || filePath.trim().length === 0) {
          return res.status(400).json({ success: false, error: "filePath is required" });
        }

        const workspacePath = workspaceRoot || process.cwd();
        const absolutePath = resolveAbsolutePath(workspacePath, filePath);
        coreLsp.setRootPath(workspacePath);

        const links = await coreLsp.getDocumentLinks(absolutePath);
        return res.json({ success: true, links: Array.isArray(links) ? links : [] });
      } catch (error) {
        const err = error as Error;
        return res.status(500).json({ success: false, error: err.message || "Failed to get document links" });
      }
    },
  );

  router.post(
    "/lsp/execute-command",
    requireDesktopAuth,
    async (req: Request<{}, {}, LspExecuteCommandRequestBody>, res: Response) => {
      try {
        const { workspaceRoot, command, args, languageId, filePath } = req.body;
        if (typeof command !== "string" || command.trim().length === 0) {
          return res.status(400).json({ success: false, error: "command is required" });
        }

        if (
          typeof languageId !== "string" &&
          (typeof filePath !== "string" || filePath.trim().length === 0)
        ) {
          return res.status(400).json({ success: false, error: "languageId or filePath is required" });
        }

        const workspacePath = workspaceRoot || process.cwd();
        coreLsp.setRootPath(workspacePath);
        const absolutePath =
          typeof filePath === "string" && filePath.length > 0
            ? (path.isAbsolute(filePath) ? filePath : path.join(workspacePath, filePath))
            : undefined;

        const result = await coreLsp.executeWorkspaceCommand(
          command,
          Array.isArray(args) ? args : [],
          typeof languageId === "string" ? languageId : undefined,
          absolutePath,
        );
        return res.json({ success: true, result });
      } catch (error) {
        const err = error as Error;
        return res.status(500).json({ success: false, error: err.message || "Failed to execute command" });
      }
    },
  );

  router.post(
    "/lsp/inlay-hints",
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

        const hints = await coreLsp.getInlayHints(
          absolutePath,
          startLine,
          startCharacter,
          endLine,
          endCharacter,
        );
        return res.json({ success: true, hints: Array.isArray(hints) ? hints : [] });
      } catch (error) {
        const err = error as Error;
        return res.status(500).json({ success: false, error: err.message || "Failed to get inlay hints" });
      }
    },
  );

  router.post(
    "/lsp/inline-values",
    requireDesktopAuth,
    async (req: Request<{}, {}, LspInlineValuesRequestBody>, res: Response) => {
      try {
        const {
          filePath,
          workspaceRoot,
          startLine,
          startCharacter,
          endLine,
          endCharacter,
          frameId,
          stoppedStartLine,
          stoppedStartCharacter,
          stoppedEndLine,
          stoppedEndCharacter,
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

        const inlineValues = await coreLsp.getInlineValues(
          absolutePath,
          {
            start: { line: startLine, character: startCharacter },
            end: { line: endLine, character: endCharacter },
          },
          {
            frameId: typeof frameId === "number" ? frameId : undefined,
            stoppedLocation:
              typeof stoppedStartLine === "number" &&
              typeof stoppedStartCharacter === "number" &&
              typeof stoppedEndLine === "number" &&
              typeof stoppedEndCharacter === "number"
                ? {
                    start: { line: stoppedStartLine, character: stoppedStartCharacter },
                    end: { line: stoppedEndLine, character: stoppedEndCharacter },
                  }
                : undefined,
          },
        );

        return res.json({ success: true, inlineValues: Array.isArray(inlineValues) ? inlineValues : [] });
      } catch (error) {
        const err = error as Error;
        return res.status(500).json({ success: false, error: err.message || "Failed to get inline values" });
      }
    },
  );

  router.post(
    "/lsp/inline-completion",
    requireDesktopAuth,
    async (req: Request<{}, {}, LspInlineCompletionRequestBody>, res: Response) => {
      try {
        const { filePath, workspaceRoot, line, character, context } = req.body;
        if (typeof filePath !== "string" || filePath.trim().length === 0) {
          return res.status(400).json({ success: false, error: "filePath is required" });
        }
        if (typeof line !== "number" || typeof character !== "number") {
          return res.status(400).json({ success: false, error: "line and character are required" });
        }

        const workspacePath = workspaceRoot || process.cwd();
        const absolutePath = resolveAbsolutePath(workspacePath, filePath);
        coreLsp.setRootPath(workspacePath);

        const completion = await coreLsp.getInlineCompletion(
          absolutePath,
          line,
          character,
          context && typeof context === "object" ? context : {},
        );

        return res.json({ success: true, completion });
      } catch (error) {
        const err = error as Error;
        return res.status(500).json({ success: false, error: err.message || "Failed to get inline completion" });
      }
    },
  );

  router.post(
    "/lsp/will-save-wait-until",
    requireDesktopAuth,
    async (req: Request<{}, {}, LspWillSaveWaitUntilRequestBody>, res: Response) => {
      try {
        const { filePath, workspaceRoot, reason } = req.body;
        if (typeof filePath !== "string" || filePath.trim().length === 0) {
          return res.status(400).json({ success: false, error: "filePath is required" });
        }

        const workspacePath = workspaceRoot || process.cwd();
        const absolutePath = resolveAbsolutePath(workspacePath, filePath);
        coreLsp.setRootPath(workspacePath);

        const edits = await coreLsp.willSaveWaitUntil(absolutePath, typeof reason === "number" ? reason : 1);
        return res.json({ success: true, edits: Array.isArray(edits) ? edits : [] });
      } catch (error) {
        const err = error as Error;
        return res.status(500).json({ success: false, error: err.message || "Failed to run willSaveWaitUntil" });
      }
    },
  );
};
