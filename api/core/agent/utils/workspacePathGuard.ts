import fs from "fs/promises";
import path from "path";

type WorkspaceMutationRejection = {
  success: false;
  error: string;
};

const isPathWithin = (basePath: string, targetPath: string): boolean => {
  const relative = path.relative(basePath, targetPath);
  return !(
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`)
  );
};

const isMissingPathError = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException)?.code === "ENOENT";

const resolveExistingPath = async (targetPath: string): Promise<string | null> => {
  try {
    await fs.lstat(targetPath);
  } catch (error) {
    if (isMissingPathError(error)) {
      return null;
    }
    throw error;
  }

  return fs.realpath(targetPath);
};

export const isWorkspaceMutationPathAllowed = async (
  workspaceBasePath: string,
  filePath: string,
): Promise<boolean> => {
  const resolvedWorkspace = path.resolve(workspaceBasePath);
  const resolvedTarget = path.resolve(filePath);

  if (!isPathWithin(resolvedWorkspace, resolvedTarget)) {
    return false;
  }

  let realWorkspace: string;
  try {
    realWorkspace = await fs.realpath(resolvedWorkspace);
  } catch {
    return false;
  }

  try {
    const realTarget = await resolveExistingPath(resolvedTarget);
    if (realTarget) {
      return isPathWithin(realWorkspace, realTarget);
    }
  } catch {
    return false;
  }

  // New files do not have a realpath yet. Validate the nearest existing
  // ancestor, rejecting dangling symlinks and non-ENOENT filesystem errors.
  let ancestor = path.dirname(resolvedTarget);
  while (isPathWithin(resolvedWorkspace, ancestor)) {
    try {
      const realAncestor = await resolveExistingPath(ancestor);
      if (realAncestor) {
        return isPathWithin(realWorkspace, realAncestor);
      }
    } catch {
      return false;
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }

  return false;
};

export const rejectUnsafeWorkspaceMutation = async (
  workspaceBasePath: string,
  isVirtualWorkspace: boolean,
  filePaths: string[],
): Promise<WorkspaceMutationRejection | null> => {
  if (isVirtualWorkspace) {
    return {
      success: false,
      error:
        "Server-side filesystem mutations are disabled for virtual workspaces",
    };
  }

  const allowed = await Promise.all(
    filePaths.map((filePath) =>
      isWorkspaceMutationPathAllowed(workspaceBasePath, filePath),
    ),
  );
  if (allowed.every(Boolean)) {
    return null;
  }

  return {
    success: false,
    error: "File path is outside the workspace boundary",
  };
};
