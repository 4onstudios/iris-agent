import fs from "fs/promises";
import path from "path";
import { glob } from "glob";

type RepoMapEntry = {
  absolutePath: string;
  relativePath: string;
  relativePathLower: string;
  baseNameLower: string;
  symbols: string[];
};

type RepoMapCache = {
  builtAt: number;
  entries: RepoMapEntry[];
};

const REPO_MAP_TTL_MS = 30_000;
const MAX_INDEX_FILES = 2_000;
const MAX_FILE_SIZE_BYTES = 512 * 1024;

const cache = new Map<string, RepoMapCache>();

const SOURCE_PATTERNS = [
  "src/**/*.{ts,tsx,js,jsx,mjs,cjs,json,md,css,scss,yml,yaml}",
  "api/**/*.{ts,tsx,js,jsx,mjs,cjs,json,md,yml,yaml}",
  "tests/**/*.{ts,tsx,js,jsx,mjs,cjs,json,md}",
  "*.{ts,tsx,js,jsx,mjs,cjs,json,md,yml,yaml}",
  ".*",
];

const SYMBOL_PATTERNS: RegExp[] = [
  /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\b/g,
  /\b(?:export\s+)?class\s+([A-Za-z_$][\w$]*)\b/g,
  /\b(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)\b/g,
  /\b(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\b/g,
  /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g,
  /\b(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)\b/g,
];

const tokenizeQuery = (value: string): string[] =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9_./-]+/g, " ")
    .split(/[\s/._-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);

const normalizeRelativeInputPath = (value: string): string =>
  value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\//, "");

const unique = <T>(items: T[]): T[] => Array.from(new Set(items));

const extractSymbols = (content: string): string[] => {
  const symbols = new Set<string>();

  for (const pattern of SYMBOL_PATTERNS) {
    pattern.lastIndex = 0;
    let match = pattern.exec(content);
    while (match) {
      const candidate = match[1]?.trim();
      if (candidate) {
        symbols.add(candidate);
      }
      match = pattern.exec(content);
    }
  }

  return Array.from(symbols);
};

const buildRepoMap = async (workspaceRoot: string): Promise<RepoMapEntry[]> => {
  const discovered = await glob(SOURCE_PATTERNS, {
    cwd: workspaceRoot,
    absolute: true,
    nodir: true,
    dot: true,
    follow: false,
    ignore: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/.git/**",
      "**/coverage/**",
      "**/target/**",
    ],
  });

  const selectedFiles = unique(discovered).slice(0, MAX_INDEX_FILES);
  const entries: RepoMapEntry[] = [];

  for (const absolutePath of selectedFiles) {
    try {
      const stats = await fs.stat(absolutePath);
      if (!stats.isFile() || stats.size > MAX_FILE_SIZE_BYTES) {
        continue;
      }

      const content = await fs.readFile(absolutePath, "utf8");
      const relativePath = path.relative(workspaceRoot, absolutePath);
      entries.push({
        absolutePath,
        relativePath,
        relativePathLower: relativePath.replace(/\\/g, "/").toLowerCase(),
        baseNameLower: path.basename(absolutePath).toLowerCase(),
        symbols: extractSymbols(content),
      });
    } catch {
      // Ignore unreadable files and continue indexing.
    }
  }

  return entries;
};

const getRepoMapEntries = async (workspaceRoot: string): Promise<RepoMapEntry[]> => {
  const now = Date.now();
  const cached = cache.get(workspaceRoot);
  if (cached && now - cached.builtAt < REPO_MAP_TTL_MS) {
    return cached.entries;
  }

  const entries = await buildRepoMap(workspaceRoot);
  cache.set(workspaceRoot, {
    builtAt: now,
    entries,
  });

  return entries;
};

const scoreEntry = (
  entry: RepoMapEntry,
  query: string,
  normalizedQuery: string,
  tokens: string[],
): number => {
  let score = 0;
  const queryLower = query.toLowerCase();
  const rel = entry.relativePathLower;

  if (normalizedQuery && rel === normalizedQuery.toLowerCase()) {
    score += 1000;
  }

  if (normalizedQuery && rel.endsWith(`/${normalizedQuery.toLowerCase()}`)) {
    score += 400;
  }

  const queryBase = path.basename(normalizedQuery || query).toLowerCase();
  if (queryBase && entry.baseNameLower === queryBase) {
    score += 180;
  }

  if (queryLower && entry.baseNameLower.includes(queryLower)) {
    score += 80;
  }

  for (const token of tokens) {
    if (entry.baseNameLower.includes(token)) {
      score += 24;
    }
    if (rel.includes(token)) {
      score += 10;
    }
    for (const symbol of entry.symbols) {
      const symbolLower = symbol.toLowerCase();
      if (symbolLower === token) {
        score += 50;
      } else if (symbolLower.includes(token)) {
        score += 20;
      }
    }
  }

  return score;
};

export const findFilesViaRepoMap = async (
  workspaceRoot: string,
  query: string,
  limit = 10,
): Promise<string[]> => {
  const normalizedQuery = normalizeRelativeInputPath(query);
  const tokens = tokenizeQuery(query);

  if (!normalizedQuery && tokens.length === 0) {
    return [];
  }

  const entries = await getRepoMapEntries(workspaceRoot);
  const ranked = entries
    .map((entry) => ({
      entry,
      score: scoreEntry(entry, query, normalizedQuery, tokens),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, limit));

  return ranked.map((candidate) => candidate.entry.absolutePath);
};

export const rankFileCandidates = async (
  workspaceRoot: string,
  query: string,
  candidates: string[],
): Promise<string[]> => {
  if (candidates.length <= 1) {
    return candidates;
  }

  const normalizedQuery = normalizeRelativeInputPath(query);
  const tokens = tokenizeQuery(query);
  const entries = await getRepoMapEntries(workspaceRoot);
  const entryByPath = new Map(entries.map((entry) => [entry.absolutePath, entry]));

  const scored = candidates.map((absolutePath) => {
    const entry = entryByPath.get(absolutePath);
    if (entry) {
      return {
        absolutePath,
        score: scoreEntry(entry, query, normalizedQuery, tokens),
      };
    }

    const relativePathLower = path
      .relative(workspaceRoot, absolutePath)
      .replace(/\\/g, "/")
      .toLowerCase();
    const baseNameLower = path.basename(absolutePath).toLowerCase();
    let score = 0;

    if (normalizedQuery && relativePathLower === normalizedQuery.toLowerCase()) {
      score += 1000;
    }
    if (normalizedQuery && relativePathLower.endsWith(`/${normalizedQuery.toLowerCase()}`)) {
      score += 400;
    }

    const queryBase = path.basename(normalizedQuery || query).toLowerCase();
    if (queryBase && baseNameLower === queryBase) {
      score += 180;
    }

    for (const token of tokens) {
      if (baseNameLower.includes(token)) score += 24;
      if (relativePathLower.includes(token)) score += 10;
    }

    return { absolutePath, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.map((candidate) => candidate.absolutePath);
};

export const clearRepoMapCache = (): void => {
  cache.clear();
};
