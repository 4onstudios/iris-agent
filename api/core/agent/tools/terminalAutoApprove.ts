import type {
  TerminalAutoApproveRuleValue,
  TerminalAutoApproveRules,
} from "../../library/terminalAutoApproveSettings";
import { escapeRegExp } from "../../library/regexEscape";

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

const SAFE_REDIRECT_TARGETS = new Set([
  "/dev/null",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/tty",
]);

const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=.*$/;
const MAX_UNWRAP_DEPTH = 8;

export type TerminalApprovalPolicy = "always_prompt" | "auto_approve_safe";

type ParsedSegment = {
  raw: string;
  rawTokens: string[];
  tokens: string[];
};

type ExtractedCommands = {
  commands: string[];
  hasUnsafeWrite: boolean;
  parseFailed: boolean;
};

function getPreviousNonWhitespaceChar(input: string, index: number): string | undefined {
  for (let cursor = index; cursor >= 0; cursor--) {
    const char = input[cursor];
    if (!/\s/.test(char)) {
      return char;
    }
  }

  return undefined;
}

type CompiledRules = {
  allowRules: RegExp[];
  denyRules: RegExp[];
  allowCommandLineRules: RegExp[];
  denyCommandLineRules: RegExp[];
};

const NEVER_MATCH_REGEX = /(?!.*)/;

