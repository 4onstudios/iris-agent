import path from "path";

export const buildRecoveryQueries = (
  inputPath: string,
  basePath: string,
): string[] => {
  const normalizedInput = inputPath.replace(/\\/g, "/");
  const queries = new Set<string>();

  queries.add(inputPath);

  const baseName = path.basename(normalizedInput);
  if (baseName) {
    queries.add(baseName);
  }

  if (path.isAbsolute(inputPath)) {
    const resolved = path.resolve(inputPath).replace(/\\/g, "/");
    const workspaceName = path.basename(basePath.replace(/\\/g, "/"));
    const workspaceAnchor = `/${workspaceName}/`;
    const anchorIndex = resolved.indexOf(workspaceAnchor);

    if (anchorIndex >= 0) {
      const afterAnchor = resolved.slice(anchorIndex + workspaceAnchor.length);
      if (afterAnchor) {
        queries.add(afterAnchor);
      }
    }

    const segments = resolved.split("/").filter(Boolean);
    for (let depth = 2; depth <= 4; depth++) {
      if (segments.length >= depth) {
        queries.add(segments.slice(-depth).join("/"));
      }
    }
  }

  return Array.from(queries).filter(Boolean);
};
