import fs from "fs/promises";
import path from "path";
import type { Request, Response, RequestHandler, Router } from "express";

type ReadFileRequestBody = {
  filePath?: string;
  workspaceRoot?: string;
};

export const registerFileRoutes = (
  router: Router,
  requireDesktopAuth: RequestHandler,
): void => {
  // POST /api/agent/write-file - Write file content (for revert/undo operations)
  router.post("/write-file", requireDesktopAuth, async (req: Request, res: Response) => {
    try {
      const { filePath, content, workspaceRoot } = req.body as {
        filePath?: string;
        content?: string;
        workspaceRoot?: string;
      };

      if (!filePath) {
        return res.status(400).json({ error: "File path is required" });
      }
      if (content === undefined || content === null) {
        return res.status(400).json({ error: "Content is required" });
      }

      const workspacePath = workspaceRoot || process.cwd();

      // Resolve path and guard against traversal outside workspace
      const absolutePath = path.isAbsolute(filePath)
        ? filePath
        : path.join(workspacePath, filePath);

      const resolvedWorkspace = path.resolve(workspacePath);
      const resolvedTarget = path.resolve(absolutePath);
      if (
        !resolvedTarget.startsWith(resolvedWorkspace + path.sep) &&
        resolvedTarget !== resolvedWorkspace
      ) {
        return res.status(400).json({ error: "Path outside workspace" });
      }

      await fs.writeFile(resolvedTarget, content, "utf8");

      return res.json({ success: true, path: filePath });
    } catch (error) {
      const err = error as Error;
      console.error("Write file error:", error);
      return res
        .status(500)
        .json({ success: false, error: err.message || "Failed to write file" });
    }
  });

  // POST /api/agent/delete-file - Delete file (for undoing newly created files)
  router.post("/delete-file", requireDesktopAuth, async (req: Request, res: Response) => {
    try {
      const { filePath, workspaceRoot } = req.body as {
        filePath?: string;
        workspaceRoot?: string;
      };

      if (!filePath) {
        return res.status(400).json({ error: "File path is required" });
      }

      const workspacePath = workspaceRoot || process.cwd();

      // Resolve path and guard against traversal outside workspace
      const absolutePath = path.isAbsolute(filePath)
        ? filePath
        : path.join(workspacePath, filePath);

      const resolvedWorkspace = path.resolve(workspacePath);
      const resolvedTarget = path.resolve(absolutePath);
      if (
        !resolvedTarget.startsWith(resolvedWorkspace + path.sep) &&
        resolvedTarget !== resolvedWorkspace
      ) {
        return res.status(400).json({ error: "Path outside workspace" });
      }

      try {
        await fs.unlink(resolvedTarget);
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        // If already missing, treat as success for idempotent undo behavior.
        if (err.code !== "ENOENT") {
          throw error;
        }
      }

      return res.json({ success: true, path: filePath });
    } catch (error) {
      const err = error as Error;
      console.error("Delete file error:", error);
      return res
        .status(500)
        .json({ success: false, error: err.message || "Failed to delete file" });
    }
  });

  // POST /api/agent/read-file - Read file content (for web workspace)
  router.post(
    "/read-file",
    async (req: Request<{}, {}, ReadFileRequestBody>, res: Response) => {
      try {
        const { filePath, workspaceRoot } = req.body;

        if (!filePath) {
          return res.status(400).json({ error: "File path is required" });
        }

        const workspacePath = workspaceRoot || process.cwd();
        const isWebWorkspace = workspacePath.startsWith("/workspace/");

        if (isWebWorkspace) {
          return res.status(400).json({
            error:
              "Cannot read files from web workspace. File content must be provided by the client.",
          });
        }

        // Resolve file path relative to workspace
        const absolutePath = path.isAbsolute(filePath)
          ? filePath
          : path.join(workspacePath, filePath);

        const content = await fs.readFile(absolutePath, "utf8");

        return res.json({
          success: true,
          content,
          path: filePath,
        });
      } catch (error) {
        const err = error as Error;
        console.error("Read file error:", error);
        return res.status(500).json({
          success: false,
          error: err.message || "Failed to read file",
        });
      }
    },
  );
};