const DEFAULT_RULES: TerminalAutoApproveRules = {
  cd: true,
  echo: true,
  ls: true,
  dir: true,
  pwd: true,
  cat: true,
  head: true,
  tail: true,
  findstr: true,
  wc: true,
  tr: true,
  cut: true,
  cmp: true,
  which: true,
  basename: true,
  dirname: true,
  realpath: true,
  readlink: true,
  stat: true,
  file: true,
  od: true,
  du: true,
  df: true,
  sleep: true,
  nl: true,
  column: true,
  find: true,
  rg: true,
  sed: true,
  sort: true,
  tree: true,
  xxd: true,
  grep: true,
  "/^find\\b(?!.*\\s-(delete|exec|execdir|fprint|fprintf|fls|ok|okdir)\\b)/i": true,
  "/^rg\\b(?!.*\\s(--pre|--hostname-bin)\\b)/i": true,
  "/^sort\\b(?!.*\\s-(o|S)\\b)/i": true,
  "/^tree\\b(?!.*\\s-o\\b)/i": true,
  "/^column\\b.*\\s-c\\s+[0-9]{1,3}\\b/i": true,
  "/^date\\b(?!.*\\s(-s|--set)\\b)/i": true,
  "/^git(\\s+(-C\\s+\\S+|--no-pager))*\\s+status\\b/i": true,
  "/^git(\\s+(-C\\s+\\S+|--no-pager))*\\s+diff\\b/i": true,
  "/^git(\\s+(-C\\s+\\S+|--no-pager))*\\s+show\\b/i": true,
  "/^git(\\s+(-C\\s+\\S+|--no-pager))*\\s+log\\b/i": true,
  "/^git(\\s+(-C\\s+\\S+|--no-pager))*\\s+ls-files\\b/i": true,
  "/^git(\\s+(-C\\s+\\S+|--no-pager))*\\s+rev-parse\\b/i": true,
  "/^git(\\s+(-C\\s+\\S+|--no-pager))*\\s+grep\\b/i": true,
  "/^git(\\s+(-C\\s+\\S+|--no-pager))*\\s+branch\\b/i": true,
  "/^npm\\s+(ls|list|outdated|view|info|show|explain|why|root|prefix|bin|search|doctor|fund|repo|bugs|docs|home|help(-search)?)\\b/i": true,
  "/^npm\\s+config\\s+(list|get)\\b/i": true,
  "/^npm\\s+pkg\\s+get\\b/i": true,
  "/^npm\\s+audit$/i": true,
  "/^npm\\s+cache\\s+verify\\b/i": true,
  "/^npm\\s+ci$/i": true,
  "/^yarn\\s+(list|outdated|info|why|bin|help|versions)\\b/i": true,
  "/^yarn\\s+licenses\\b/i": true,
  "/^yarn\\s+audit\\b(?!.*\\bfix\\b)/i": true,
  "/^yarn\\s+config\\s+(list|get)\\b/i": true,
  "/^yarn\\s+cache\\s+dir\\b/i": true,
  "/^yarn\\s+install\\s+--frozen-lockfile\\b/i": true,
  "/^pnpm\\s+(ls|list|outdated|why|root|bin|doctor)\\b/i": true,
  "/^pnpm\\s+licenses\\b/i": true,
  "/^pnpm\\s+audit\\b(?!.*\\bfix\\b)/i": true,
  "/^pnpm\\s+config\\s+(list|get)\\b/i": true,
  "/^pnpm\\s+install\\s+--frozen-lockfile\\b/i": true,
  "/^docker\\s+(ps|images|info|version|inspect|logs|top|stats|port|diff|search|events)\\b/i": true,
  "/^docker\\s+(container|image|network|volume|context|system)\\s+(ls|ps|inspect|history|show|df|info)\\b/i": true,
  "/^docker\\s+compose\\s+(ps|ls|top|logs|images|config|version|port|events)\\b/i": true,
  "Get-ChildItem": true,
  "Get-Content": true,
  "Get-Date": true,
  "Get-Random": true,
  "Get-Location": true,
  "Set-Location": true,
  "Write-Host": true,
  "Write-Output": true,
  "Out-String": true,
  "Split-Path": true,
  "Join-Path": true,
  "Start-Sleep": true,
  "Where-Object": true,
  "/^Select-[a-z0-9]/i": true,
  "/^Measure-[a-z0-9]/i": true,
  "/^Compare-[a-z0-9]/i": true,
  "/^Format-[a-z0-9]/i": true,
  "/^Sort-[a-z0-9]/i": true,
  rm: false,
  rmdir: false,
  del: false,
  "Remove-Item": false,
  ri: false,
  rd: false,
  erase: false,
  dd: false,
  kill: false,
  ps: false,
  top: false,
  taskkill: false,
  "taskkill.exe": false,
  "Stop-Process": false,
  spps: false,
  chmod: false,
  chown: false,
  curl: false,
  wget: false,
  "Invoke-RestMethod": false,
  "Invoke-WebRequest": false,
  irm: false,
  iwr: false,
  "Set-ItemProperty": false,
  sp: false,
  "Set-Acl": false,
  jq: false,
  xargs: false,
  eval: false,
  "Invoke-Expression": false,
  iex: false,
  "/^column\\b.*\\s-c\\s+[0-9]{4,}\\b/i": false,
  "/^git(\\s+(-C\\s+\\S+|--no-pager))*\\s+log\\b.*\\s--output(=|\\s|$)/i": false,
  "/^git(\\s+(-C\\s+\\S+|--no-pager))*\\s+branch\\b.*\\s-(d|D|m|M|-delete|-force)\\b/i": false,
  "/^find\\b.*\\s-(delete|exec|execdir|fprint|fprintf|fls|ok|okdir)\\b/i": false,
  "/^sed\\b.*\\s(-[a-zA-Z]*(e|f)[a-zA-Z]*|--expression|--file)\\b/i": false,
  "/^sed\\b.*s\\/.*\\/.*\\/[ew]/i": false,
  "/^sed\\b.*;W/i": false,
  "/^sort\\b.*\\s-(o|S)\\b/i": false,
  "/^tree\\b.*\\s-o\\b/i": false,
  "/^date\\b.*\\s(-s|--set)\\b/i": false,
  "/^xxd$/i": true,
  "/^xxd\\b(\\s+-\\S+)*\\s+[^-\\s]\\S*$/i": true,
};

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

