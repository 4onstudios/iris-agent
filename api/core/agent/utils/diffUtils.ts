import path from "path";
import { diffLines } from "diff";

type DiffResult = {
  diff: string;
  linesAdded: number;
  linesRemoved: number;
};

type DiffPart = {
  value: string;
  added?: boolean;
  removed?: boolean;
};

/**
 * Generate a unified diff string from old and new content
 * @param {string} oldContent - The original content
 * @param {string} newContent - The modified content
 * @param {string} filePath - The file path (used for diff header)
 * @returns {{diff: string, linesAdded: number, linesRemoved: number}} Diff result with accurate line counts
 */
export function generateDiff(
  oldContent: string,
  newContent: string,
  filePath: string
): DiffResult {
  const changes = diffLines(oldContent, newContent) as DiffPart[];
  let diff = `--- a/${path.basename(filePath)}\n+++ b/${path.basename(
    filePath
  )}\n`;

  let linesAdded = 0;
  let linesRemoved = 0;

  changes.forEach((part: DiffPart) => {
    const lines = part.value
      .split("\n")
      .filter((line: string, idx: number, arr: string[]) => idx < arr.length - 1 || line !== "");

    if (part.added) {
      linesAdded += lines.length;
      lines.forEach((line: string) => {
        diff += `+${line}\n`;
      });
    } else if (part.removed) {
      linesRemoved += lines.length;
      lines.forEach((line: string) => {
        diff += `-${line}\n`;
      });
    } else {
      // Context lines (unchanged)
      lines.forEach((line: string) => {
        diff += ` ${line}\n`;
      });
    }
  });

  return { diff, linesAdded, linesRemoved };
}
