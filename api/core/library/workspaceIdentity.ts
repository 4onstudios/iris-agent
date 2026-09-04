import { getDesktopWorkspacePath } from "./desktopWorkspace";
import type { WorkspaceNode } from "./workspaceSummary";

type WorkspaceRootOptions = {
  preferDesktopRoot?: boolean;
  allowVirtualRoot?: boolean;
  fallbackToTreePath?: boolean;
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const isVirtualWorkspaceRoot = (root: string): boolean =>
  root.startsWith("/workspace/");

export const getWorkspaceTree = (): WorkspaceNode | null => {
  if (typeof window === "undefined") {
    return null;
  }

  return ((window as any).workspaceStructure ||
    (window as any).tauriWorkspaceStructure ||
    null) as WorkspaceNode | null;
};

export const getWorkspaceRoot = (
  options: WorkspaceRootOptions = {},
): string | undefined => {
  if (typeof window === "undefined") {
    return undefined;
  }

  const {
    preferDesktopRoot = true,
    allowVirtualRoot = true,
    fallbackToTreePath = true,
  } = options;

  const candidates: Array<string | null | undefined> = [];

  if (preferDesktopRoot) {
    candidates.push(getDesktopWorkspacePath());
  }

  candidates.push((window as any).workspaceRoot);

  if (fallbackToTreePath) {
    candidates.push(getWorkspaceTree()?.path);
  }

  if (!preferDesktopRoot) {
    candidates.push(getDesktopWorkspacePath());
  }

  for (const candidate of candidates) {
    if (!isNonEmptyString(candidate)) {
      continue;
    }

    if (!allowVirtualRoot && isVirtualWorkspaceRoot(candidate)) {
      continue;
    }

    return candidate;
  }

  return undefined;
};

export const getWorkspaceDisplayName = (): string => {
  const root = getWorkspaceTree();
  const pathCandidate =
    getWorkspaceRoot({ preferDesktopRoot: false }) ||
    (typeof root?.name === "string" ? root.name : "");

  const normalized = String(pathCandidate).trim();
  if (!normalized) {
    return "Workspace";
  }

  const segments = normalized.split(/[/\\]/).filter(Boolean);
  return segments[segments.length - 1] || "Workspace";
};
