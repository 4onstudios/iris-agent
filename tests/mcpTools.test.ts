import { buildAugmentedPath } from "../api/core/agent/tools/mcpTools";

describe("MCP tool environment", () => {
  it("preserves configured PATH entries while adding standard executable paths", () => {
    const configuredPath = "/custom/mcp-bin:/usr/bin";
    const pathEntries = buildAugmentedPath(configuredPath).split(":");

    expect(pathEntries.slice(0, 2)).toEqual(configuredPath.split(":"));
    expect(pathEntries).toContain("/usr/local/bin");
  });
});
