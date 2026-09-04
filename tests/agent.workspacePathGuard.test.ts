import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  isWorkspaceMutationPathAllowed,
  rejectUnsafeWorkspaceMutation,
} from "../api/core/agent/utils/workspacePathGuard";

describe("workspace mutation path guard", () => {
  let workspacePath: string;
  let outsidePath: string;

  beforeEach(async () => {
    workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "iris-workspace-"));
    outsidePath = await fs.mkdtemp(path.join(os.tmpdir(), "iris-outside-"));
  });

  afterEach(async () => {
    await fs.rm(workspacePath, { recursive: true, force: true });
    await fs.rm(outsidePath, { recursive: true, force: true });
  });

  it("allows paths inside the workspace and rejects traversal or absolute escapes", async () => {
    expect(
      await isWorkspaceMutationPathAllowed(workspacePath, path.join(workspacePath, "src", "file.ts")),
    ).toBe(true);
    expect(
      await isWorkspaceMutationPathAllowed(workspacePath, path.join(workspacePath, "..", "outside.ts")),
    ).toBe(false);
    expect(await isWorkspaceMutationPathAllowed(workspacePath, outsidePath)).toBe(false);
  });

  it("rejects existing symlink targets and new files beneath symlinked directories", async () => {
    const outsideFile = path.join(outsidePath, "secret.txt");
    const linkPath = path.join(workspacePath, "linked");
    await fs.writeFile(outsideFile, "secret", "utf8");
    await fs.symlink(outsidePath, linkPath, "dir");

    expect(await isWorkspaceMutationPathAllowed(workspacePath, path.join(linkPath, "secret.txt"))).toBe(false);
    expect(await isWorkspaceMutationPathAllowed(workspacePath, path.join(linkPath, "new.txt"))).toBe(false);
  });

  it("rejects a dangling final symlink that points outside the workspace", async () => {
    const outsideFile = path.join(outsidePath, "new.txt");
    const linkPath = path.join(workspacePath, "link.txt");
    await fs.symlink(outsideFile, linkPath, "file");

    expect(await isWorkspaceMutationPathAllowed(workspacePath, linkPath)).toBe(false);
  });

  it("rejects a new file beneath a dangling intermediate symlink", async () => {
    const missingOutsideDirectory = path.join(outsidePath, "missing");
    const linkPath = path.join(workspacePath, "link");
    await fs.symlink(missingOutsideDirectory, linkPath, "dir");

    expect(
      await isWorkspaceMutationPathAllowed(
        workspacePath,
        path.join(linkPath, "new.txt"),
      ),
    ).toBe(false);
  });

  it.each(["/etc/iris-test", "../../outside.txt"])(
    "rejects server-side mutation %s for virtual workspaces",
    async (filePath) => {
      await expect(
        rejectUnsafeWorkspaceMutation("/workspace/project", true, [filePath]),
      ).resolves.toEqual({
        success: false,
        error:
          "Server-side filesystem mutations are disabled for virtual workspaces",
      });
    },
  );
});
