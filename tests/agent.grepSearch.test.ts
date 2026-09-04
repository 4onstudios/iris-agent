import fs from "fs/promises";
import os from "os";
import path from "path";
import { grepSearch } from "../api/core/agent/tools/grepSearch";

describe("grepSearch robustness", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "iris-grep-search-"));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("falls back to literal matching when regex is invalid", async () => {
    await fs.writeFile(path.join(tempRoot, "code.py"), "def hello(world):\n    pass\n", "utf8");

    const result = await grepSearch({
      searchText: "hello(",
      filePattern: "**/*.py",
      cwd: tempRoot,
      regex: true,
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("Expected successful grep search");
    }

    expect(result.totalMatches).toBe(1);
    expect(result.note).toContain("literal text");
    expect(result.results[0]?.matches[0]?.matches[0]?.text).toBe("hello(");
  });

  it("skips binary files while still matching text files", async () => {
    await fs.writeFile(path.join(tempRoot, "text.ts"), "const target = 1;\n", "utf8");
    await fs.writeFile(path.join(tempRoot, "binary.bin"), Buffer.from([0x00, 0x01, 0x02, 0x03]));

    const result = await grepSearch({
      searchText: "target",
      filePattern: "**/*",
      cwd: tempRoot,
      regex: false,
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("Expected successful grep search");
    }

    expect(result.totalMatches).toBe(1);
    expect(result.skippedBinaryFiles).toBeGreaterThanOrEqual(1);
    expect(result.results.some((entry) => entry.relativePath.endsWith("text.ts"))).toBe(true);
  });
});
