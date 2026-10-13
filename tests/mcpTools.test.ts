import { buildAugmentedPath } from "../api/core/agent/tools/mcpTools";
import { delimiter as pathDelimiter } from "node:path";

describe("MCP tool environment", () => {
  it("preserves configured PATH entries while adding standard executable paths", () => {
    const configuredPath = ["/custom/mcp-bin", "/usr/bin"].join(pathDelimiter);
    const pathEntries = buildAugmentedPath(configuredPath).split(pathDelimiter);

    expect(pathEntries.slice(0, 2)).toEqual(configuredPath.split(pathDelimiter));
    expect(pathEntries).toContain("/usr/local/bin");
  });
});
