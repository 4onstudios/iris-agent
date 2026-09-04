import {
  createWorkspaceTools,
  LocalFilesystem,
  Workspace,
} from "@mastra/core/workspace";
import { createIrisWorkspaceToolsConfig } from "../api/core/agent/index";

describe("Iris Mastra Workspace tool migration", () => {
  it("reserves rich mutations for the AIRIS agent tool surface", async () => {
    const workspace = new Workspace({
      filesystem: new LocalFilesystem({ basePath: process.cwd() }),
      tools: createIrisWorkspaceToolsConfig(),
    });

    const tools = await createWorkspaceTools(workspace);
    const names = Object.keys(tools);

    expect(names).toEqual(
      expect.arrayContaining([
        "readFile",
        "listDirectory",
        "grepSearch",
        "deleteFile",
        "createDirectory",
      ]),
    );
    expect(names).not.toEqual(
      expect.arrayContaining([
        "writeFile",
        "editFile",
        "mastra_workspace_read_file",
        "mastra_workspace_list_files",
        "mastra_workspace_grep",
        "mastra_workspace_write_file",
        "mastra_workspace_edit_file",
        "mastra_workspace_delete",
        "mastra_workspace_mkdir",
      ]),
    );
  });
});