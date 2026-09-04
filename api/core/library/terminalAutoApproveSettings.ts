import { escapeRegExp } from "./regexEscape";

export type TerminalAutoApproveRuleValue =
  | boolean
  | {
      approve: boolean;
      matchCommandLine?: boolean;
    };

export type TerminalAutoApproveRules = Record<string, TerminalAutoApproveRuleValue>;

export const TERMINAL_AUTO_APPROVE_RULES_STORAGE_KEY =
  "settings.terminalAutoApproveRulesJson";

export const TERMINAL_AUTO_APPROVE_RULES_SETTING_ID =
  "terminalAutoApproveRulesJson";

const WRAPPER_PROGRAMS = new Set([
  "sudo",
  "doas",
  "time",
  "command",
  "builtin",
  "exec",
  "nice",
  "ionice",
  "nohup",
  "env",
  "xargs",
  "stdbuf",
  "unbuffer",
  "script",
  "timeout",
]);

const SHELL_PROGRAMS = new Set([
  "bash",
  "sh",
  "zsh",
  "fish",
  "ksh",
  "csh",
  "tcsh",
  "dash",
  "pwsh",
  "powershell",
  "powershell.exe",
  "cmd",
  "cmd.exe",
]);

const NEVER_AUTO_APPROVE_COMMANDS = new Set([
  "bash",
  "sh",
  "zsh",
  "fish",
  "ksh",
  "csh",
  "tcsh",
  "dash",
  "pwsh",
  "powershell",
  "powershell.exe",
  "cmd",
  "cmd.exe",
  "python",
  "python3",
  "node",
  "ruby",
  "perl",
  "php",
  "lua",
  "eval",
  "exec",
  "source",
  "sudo",
  "su",
  "doas",
  "curl",
  "wget",
  "invoke-restmethod",
  "invoke-webrequest",
  "irm",
  "iwr",
]);

const COMMANDS_WITH_SUBCOMMANDS = new Set([
  "git",
  "npm",
  "npx",
  "yarn",
  "docker",
  "kubectl",
  "cargo",
  "dotnet",
  "mvn",
  "gradle",
]);

const COMMANDS_WITH_SUB_SUB_COMMANDS = new Set(["npm run", "yarn run"]);

const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=.*$/;

