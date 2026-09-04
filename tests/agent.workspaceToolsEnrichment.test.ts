import {
  createWorkspaceTools,
  LocalFilesystem,
  Workspace,
} from "@mastra/core/workspace";
import { createIrisWorkspaceToolsConfig } from "../api/core/agent/index";

describe("Iris Mastra Workspace tool enrichment", () => {
  it("adds metadata and indexed search under Iris-facing names", async () => {
    const workspace = new Workspace({
      filesystem: new LocalFilesystem({ basePath: process.cwd() }),
      bm25: true,
      tools: createIrisWorkspaceToolsConfig(),
    });

    const tools = await createWorkspaceTools(workspace);
    const names = Object.keys(tools);

    expect(names).toEqual(expect.arrayContaining(["fileStat", "workspaceSearch"]));
    expect(names).not.toEqual(
      expect.arrayContaining([
        "mastra_workspace_file_stat",
        "mastra_workspace_search",
      ]),
    );
  });
});
