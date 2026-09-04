import { z } from "zod";
import { executeCommand } from "./executeCommand";
import type { TerminalAutoApproveRules } from "../../library/terminalAutoApproveSettings";

type RunTerminalCommandParams = {
  command: string;
  cwd?: string;
  workspaceRoot?: string;
  timeout?: number;
  env?: NodeJS.ProcessEnv;
  runInBackground?: boolean;
  description?: string;
  skipConfirmation?: boolean;
  autoApproveRules?: TerminalAutoApproveRules;
};

type CommandResult = Record<string, unknown> & {
  success?: boolean;
  error?: string;
};

/**
 * Tool for running terminal commands
 *
 * Safe readonly commands can be auto-approved using wrapper-aware parsing.
 * Commands that do not match the allow-list still return pending_confirmation,
 * which triggers the existing user approval dialog in the UI.
 *
 * @param {Object} params - The parameters for running a command
 * @param {string} params.command - The command to execute
 * @param {string} [params.cwd] - Current working directory for the command
 * @param {number} [params.timeout=30000] - Timeout in milliseconds
 * @param {Object} [params.env] - Environment variables
 * @param {boolean} [params.skipConfirmation=false] - Skip user confirmation (used internally after user approves)
 * @returns {Promise<Object>} Object containing success status and command output or error
 */
export async function runTerminalCommand({
  command,
  cwd = process.cwd(),
  workspaceRoot,
  timeout = 30000,
  env = {},
  runInBackground = false,
  description,
  skipConfirmation = false,
  autoApproveRules,
}: RunTerminalCommandParams): Promise<CommandResult> {
  // Route through executeCommand for consistent confirmation flow
  return executeCommand({
    command,
    cwd,
    workspaceRoot,
    timeout,
    env,
    runInBackground,
    description,
    skipConfirmation,
    approvalPolicy: "auto_approve_safe",
    autoApproveRules,
  });
}

/**
 * Tool metadata for agent system
 */
export const runTerminalCommandTool = {
  description:
    "Execute a terminal command and return its output. Safe readonly commands may auto-run; other commands require confirmation.",
  parameters: z.object({
    command: z.string().describe("The command to execute"),
    cwd: z
      .string()
      .default(process.cwd())
      .describe("Current working directory for the command"),
    workspaceRoot: z
      .string()
      .optional()
      .describe(
        "Workspace root path for security validation - defaults to inferred repo root",
      ),
    timeout: z.number().default(30000).describe("Timeout in milliseconds"),
    env: z.record(z.string()).optional().describe("Environment variables"),
    runInBackground: z
      .boolean()
      .default(false)
      .describe("Run command as managed background task"),
    description: z
      .string()
      .optional()
      .describe("Optional short task description for background execution"),
    skipConfirmation: z
      .boolean()
      .default(false)
      .describe(
        "Skip user confirmation - only used internally after user approves the command",
      ),
    autoApproveRules: z
      .record(z.any())
      .optional()
      .describe("Optional auto-approve rule map for internal runtime configuration."),
  }),
  execute: runTerminalCommand,
};

export default runTerminalCommandTool;
