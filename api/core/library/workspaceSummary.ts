export type WorkspaceNode = {
  type?: string;
  name?: string;
  path?: string;
  children?: WorkspaceNode[];
};

export type WorkspaceSummary = {
  hasRoot: boolean;
  fileCount: number;
  isDefinitelyEmpty: boolean;
};

export const countWorkspaceFiles = (node?: WorkspaceNode | null): number => {
  if (!node) return 0;
  if (node.type === "file") return 1;
  if (!Array.isArray(node.children) || node.children.length === 0) return 0;
  return node.children.reduce(
    (total, child) => total + countWorkspaceFiles(child),
    0,
  );
};

export const getWorkspaceSummaryFromRoot = (
  root?: WorkspaceNode | null,
): WorkspaceSummary => {
  const hasRoot = root != null;
  const children = root?.children;

  return {
    hasRoot,
    fileCount: countWorkspaceFiles(root),
    isDefinitelyEmpty: hasRoot && Array.isArray(children) && children.length === 0,
  };
};

export const collectWorkspaceFilePaths = (
  root?: WorkspaceNode | null,
): Set<string> => {
  const paths = new Set<string>();

  const walk = (node?: WorkspaceNode | null) => {
    if (!node) return;

    if (node.type === "file" && typeof node.path === "string" && node.path) {
      paths.add(node.path);
      return;
    }

    if (Array.isArray(node.children)) {
      node.children.forEach(walk);
    }
  };

  walk(root);
  return paths;
};

export const shouldShowEmptyWorkspaceState = ({
  summary,
  currentFile,
  activeTab,
}: {
  summary: WorkspaceSummary;
  currentFile?: unknown;
  activeTab?: string | null;
}): boolean =>
  summary.hasRoot && !currentFile && !activeTab;
