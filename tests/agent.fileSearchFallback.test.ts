import fs from "fs/promises";
import os from "os";
import path from "path";
import { readFile as readFileToolExecute } from "../api/core/agent/tools/readFile";
import { searchFiles as searchFilesToolExecute } from "../api/core/agent/tools/searchFiles";

describe("agent file tool terminal fallback", () => {
  let tempRoot: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "iris-file-tools-"));
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("finds hidden files with searchFiles pattern lookup", async () => {
    const nestedDir = path.join(tempRoot, "config");
    const dotEnvPath = path.join(nestedDir, ".env");

    await fs.mkdir(nestedDir, { recursive: true });
    await fs.writeFile(dotEnvPath, "API_KEY=test\n", "utf8");

    const result = await searchFilesToolExecute({
      pattern: ".env",
      cwd: tempRoot,
    });

    expect(result.success).toBe(true);
    if (!result.success || !("files" in result)) {
      throw new Error("Expected successful search result with files");
    }

    expect(result.files.some((file) => file.path === dotEnvPath)).toBe(true);
    expect(result.resolvedBy).toBe("glob");
  });

  it("recovers missing direct file path via terminal find fallback", async () => {
    const nestedDir = path.join(tempRoot, "apps", "web");
    const dotEnvPath = path.join(nestedDir, ".env");

    await fs.mkdir(nestedDir, { recursive: true });
    await fs.writeFile(dotEnvPath, "DATABASE_URL=sqlite://tmp\n", "utf8");

    const result = await searchFilesToolExecute({
      filePath: ".env",
      cwd: tempRoot,
    });

    expect(result.success).toBe(true);
    if (!result.success || !("filePath" in result) || !("content" in result)) {
      throw new Error("Expected successful file read result");
    }

    expect(result.filePath).toBe(dotEnvPath);
    expect(result.content).toContain("DATABASE_URL=");
    expect(["repo_map", "terminal_find"]).toContain(result.resolvedBy);
  });

  it("readFile recovers missing direct file path via terminal find fallback", async () => {
    const nestedDir = path.join(tempRoot, "services", "api");
    const envPath = path.join(nestedDir, ".env");

    await fs.mkdir(nestedDir, { recursive: true });
    await fs.writeFile(envPath, "PORT=3000\n", "utf8");

    process.chdir(tempRoot);

    const result = await readFileToolExecute({
      filePath: ".env",
      parseWithKnowledgeGraph: false,
    });

    expect(result.success).toBe(true);
    if (!result.success || !("filePath" in result) || !("content" in result)) {
      throw new Error("Expected successful readFile result");
    }

    const expectedPath = await fs.realpath(envPath);
    const actualPath = await fs.realpath(result.filePath);

    expect(actualPath).toBe(expectedPath);
    expect(result.content).toContain("PORT=3000");
    expect(["repo_map", "terminal_find"]).toContain(result.resolvedBy);
  });

  it("supports readFile line ranges with default line numbers", async () => {
    const targetPath = path.join(tempRoot, "slice.txt");
    await fs.writeFile(targetPath, "line one\nline two\nline three\nline four\n", "utf8");

    process.chdir(tempRoot);

    const result = await readFileToolExecute({
      filePath: "slice.txt",
      parseWithKnowledgeGraph: false,
      startLine: 2,
      endLine: 3,
    });

    expect(result.success).toBe(true);
    if (!result.success || !("content" in result)) {
      throw new Error("Expected successful range read result");
    }

    expect(result.content).toBe("2:line two\n3:line three");
    expect(result.startLine).toBe(2);
    expect(result.endLine).toBe(3);
    expect(result.totalLines).toBe(5);
  });

  it("chunks large text reads and returns the next line range", async () => {
    const targetPath = path.join(tempRoot, "large.txt");
    await fs.writeFile(
      targetPath,
      Array.from({ length: 1200 }, (_, index) => `line ${index + 1}`).join("\n"),
      "utf8",
    );

    const firstChunk = await readFileToolExecute({
      filePath: targetPath,
      parseWithKnowledgeGraph: false,
    });

    expect(firstChunk.success).toBe(true);
    if (!firstChunk.success || !("content" in firstChunk)) {
      throw new Error("Expected successful chunked read result");
    }

    expect(firstChunk.content.split("\n")).toHaveLength(500);
    expect(firstChunk.startLine).toBe(1);
    expect(firstChunk.endLine).toBe(500);
    expect(firstChunk.totalLines).toBe(1200);
    expect(firstChunk.hasMore).toBe(true);
    expect(firstChunk.nextStartLine).toBe(501);
    expect(firstChunk.nextEndLine).toBe(1000);

    const secondChunk = await readFileToolExecute({
      filePath: targetPath,
      parseWithKnowledgeGraph: false,
      startLine: firstChunk.nextStartLine,
      endLine: 1200,
    });

    expect(secondChunk.success).toBe(true);
    if (!secondChunk.success || !("content" in secondChunk)) {
      throw new Error("Expected successful continuation read result");
    }

    expect(secondChunk.startLine).toBe(501);
    expect(secondChunk.endLine).toBe(1000);
    expect(secondChunk.nextStartLine).toBe(1001);
  });

  it("requires both startLine and endLine for readFile", async () => {
    const targetPath = path.join(tempRoot, "slice.txt");
    await fs.writeFile(targetPath, "line one\nline two\n", "utf8");

    process.chdir(tempRoot);

    const result = await readFileToolExecute({
      filePath: "slice.txt",
      parseWithKnowledgeGraph: false,
      startLine: 1,
    });

    expect(result.success).toBe(false);
    if (result.success || !("error" in result)) {
      throw new Error("Expected a validation error when endLine is missing");
    }

    expect(result.error).toContain("must be provided together");
  });

  it("allows readFile traversal outside workspace root when file is readable", async () => {
    const outsidePath = path.join(path.dirname(tempRoot), "outside-read.txt");
    await fs.writeFile(outsidePath, "outside\n", "utf8");

    process.chdir(tempRoot);

    const result = await readFileToolExecute({
      filePath: "../outside-read.txt",
      parseWithKnowledgeGraph: false,
    });

    expect(result.success).toBe(true);
    if (!result.success || !("content" in result) || !("filePath" in result)) {
      throw new Error("Expected successful traversal read");
    }

    const expectedPath = await fs.realpath(outsidePath);
    const actualPath = await fs.realpath(result.filePath);
    expect(actualPath).toBe(expectedPath);
    expect(result.content).toContain("outside");
    expect(result.resolvedBy).toBe("direct");
  });

  it("allows searchFiles traversal outside workspace root when file is readable", async () => {
    const outsidePath = path.join(path.dirname(tempRoot), "outside-search.txt");
    await fs.writeFile(outsidePath, "outside\n", "utf8");

    const result = await searchFilesToolExecute({
      filePath: "../outside-search.txt",
      cwd: tempRoot,
    });

    expect(result.success).toBe(true);
    if (!result.success || !("content" in result) || !("filePath" in result)) {
      throw new Error("Expected successful traversal read");
    }

    const expectedPath = await fs.realpath(outsidePath);
    const actualPath = await fs.realpath(result.filePath);
    expect(actualPath).toBe(expectedPath);
    expect(result.content).toContain("outside");
    expect(result.resolvedBy).toBe("direct");
  });

  it("recovers searchFiles absolute external path to matching workspace file", async () => {
    const nestedDir = path.join(tempRoot, "web", "webhooks");
    const localEventsPath = path.join(nestedDir, "events.py");
    const externalPath = "/external/repo/RenKap/web/webhooks/events.py";

    await fs.mkdir(nestedDir, { recursive: true });
    await fs.writeFile(localEventsPath, "def handler():\n    return 'ok'\n", "utf8");

    const result = await searchFilesToolExecute({
      filePath: externalPath,
      cwd: tempRoot,
    });

    expect(result.success).toBe(true);
    if (!result.success || !("filePath" in result) || !("content" in result)) {
      throw new Error("Expected successful file read result");
    }

    const localRealPath = await fs.realpath(localEventsPath);
    const actualPath = await fs.realpath(result.filePath);
    const acceptablePaths = [localRealPath];

    try {
      acceptablePaths.push(await fs.realpath(externalPath));
    } catch {
      // External fixture path may not exist in CI; workspace recovery remains valid.
    }

    expect(acceptablePaths).toContain(actualPath);
    if (actualPath === localRealPath) {
      expect(result.content).toContain("def handler()");
    } else {
      expect(result.content.length).toBeGreaterThan(0);
    }
    expect(["direct", "repo_map", "terminal_find"]).toContain(result.resolvedBy);
  });

  it("recovers readFile absolute external path to matching workspace file", async () => {
    const nestedDir = path.join(tempRoot, "web", "webhooks");
    const localEventsPath = path.join(nestedDir, "events.py");
    const externalPath = "/external/repo/RenKap/web/webhooks/events.py";

    await fs.mkdir(nestedDir, { recursive: true });
    await fs.writeFile(localEventsPath, "def receiver():\n    return 'ok'\n", "utf8");

    process.chdir(tempRoot);

    const result = await readFileToolExecute({
      filePath: externalPath,
      parseWithKnowledgeGraph: false,
    });

    expect(result.success).toBe(true);
    if (!result.success || !("filePath" in result) || !("content" in result)) {
      throw new Error("Expected successful readFile result");
    }

    const actualPath = await fs.realpath(result.filePath);
    const acceptablePaths = [await fs.realpath(localEventsPath)];

    try {
      acceptablePaths.push(await fs.realpath(externalPath));
    } catch {
      // External fixture path may not exist in CI; workspace recovery remains valid.
    }

    expect(acceptablePaths).toContain(actualPath);
    if (actualPath === acceptablePaths[0]) {
      expect(result.content).toContain("def receiver()");
    } else {
      expect(result.content.length).toBeGreaterThan(0);
    }
    expect(["direct", "repo_map", "terminal_find"]).toContain(result.resolvedBy);
  });

  it("uses provided workspaceRoot for readFile when process cwd points elsewhere", async () => {
    const nestedDir = path.join(tempRoot, "web", "webhooks");
    const localEventsPath = path.join(nestedDir, "models.py");
    const externalPath = "/external/repo/RenKap/web/webhooks/models.py";

    await fs.mkdir(nestedDir, { recursive: true });
    await fs.writeFile(localEventsPath, "class WebhookEvent:\n    pass\n", "utf8");

    const result = await readFileToolExecute({
      filePath: externalPath,
      workspaceRoot: tempRoot,
      parseWithKnowledgeGraph: false,
    });

    expect(result.success).toBe(true);
    if (!result.success || !("filePath" in result) || !("content" in result)) {
      throw new Error("Expected successful readFile result");
    }

    const actualPath = await fs.realpath(result.filePath);
    const acceptablePaths = [await fs.realpath(localEventsPath)];

    try {
      acceptablePaths.push(await fs.realpath(externalPath));
    } catch {
      // External fixture path may not exist in CI; workspace recovery remains valid.
    }

    expect(acceptablePaths).toContain(actualPath);
    if (actualPath === acceptablePaths[0]) {
      expect(result.content).toContain("class WebhookEvent");
    } else {
      expect(result.content.length).toBeGreaterThan(0);
    }
    expect(["direct", "repo_map", "terminal_find"]).toContain(result.resolvedBy);
  });

  it("treats leading slash glob as root-anchored", async () => {
    await fs.writeFile(path.join(tempRoot, "root.txt"), "root\n", "utf8");
    await fs.mkdir(path.join(tempRoot, "nested"), { recursive: true });
    await fs.writeFile(path.join(tempRoot, "nested", "root.txt"), "nested\n", "utf8");

    const result = await searchFilesToolExecute({
      pattern: "/root.txt",
      cwd: tempRoot,
    });

    expect(result.success).toBe(true);
    if (!result.success || !("files" in result)) {
      throw new Error("Expected successful pattern result");
    }

    const relativePaths = result.files.map((file) => file.relativePath).sort();
    expect(relativePaths).toEqual(["root.txt"]);
  });

  it("matches root file for double-star prefixed pattern", async () => {
    await fs.writeFile(path.join(tempRoot, "foo.bat"), "@echo off\n", "utf8");

    const result = await searchFilesToolExecute({
      pattern: "**/foo.bat",
      cwd: tempRoot,
    });

    expect(result.success).toBe(true);
    if (!result.success || !("files" in result)) {
      throw new Error("Expected successful pattern result");
    }

    const basenames = result.files.map((file) => path.basename(file.path));
    expect(basenames).toContain("foo.bat");
  });
});
