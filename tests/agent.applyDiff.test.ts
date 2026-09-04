import fs from "fs/promises";
import os from "os";
import path from "path";
import { applyDiff } from "../api/core/agent/tools/applyDiff";

describe("applyDiff tool", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "iris-apply-diff-"));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("applies unified diff updates to an existing file", async () => {
    const filePath = path.join(tempRoot, "src", "message.txt");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "hello\nworld\n", "utf8");

    const patch = [
      "--- a/src/message.txt",
      "+++ b/src/message.txt",
      "@@ -1,2 +1,2 @@",
      " hello",
      "-world",
      "+iris",
      "",
    ].join("\n");

    const result = await applyDiff({ filePath, patch });

    if (result.success !== true) {
      throw new Error(result.error || "applyDiff failed unexpectedly");
    }

    const content = await fs.readFile(filePath, "utf8");
    expect(content).toBe("hello\niris\n");
    expect(result.linesAdded).toBe(1);
    expect(result.linesRemoved).toBe(1);
  });

  it("creates a new file from a /dev/null unified diff", async () => {
    const filePath = path.join(tempRoot, "new-file.txt");

    const patch = [
      "--- /dev/null",
      "+++ b/new-file.txt",
      "@@ -0,0 +1,2 @@",
      "+first",
      "+second",
      "",
    ].join("\n");

    const result = await applyDiff({ filePath, patch });

    if (result.success !== true) {
      throw new Error(result.error || "applyDiff failed unexpectedly");
    }

    const content = await fs.readFile(filePath, "utf8");
    expect(content).toBe("first\nsecond\n");
  });
});