function splitSegments(command: string): ParsedSegment[] {
  const segments: Array<{ raw: string }> = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;

  const push = () => {
    const trimmed = current.trim();
    if (trimmed) {
      segments.push({ raw: trimmed });
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

    if (char === "|" && command[index + 1] === "|") {
      push();
      index++;
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

    if (char === "|" || char === ";") {
      push();
      continue;
    }

    if (char === "&" && command[index + 1] === "&") {
      push();
      index++;
      continue;
    }

    current += char;
  }

  push();

  return segments.map((segment) => {
    const rawTokens = tokenize(segment.raw);
    const { tokens } = stripPrefixesAndWrappers(rawTokens);
    return {
      raw: segment.raw,
      rawTokens,
      tokens,
    };
  });
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

function stripPrefixesAndWrappers(rawTokens: readonly string[]): {
  tokens: string[];
} {
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

  return {
    tokens: rawTokens.slice(index),
  };
}

function readRedirectDestination(command: string, startIndex: number): {
  dest: string | undefined;
  endIndex: number;
} {
  let index = startIndex;
  while (index < command.length && /\s/.test(command[index])) {
    index++;
  }

  if (index >= command.length) {
    return { dest: undefined, endIndex: index };
  }

  const quote = command[index];
  if (quote === "'" || quote === '"') {
    index++;
    const begin = index;
    while (index < command.length && command[index] !== quote) {
      if (command[index] === "\\" && quote === '"' && index + 1 < command.length) {
        index += 2;
        continue;
      }
      index++;
    }
    return {
      dest: command.slice(begin, index),
      endIndex: index,
    };
  }

  const begin = index;
  while (index < command.length && !/\s/.test(command[index])) {
    index++;
  }

  return {
    dest: command.slice(begin, index),
    endIndex: index,
  };
}

function isSafeRedirectDestination(dest: string | undefined): boolean {
  if (!dest) {
    return false;
  }

  const cleaned = dest.trim();
  if (!cleaned) {
    return false;
  }

  if (/^&[0-9]+-?$/.test(cleaned)) {
    return true;
  }

  return SAFE_REDIRECT_TARGETS.has(cleaned);
}

function hasUnsafeWriteRedirect(command: string): boolean {
  let inSingle = false;
  let inDouble = false;

  for (let index = 0; index < command.length; index++) {
    const char = command[index];

    if (inSingle) {
      if (char === "'") {
        inSingle = false;
      }
      continue;
    }

    if (inDouble) {
      if (char === "\\" && index + 1 < command.length) {
        index++;
        continue;
      }
      if (char === '"') {
        inDouble = false;
      }
      continue;
    }

    if (char === "\\" && index + 1 < command.length) {
      index++;
      continue;
    }

    if (char === "'") {
      inSingle = true;
      continue;
    }

    if (char === '"') {
      inDouble = true;
      continue;
    }

    if (char !== ">") {
      continue;
    }

    if (index + 1 < command.length && command[index + 1] === ">") {
      index++;
    }

    if (index + 1 < command.length && command[index + 1] === "|") {
      index++;
    }

    const { dest, endIndex } = readRedirectDestination(command, index + 1);
    if (!isSafeRedirectDestination(dest)) {
      return true;
    }
    index = endIndex;
  }

  return false;
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

function extractCommands(commandLine: string, depth = 0): ExtractedCommands {
  if (depth > MAX_UNWRAP_DEPTH) {
    return {
      commands: [],
      hasUnsafeWrite: false,
      parseFailed: true,
    };
  }

  const segments = splitSegments(commandLine);
  if (segments.length === 0) {
    return {
      commands: [],
      hasUnsafeWrite: false,
      parseFailed: false,
    };
  }

  const commands: string[] = [];
  let hasUnsafeWrite = false;
  let parseFailed = false;

  for (const segment of segments) {
    if (hasUnsafeWriteRedirect(segment.raw)) {
      hasUnsafeWrite = true;
    }

    if (segment.tokens.length === 0) {
      continue;
    }

    const nestedCommand = extractShellCommand(segment.tokens);
    if (nestedCommand) {
      const nested = extractCommands(nestedCommand, depth + 1);
      commands.push(...nested.commands);
      hasUnsafeWrite ||= nested.hasUnsafeWrite;
      parseFailed ||= nested.parseFailed || nested.commands.length === 0;
      continue;
    }

    commands.push(segment.tokens.join(" "));
  }

  return {
    commands,
    hasUnsafeWrite,
    parseFailed,
  };
}

function matchesRule(commandLine: string, rules: readonly RegExp[]): boolean {
  return rules.some((rule) => rule.test(commandLine));
}

function convertAutoApproveEntryToRegex(value: string): RegExp {
  const regexMatch = value.match(/^\/(?<pattern>.+)\/(?<flags>[dgimsuvy]*)$/);
  const regexPattern = regexMatch?.groups?.pattern;
  if (regexPattern) {
    let flags = regexMatch.groups?.flags || "";
    if (flags.includes("g")) {
      flags = flags.replaceAll("g", "");
    }
    try {
      return new RegExp(regexPattern, flags || undefined);
    } catch {
      return NEVER_MATCH_REGEX;
    }
  }

  if (value === "") {
    return NEVER_MATCH_REGEX;
  }

  const escaped = escapeRegExp(value);
  return new RegExp(`^${escaped}\\b`, "i");
}

function compileRules(ruleConfig: TerminalAutoApproveRules | undefined): CompiledRules {
  const allowRules: RegExp[] = [];
  const denyRules: RegExp[] = [];
  const allowCommandLineRules: RegExp[] = [];
  const denyCommandLineRules: RegExp[] = [];

  for (const [key, value] of Object.entries(ruleConfig || {})) {
    const regex = convertAutoApproveEntryToRegex(key);
    const ruleValue: TerminalAutoApproveRuleValue = value;

    if (typeof ruleValue === "boolean") {
      if (ruleValue) {
        allowRules.push(regex);
      } else {
        denyRules.push(regex);
      }
      continue;
    }

    if (ruleValue.approve) {
      if (ruleValue.matchCommandLine === true) {
        allowCommandLineRules.push(regex);
      } else {
        allowRules.push(regex);
      }
    } else if (ruleValue.matchCommandLine === true) {
      denyCommandLineRules.push(regex);
    } else {
      denyRules.push(regex);
    }
  }

  return {
    allowRules,
    denyRules,
    allowCommandLineRules,
    denyCommandLineRules,
  };
}

function isApprovedLeafCommand(
  commandLine: string,
  customRules: CompiledRules,
  defaultRules: CompiledRules,
): boolean {
  const tokens = tokenize(commandLine);
  const head = normalizeCommandKeyword(tokens[0]);
  if (!head || NEVER_AUTO_APPROVE_COMMANDS.has(head)) {
    return false;
  }

  if (matchesRule(commandLine, customRules.denyRules)) {
    return false;
  }

  if (matchesRule(commandLine, customRules.allowRules)) {
    return true;
  }

  if (matchesRule(commandLine, defaultRules.denyRules)) {
    return false;
  }

  return matchesRule(commandLine, defaultRules.allowRules);
}

export function shouldAutoApproveTerminalCommand(
  commandLine: string | undefined,
  customRuleConfig?: TerminalAutoApproveRules,
): boolean {
  const trimmed = commandLine?.trim();
  if (!trimmed) {
    return true;
  }

  const customRules = compileRules(customRuleConfig);
  const defaultRules = compileRules(DEFAULT_RULES);

  if (matchesRule(trimmed, customRules.denyCommandLineRules)) {
    return false;
  }

  const extracted = extractCommands(trimmed);
  if (extracted.parseFailed || extracted.hasUnsafeWrite || extracted.commands.length === 0) {
    return false;
  }

  const allLeafCommandsApproved = extracted.commands.every((command) =>
    isApprovedLeafCommand(command, customRules, defaultRules),
  );

  if (allLeafCommandsApproved) {
    return true;
  }

  return matchesRule(trimmed, customRules.allowCommandLineRules);
}
