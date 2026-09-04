import fs from "fs/promises";
import path from "path";
import { applyPatch, parsePatch } from "diff";
import { z } from "zod";
import { generateDiff } from "../utils/diffUtils";

type ApplyDiffParams = {
  filePath: string;
  patch: string;
};

type ApplyDiffSuccessResult = {
  success: true;
  filePath: string;
  fileExisted: boolean;
  size: number;
  modified: Date;
  linesAdded: number;
  linesRemoved: number;
  diff: string;
  oldContent: string;
  newContent: string;
};

type ApplyDiffErrorResult = {
  success: false;
  error: string;
  patch?: string;
  filePath?: string;
  parsedChanges?: number;
};

type ApplyDiffResult = ApplyDiffSuccessResult | ApplyDiffErrorResult;

type ParsedPatch = {
  oldFileName?: string;
  newFileName?: string;
  hunks?: unknown[];
};

const normalizeDiffPath = (input?: string): string => {
  if (!input) return "";

  const normalized = input.trim().replace(/\\/g, "/");
  if (normalized.startsWith("a/") || normalized.startsWith("b/")) {
    return normalized.slice(2);
  }

  return normalized;
};

const matchesTargetPath = (
  parsedPath: string,
  targetAbsolutePath: string,
): boolean => {
  if (!parsedPath || parsedPath === "/dev/null") return false;

  const normalizedParsed = parsedPath.replace(/\\/g, "/");
  const normalizedTarget = targetAbsolutePath.replace(/\\/g, "/");
  return (
    normalizedTarget.endsWith(`/${normalizedParsed}`) ||
    normalizedTarget === normalizedParsed
  );
};

/**
 * Tool for applying unified diff patches to files
 * @param {Object} params - The parameters for applying a diff
 * @param {string} params.filePath - The path to the file to patch
 * @param {string} params.patch - The unified diff patch to apply
 * @returns {Promise<Object>} Object containing success status and patch info or error
 */
export async function applyDiff({
  filePath,
  patch,
}: ApplyDiffParams): Promise<ApplyDiffResult> {
  try {
    if (!filePath || !patch) {
      return {
        success: false,
        error: "Both filePath and patch are required",
      };
    }

    const absolutePath = path.resolve(filePath);

    const parsedPatches = parsePatch(patch) as ParsedPatch[];
    if (parsedPatches.length === 0) {
      return {
        success: false,
        error: "Invalid unified diff: no patch sections found",
        patch,
        filePath: absolutePath,
      };
    }

    const targetPatch =
      parsedPatches.find((candidate) => {
        const oldName = normalizeDiffPath(candidate.oldFileName);
        const newName = normalizeDiffPath(candidate.newFileName);
        return (
          matchesTargetPath(oldName, absolutePath) ||
          matchesTargetPath(newName, absolutePath)
        );
      }) || parsedPatches[0];

    let oldContent = "";
    let existedBefore = false;
    try {
      oldContent = await fs.readFile(absolutePath, "utf8");
      existedBefore = true;
    } catch {
      oldContent = "";
      existedBefore = false;
    }

    const oldName = normalizeDiffPath(targetPatch.oldFileName);
    const newName = normalizeDiffPath(targetPatch.newFileName);
    const isDelete =
      oldName !== "/dev/null" && newName === "/dev/null";

    if (isDelete) {
      if (existedBefore) {
        await fs.unlink(absolutePath);
      }

      const { diff, linesAdded, linesRemoved } = generateDiff(
        oldContent,
        "",
        absolutePath,
      );

      return {
        success: true,
        filePath: absolutePath,
        fileExisted: existedBefore,
        size: 0,
        modified: new Date(),
        linesAdded,
        linesRemoved,
        diff,
        oldContent,
        newContent: "",
      };
    }

    const newContent = applyPatch(oldContent, patch);
    if (newContent === false) {
      return {
        success: false,
        error:
          "Failed to apply patch because file content no longer matches patch context",
        patch,
        filePath: absolutePath,
        parsedChanges: targetPatch.hunks?.length || 0,
      };
    }

    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, newContent, "utf8");
    const stats = await fs.stat(absolutePath);

    const { diff, linesAdded, linesRemoved } = generateDiff(
      oldContent,
      newContent,
      absolutePath,
    );

    return {
      success: true,
      filePath: absolutePath,
      fileExisted: existedBefore,
      size: stats.size,
      modified: stats.mtime,
      linesAdded,
      linesRemoved,
      diff,
      oldContent,
      newContent,
    };
  } catch (error) {
    const err = error as Error;
    return {
      success: false,
      error: err.message,
    };
  }
}

/**
 * Tool metadata for agent system
 */
export const applyDiffTool = {
  description:
    "Apply a unified diff patch to a file",
  parameters: z.object({
    filePath: z.string().describe("The path to the file to patch"),
    patch: z.string().describe("The unified diff patch to apply"),
  }),
  execute: applyDiff,
};

export default applyDiffTool;