function getPreviousNonWhitespaceChar(input: string, index: number): string | undefined {
  for (let cursor = index; cursor >= 0; cursor--) {
    const char = input[cursor];
    if (!/\s/.test(char)) {
      return char;
    }
  }

  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeCommandKeyword(token: string | undefined): string | undefined {
  if (!token) {
    return undefined;
  }

  const unquoted = token.replace(/^['"]|['"]$/g, "");
  if (!unquoted) {
    return undefined;
  }

  const parts = unquoted.split(/[\\/]/);
  const base = parts[parts.length - 1]?.toLowerCase() ?? "";
  const normalized = base.replace(/\.(?:exe|cmd|bat|ps1)$/i, "");
  return normalized || undefined;
}

function splitSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;

  const push = () => {
    const trimmed = current.trim();
    if (trimmed) {
      segments.push(trimmed);
    }
    current = "";
  };

  for (let index = 0; index < command.length; index++) {
    const char = command[index];

    if (inSingle) {
      current += char;
      if (char === "'") {
        inSingle = false;
      }
      continue;
    }

    if (inDouble) {
      if (char === "\\" && index + 1 < command.length) {
        current += char + command[index + 1];
        index++;
        continue;
      }
      current += char;
      if (char === '"') {
        inDouble = false;
      }
      continue;
    }

    if (char === "\\" && index + 1 < command.length) {
      current += char + command[index + 1];
      index++;
      continue;
    }

    if (char === "'") {
      inSingle = true;
      current += char;
      continue;
    }

    if (char === '"') {
      inDouble = true;
      current += char;
      continue;
    }

    if (char === "|" || char === ";") {
      if (command[index + 1] === "|" || command[index + 1] === "&") {
        push();
        index++;
        continue;
      }
      push();
      continue;
    }

    if (char === "&" && command[index + 1] === "&") {
      push();
      index++;
      continue;
    }

    if (char === "&") {
      const prev = getPreviousNonWhitespaceChar(command, index - 1);
      const next = command[index + 1];
      const isRedirectAmpersand = prev === ">" || prev === "<" || next === ">";

      if (!isRedirectAmpersand) {
        push();
        continue;
      }
    }

    current += char;
  }

  push();
  return segments;
}

function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let hasContent = false;

  for (let index = 0; index < segment.length; index++) {
    const char = segment[index];

    if (inSingle) {
      if (char === "'") {
        inSingle = false;
      } else {
        current += char;
      }
      continue;
    }

    if (inDouble) {
      if (char === "\\" && index + 1 < segment.length) {
        const next = segment[index + 1];
        if (next === "\\" || next === '"' || next === "$" || next === "`") {
          current += next;
          index++;
          continue;
        }
      }

      if (char === '"') {
        inDouble = false;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "\\" && index + 1 < segment.length) {
      current += segment[index + 1];
      index++;
      hasContent = true;
      continue;
    }

    if (char === "'") {
      inSingle = true;
      hasContent = true;
      continue;
    }

    if (char === '"') {
      inDouble = true;
      hasContent = true;
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0 || hasContent) {
        tokens.push(current);
        current = "";
        hasContent = false;
      }
      continue;
    }

    current += char;
    hasContent = true;
  }

  if (current.length > 0 || hasContent) {
    tokens.push(current);
  }

  return tokens;
}

function stripPrefixesAndWrappers(rawTokens: readonly string[]): string[] {
  let index = 0;

  while (index < rawTokens.length && ENV_ASSIGN_RE.test(rawTokens[index])) {
    index++;
  }

  while (index < rawTokens.length) {
    const token = normalizeCommandKeyword(rawTokens[index]);
    if (!token || !WRAPPER_PROGRAMS.has(token)) {
      break;
    }

    index++;

    while (index < rawTokens.length) {
      const next = rawTokens[index];
      if (next === "--") {
        index++;
        break;
      }
      if (next.startsWith("-")) {
        index++;
        continue;
      }
      if (ENV_ASSIGN_RE.test(next)) {
        index++;
        continue;
      }
      if ((token === "timeout" || token === "nice" || token === "ionice") && /^\d/.test(next)) {
        index++;
        continue;
      }
      break;
    }
  }

  return rawTokens.slice(index);
}

function extractShellCommand(tokens: readonly string[]): string | undefined {
  const head = normalizeCommandKeyword(tokens[0]);
  if (!head || !SHELL_PROGRAMS.has(head)) {
    return undefined;
  }

  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token) {
      continue;
    }

    if (/^--(?:command)$/i.test(token) || /^-(?:c|Command)$/i.test(token)) {
      return tokens[index + 1];
    }

    if (/^-[A-Za-z]+$/.test(token) && token.toLowerCase().includes("c")) {
      return tokens[index + 1];
    }
  }

  return undefined;
}

function extractEffectiveCommands(commandLine: string, depth = 0): string[] {
  if (depth > 8) {
    return [];
  }

  const commands: string[] = [];

  for (const segment of splitSegments(commandLine)) {
    const rawTokens = tokenize(segment);
    const tokens = stripPrefixesAndWrappers(rawTokens);
    if (tokens.length === 0) {
      continue;
    }

    const nested = extractShellCommand(tokens);
    if (nested) {
      commands.push(...extractEffectiveCommands(nested, depth + 1));
      continue;
    }

    commands.push(tokens.join(" "));
  }

  return commands;
}

function isNavigationOnlyCommand(command: string): boolean {
  return /^(cd|set-location)\b/i.test(command.trim());
}

