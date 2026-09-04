import fs from "fs/promises";
import path from "path";
import { glob } from "glob";
import { z } from "zod";
import { escapeRegExp } from "../../library/regexEscape";

type GrepSearchParams = {
  searchText: string;
  filePattern?: string;
  cwd?: string;
  caseSensitive?: boolean;
  regex?: boolean;
  includeLineNumbers?: boolean;
  contextLines?: number;
  maxResults?: number;
};

type ContextLine = {
  lineNumber: number;
  line: string;
};

type LineMatch = {
  text: string;
  index: number;
};

type GrepMatch = {
  lineNumber: number;
  line: string;
  matches: LineMatch[];
  before?: ContextLine[];
  after?: ContextLine[];
};

type GrepFileResult = {
  file: string;
  relativePath: string;
  matchCount: number;
  matches: GrepMatch[];
};

type GrepSearchSuccessResult = {
  success: true;
  searchText: string;
  pattern: string;
  caseSensitive: boolean;
  regex: boolean;
  note?: string;
  totalFiles: number;
  filesWithMatches: number;
  totalMatches: number;
  skippedBinaryFiles: number;
  results: GrepFileResult[];
};

type GrepSearchErrorResult = {
  success: false;
  error: string;
};

type GrepSearchResult = GrepSearchSuccessResult | GrepSearchErrorResult;

const isProbablyBinary = (data: Buffer): boolean => {
  if (data.length === 0) {
    return false;
  }

  // Null bytes are a strong signal for binary data.
  if (data.includes(0)) {
    return true;
  }

  const sampleLength = Math.min(data.length, 1024);
  let suspiciousBytes = 0;

  for (let i = 0; i < sampleLength; i++) {
    const byte = data[i];
    const isTab = byte === 9;
    const isNewline = byte === 10;
    const isCarriageReturn = byte === 13;
    const isPrintableAscii = byte >= 32 && byte <= 126;

    if (!isTab && !isNewline && !isCarriageReturn && !isPrintableAscii) {
      suspiciousBytes += 1;
    }
  }

  return suspiciousBytes / sampleLength > 0.3;
};

/**
 * Tool for searching text content across files (like grep)
 * @param {Object} params - The parameters for grep search
 * @param {string} params.searchText - The text to search for
 * @param {string} [params.filePattern] - Glob pattern for files to search
 * @param {string} [params.cwd] - Current working directory for search
 * @param {boolean} [params.caseSensitive] - Whether search is case sensitive
 * @param {boolean} [params.regex] - Whether searchText is a regex pattern
 * @param {boolean} [params.includeLineNumbers] - Whether to include line numbers
 * @param {number} [params.contextLines] - Number of context lines to show before/after match
 * @param {number} [params.maxResults] - Maximum number of results to return
 * @returns {Promise<Object>} Object containing success status and search results or error
 */
export async function grepSearch({
  searchText,
  filePattern = "**/*",
  cwd = process.cwd(),
  caseSensitive = false,
  regex = false,
  includeLineNumbers = true,
  contextLines = 0,
  maxResults = 100,
}: GrepSearchParams): Promise<GrepSearchResult> {
  try {
    void includeLineNumbers;

    // Validate input
    if (!searchText) {
      return {
        success: false,
        error: "Search text is required",
      };
    }

    // Create search pattern
    let searchPattern: RegExp;
    let note: string | undefined;
    if (regex) {
      try {
        searchPattern = new RegExp(searchText, caseSensitive ? "g" : "gi");
      } catch (err) {
        void err;
        searchPattern = new RegExp(
          escapeRegExp(searchText),
          caseSensitive ? "g" : "gi",
        );
        note =
          "Search text treated as literal text (invalid regex). Use JavaScript regex syntax for regex search.";
      }
    } else {
      const escapedText = escapeRegExp(searchText);
      searchPattern = new RegExp(escapedText, caseSensitive ? "g" : "gi");
    }

    // Find matching files
    const files = await glob(filePattern, {
      cwd,
      absolute: true,
      nodir: true,
      ignore: [
        "**/node_modules/**",
        "**/dist/**",
        "**/build/**",
        "**/.git/**",
        "**/coverage/**",
        "**/.next/**",
        "**/out/**",
      ],
    });

    const results: GrepFileResult[] = [];
    let totalMatches = 0;
    let skippedBinaryFiles = 0;

    // Search through each file
    for (const file of files) {
      if (totalMatches >= maxResults) break;

      try {
        const rawContent = await fs.readFile(file);

        if (isProbablyBinary(rawContent)) {
          skippedBinaryFiles += 1;
          continue;
        }

        const content = rawContent.toString("utf8");
        const lines = content.split("\n");
        const fileMatches: GrepMatch[] = [];

        for (let i = 0; i < lines.length; i++) {
          if (totalMatches >= maxResults) break;

          const line = lines[i];
          const matches = [...line.matchAll(searchPattern)];

          if (matches.length > 0) {
            const match: GrepMatch = {
              lineNumber: i + 1,
              line: line,
              matches: matches.map((m) => ({
                text: m[0],
                index: m.index ?? 0,
              })),
            };

            // Add context lines if requested
            if (contextLines > 0) {
              match.before = [];
              match.after = [];

              for (let j = 1; j <= contextLines; j++) {
                if (i - j >= 0) {
                  match.before.unshift({
                    lineNumber: i - j + 1,
                    line: lines[i - j],
                  });
                }
                if (i + j < lines.length) {
                  match.after.push({
                    lineNumber: i + j + 1,
                    line: lines[i + j],
                  });
                }
              }
            }

            fileMatches.push(match);
            totalMatches++;
          }
        }

        if (fileMatches.length > 0) {
          results.push({
            file: file,
            relativePath: path.relative(cwd, file),
            matchCount: fileMatches.length,
            matches: fileMatches,
          });
        }
      } catch (err) {
        // Skip files that can't be read (binary, etc.)
        continue;
      }
    }

    return {
      success: true,
      searchText,
      pattern: filePattern,
      caseSensitive,
      regex,
      ...(note ? { note } : {}),
      totalFiles: files.length,
      filesWithMatches: results.length,
      totalMatches,
      skippedBinaryFiles,
      results,
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
export const grepSearchTool = {
  description: "Search for text content across files (like grep)",
  parameters: z.object({
    searchText: z.string().describe("The text to search for"),
    filePattern: z
      .string()
      .default("**/*")
      .describe("Glob pattern for files to search"),
    cwd: z
      .string()
      .default(process.cwd())
      .describe("Current working directory for search"),
    caseSensitive: z
      .boolean()
      .default(false)
      .describe("Whether search is case sensitive"),
    regex: z
      .boolean()
      .default(false)
      .describe("Whether searchText is a regex pattern"),
    includeLineNumbers: z
      .boolean()
      .default(true)
      .describe("Whether to include line numbers"),
    contextLines: z
      .number()
      .default(0)
      .describe("Number of context lines to show before/after match"),
    maxResults: z
      .number()
      .default(100)
      .describe("Maximum number of results to return"),
  }),
  execute: grepSearch,
};

export default grepSearchTool;
