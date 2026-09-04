import fs from "fs/promises";
import os from "os";
import path from "path";
import { editFile } from "../api/core/agent/tools/editFile";

describe("editFile read-before-edit safety", () => {
  let tempDir: string;
  let filePath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "iris-edit-file-"));
    filePath = path.join(tempDir, "sample.txt");
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("rejects line-based edits without oldContent anchor", async () => {
    await fs.writeFile(filePath, "a\nb\nc\n", "utf8");

    const result = await editFile({
      filePath,
      startLine: 2,
      lineContent: "B",
    });

    expect(result.success).toBe(false);
    if ("error" in result) {
      expect(result.error).toContain("require oldContent");
    }
  });

  it("rejects line-based edits when oldContent does not match the current range", async () => {
    await fs.writeFile(filePath, "a\nb\nc\n", "utf8");

    const result = await editFile({
      filePath,
      startLine: 2,
      endLine: 3,
      oldContent: "b\nWRONG",
      lineContent: "B\nC",
    });

    expect(result.success).toBe(false);
    if ("error" in result) {
      expect(result.error).toContain("does not match oldContent");
    }
  });

  it("applies line-based edits when oldContent matches exactly", async () => {
    await fs.writeFile(filePath, "a\nb\nc\n", "utf8");

    const result = await editFile({
      filePath,
      startLine: 2,
      endLine: 3,
      oldContent: "b\nc",
      lineContent: "B\nC",
    });

    expect(result.success).toBe(true);
    expect(await fs.readFile(filePath, "utf8")).toBe("a\nB\nC\n");
  });

  it("rejects content replacement when oldContent is ambiguous", async () => {
    await fs.writeFile(filePath, "token\nvalue\ntoken\n", "utf8");

    const result = await editFile({
      filePath,
      oldContent: "token",
      newContent: "TOKEN",
    });

    expect(result.success).toBe(false);
    if ("error" in result) {
      expect(result.error).toContain("multiple times");
    }
  });
});