function findNextNonFlagArg(parts: string[], startIndex: number): number | undefined {
  for (let index = startIndex; index < parts.length; index++) {
    if (!parts[index].startsWith("-")) {
      return index;
    }
  }

  return undefined;
}

export function sanitizeTerminalAutoApproveRules(
  input: unknown,
): TerminalAutoApproveRules | undefined {
  if (!isPlainObject(input)) {
    return undefined;
  }

  const normalized: TerminalAutoApproveRules = {};

  for (const [key, value] of Object.entries(input)) {
    const trimmedKey = key.trim();
    if (!trimmedKey) {
      continue;
    }

    if (typeof value === "boolean") {
      normalized[trimmedKey] = value;
      continue;
    }

    if (
      isPlainObject(value) &&
      typeof value.approve === "boolean" &&
      (value.matchCommandLine === undefined ||
        typeof value.matchCommandLine === "boolean")
    ) {
      normalized[trimmedKey] = value.matchCommandLine === true
        ? { approve: value.approve, matchCommandLine: true }
        : { approve: value.approve };
    }
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function parseTerminalAutoApproveRulesJson(raw: string | undefined | null): {
  rules?: TerminalAutoApproveRules;
  error?: string;
} {
  const trimmed = raw?.trim() || "";
  if (!trimmed) {
    return {};
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const rules = sanitizeTerminalAutoApproveRules(parsed);
    if (!rules) {
      return {
        error:
          "Rules must be a JSON object whose values are booleans or { approve, matchCommandLine } objects.",
      };
    }
    return { rules };
  } catch (error) {
    return {
      error: (error as Error).message || "Invalid JSON",
    };
  }
}

export function getStoredTerminalAutoApproveRules(
  storage: Pick<Storage, "getItem"> | null | undefined =
    typeof window !== "undefined" ? window.localStorage : null,
): TerminalAutoApproveRules | undefined {
  if (!storage) {
    return undefined;
  }

  try {
    const raw = storage.getItem(TERMINAL_AUTO_APPROVE_RULES_STORAGE_KEY);
    return parseTerminalAutoApproveRulesJson(raw).rules;
  } catch {
    return undefined;
  }
}

export function buildExactCommandLineAutoApproveRuleKey(commandLine: string): string {
  const trimmed = commandLine.trim();
  return `/^${escapeRegExp(trimmed)}$/`;
}

export function suggestTerminalAutoApproveRule(
  commandLine: string,
): { ruleKey: string; ruleValue: TerminalAutoApproveRuleValue; strategy: "exact" | "narrow" } {
  const trimmed = commandLine.trim();
  if (!trimmed) {
    return {
      ruleKey: buildExactCommandLineAutoApproveRuleKey(commandLine),
      ruleValue: { approve: true, matchCommandLine: true },
      strategy: "exact",
    };
  }

  const effectiveCommands = extractEffectiveCommands(trimmed).filter(
    (command) => !isNavigationOnlyCommand(command),
  );

  if (effectiveCommands.length !== 1) {
    return {
      ruleKey: buildExactCommandLineAutoApproveRuleKey(trimmed),
      ruleValue: { approve: true, matchCommandLine: true },
      strategy: "exact",
    };
  }

  const parts = effectiveCommands[0].trim().split(/\s+/);
  const baseCommand = parts[0]?.toLowerCase();

  if (!baseCommand || NEVER_AUTO_APPROVE_COMMANDS.has(baseCommand)) {
    return {
      ruleKey: buildExactCommandLineAutoApproveRuleKey(trimmed),
      ruleValue: { approve: true, matchCommandLine: true },
      strategy: "exact",
    };
  }

  if (COMMANDS_WITH_SUBCOMMANDS.has(baseCommand)) {
    const subCommandIndex = findNextNonFlagArg(parts, 1);
    if (subCommandIndex !== undefined) {
      const baseSubCommand = `${parts[0]} ${parts[subCommandIndex]}`.toLowerCase();
      if (COMMANDS_WITH_SUB_SUB_COMMANDS.has(baseSubCommand)) {
        const subSubCommandIndex = findNextNonFlagArg(parts, subCommandIndex + 1);
        if (subSubCommandIndex !== undefined) {
          return {
            ruleKey: parts.slice(0, subSubCommandIndex + 1).join(" "),
            ruleValue: true,
            strategy: "narrow",
          };
        }
      }

      return {
        ruleKey: parts.slice(0, subCommandIndex + 1).join(" "),
        ruleValue: true,
        strategy: "narrow",
      };
    }
  }

  return {
    ruleKey: parts[0],
    ruleValue: true,
    strategy: "narrow",
  };
}

export function saveExactTerminalAutoApproveRule(
  commandLine: string,
  storage: Pick<Storage, "getItem" | "setItem"> | null | undefined =
    typeof window !== "undefined" ? window.localStorage : null,
): { ruleKey: string; rules: TerminalAutoApproveRules; rawValue: string } | undefined {
  const trimmed = commandLine.trim();
  if (!trimmed || !storage) {
    return undefined;
  }

  const existing = getStoredTerminalAutoApproveRules(storage) || {};
  const ruleKey = buildExactCommandLineAutoApproveRuleKey(trimmed);
  const rules: TerminalAutoApproveRules = {
    ...existing,
    [ruleKey]: {
      approve: true,
      matchCommandLine: true,
    },
  };
  const rawValue = JSON.stringify(rules, null, 2);
  storage.setItem(TERMINAL_AUTO_APPROVE_RULES_STORAGE_KEY, rawValue);

  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("settingsChanged", {
        detail: {
          key: TERMINAL_AUTO_APPROVE_RULES_SETTING_ID,
          value: rawValue,
          settings: {
            [TERMINAL_AUTO_APPROVE_RULES_SETTING_ID]: rawValue,
          },
        },
      }),
    );
  }

  return { ruleKey, rules, rawValue };
}

export function saveTerminalAutoApproveRule(
  commandLine: string,
  storage: Pick<Storage, "getItem" | "setItem"> | null | undefined =
    typeof window !== "undefined" ? window.localStorage : null,
): {
  ruleKey: string;
  ruleValue: TerminalAutoApproveRuleValue;
  rules: TerminalAutoApproveRules;
  rawValue: string;
  strategy: "exact" | "narrow";
} | undefined {
  const trimmed = commandLine.trim();
  if (!trimmed || !storage) {
    return undefined;
  }

  const existing = getStoredTerminalAutoApproveRules(storage) || {};
  const suggestion = suggestTerminalAutoApproveRule(trimmed);
  const rules: TerminalAutoApproveRules = {
    ...existing,
    [suggestion.ruleKey]: suggestion.ruleValue,
  };
  const rawValue = JSON.stringify(rules, null, 2);
  storage.setItem(TERMINAL_AUTO_APPROVE_RULES_STORAGE_KEY, rawValue);

  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("settingsChanged", {
        detail: {
          key: TERMINAL_AUTO_APPROVE_RULES_SETTING_ID,
          value: rawValue,
          settings: {
            [TERMINAL_AUTO_APPROVE_RULES_SETTING_ID]: rawValue,
          },
        },
      }),
    );
  }

  return {
    ruleKey: suggestion.ruleKey,
    ruleValue: suggestion.ruleValue,
    rules,
    rawValue,
    strategy: suggestion.strategy,
  };
}

export function getTerminalAutoApproveRulesFingerprint(
  rules: TerminalAutoApproveRules | undefined,
): string {
  if (!rules) {
    return "";
  }

  const entries = Object.entries(rules)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => [
      key,
      typeof value === "boolean"
        ? value
        : {
            approve: value.approve,
            ...(value.matchCommandLine === true
              ? { matchCommandLine: true }
              : {}),
          },
    ]);

  return JSON.stringify(entries);
}