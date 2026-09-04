import { exec, execFile } from "child_process";
import type { ExecException } from "child_process";
import { promisify } from "util";
import path from "path";
import { z } from "zod";
import fs from "fs";
import { startBackgroundTask } from "./backgroundTasks";
import {
  shouldAutoApproveTerminalCommand,
  type TerminalApprovalPolicy,
} from "./terminalAutoApprove";
import type { TerminalAutoApproveRules } from "../../library/terminalAutoApproveSettings";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

type ExecuteCommandParams = {
  command?: string;
  cwd?: string;
  workspaceRoot?: string;
  timeout?: number;
  env?: NodeJS.ProcessEnv;
  runInBackground?: boolean;
  description?: string;
  skipConfirmation?: boolean;
  approvalPolicy?: TerminalApprovalPolicy;
  autoApproveRules?: TerminalAutoApproveRules;
};

type CommandInfo = {
  command: string;
};

type CommandResult = Record<string, unknown> & {
  success?: boolean;
  error?: string;
};

type CommandExecutionError = ExecException & {
  stdout?: string;
  stderr?: string;
  code?: number | string;
};

function isPathWithinWorkspace(resolvedPath: string, workspacePath: string) {
  const normalizedResolved = path.resolve(resolvedPath);
  const normalizedWorkspace = path.resolve(workspacePath);

  return (
    normalizedResolved.startsWith(normalizedWorkspace + path.sep) ||
    normalizedResolved === normalizedWorkspace
  );
}

function detectWorkspaceRootFromCwd(cwd: string): string {
  let current = path.resolve(cwd);

  while (true) {
    const gitMarker = path.join(current, ".git");
    if (fs.existsSync(gitMarker)) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return path.resolve(cwd);
}

function requestConfirmation(commandInfo: CommandInfo): CommandResult {
  const confirmationId = `cmd_${Date.now()}_${Math.random()
    .toString(36)
    .substr(2, 9)}`;

  return {
    status: "pending_confirmation",
    confirmationId,
    command: commandInfo.command,
  };
}

async function resolveLegacyPythonCommand(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  if (!/^python(?=\s|$)/.test(command)) {
    return command;
  }

  const options = {
    cwd,
    timeout: 3000,
    env: { ...process.env, ...env },
  };

  try {
    const current = await execFileAsync(
      "python",
      ["-c", "import sys; print(sys.version_info[0])"],
      options,
    );
    if (current.stdout.trim() !== "2") {
      return command;
    }

    const replacement = await execFileAsync(
      "python3",
      ["-c", "import sys; print(sys.version_info[0])"],
      options,
    );
    if (replacement.stdout.trim() === "3") {
      return command.replace(/^python(?=\s|$)/, "python3");
    }
  } catch {
    // Preserve the original command so normal execution reports the useful error.
  }

  return command;
}

export async function executeCommand({
  command,
  cwd = process.cwd(),
  workspaceRoot,
  timeout = 30000,
  env = {},
  runInBackground = false,
  description,
  skipConfirmation = false,
  approvalPolicy = "always_prompt",
  autoApproveRules,
}: ExecuteCommandParams): Promise<CommandResult> {
  try {
    if (!command) {
      return {
        success: false,
        error: "'command' is required",
      };
    }

    const dangerousPatterns = [
      /rm\s+-rf\s+\//,
      /:\(\)\{.*;\};/,
      /mkfs/,
      /dd\s+if=/,
      />\s*\/dev\/sda/,
    ];

    const injectionPatterns = [
      /`[^`]*`/,
      /\$\([^)]*\)/,
      />\s*\/dev\//,
    ];

    for (const pattern of dangerousPatterns) {
      if (pattern.test(command)) {
        return {
          success: false,
          error: "Command blocked for safety reasons",
        };
      }
    }

    const baseCommandMatch = command.match(/^(\S+)/);
    const baseCommand = baseCommandMatch ? baseCommandMatch[1] : "";
    const isSafeBaseCommand =
      /^(echo|cat|ls|pwd|cd|mkdir|touch|cp|mv|which|npm|node|git)$/.test(
        baseCommand,
      );
    const hasShellOperators = /[`$();|&<>]/.test(command);

    if (!isSafeBaseCommand || hasShellOperators) {
      for (const pattern of injectionPatterns) {
        if (pattern.test(command)) {
          return {
            success: false,
            error:
              "Command contains potentially unsafe characters. Use simple commands without shell operators.",
          };
        }
      }
    }

    const absoluteCwd = path.resolve(cwd);

    if (!skipConfirmation) {
      const canAutoApprove =
        approvalPolicy === "auto_approve_safe" &&
        shouldAutoApproveTerminalCommand(command, autoApproveRules);

      if (!canAutoApprove) {
        return requestConfirmation({
          command,
        });
      }
    }

    const validationRoot = workspaceRoot
      ? path.resolve(workspaceRoot)
      : detectWorkspaceRootFromCwd(absoluteCwd);

    if (!workspaceRoot) {
      console.warn(
        `⚠️  Security warning: workspaceRoot not provided, inferred workspace root for validation: ${validationRoot}`,
      );
    }

    if (!isPathWithinWorkspace(absoluteCwd, validationRoot)) {
      return {
        success: false,
        error:
          "Working directory is outside workspace boundary. Access denied for security.",
      };
    }

    const resolvedCommand = await resolveLegacyPythonCommand(
      command,
      absoluteCwd,
      env,
    );

    if (runInBackground) {
      return startBackgroundTask({
        command: resolvedCommand,
        cwd: absoluteCwd,
        env,
        description,
      });
    }

    const startTime = Date.now();
    const parts = resolvedCommand.trim().split(/\s+/);
    const execCommand = parts[0];
    const args = parts.slice(1);
    // Package managers commonly use >= / <= version specs; those are not shell operators.
    const needsShell = /[`$();|&<>]/.test(
      resolvedCommand.replace(/[<>]=/g, ""),
    );

    try {
      let stdout = "";
      let stderr = "";

      if (!needsShell) {
        const result = await execFileAsync(execCommand, args, {
          cwd: absoluteCwd,
          timeout,
          maxBuffer: 1024 * 1024 * 10,
          env: { ...process.env, ...env },
        });
        stdout = result.stdout;
        stderr = result.stderr;
      } else {
        const result = await execAsync(resolvedCommand, {
          cwd: absoluteCwd,
          timeout,
          maxBuffer: 1024 * 1024 * 10,
          env: { ...process.env, ...env },
        });
        stdout = result.stdout;
        stderr = result.stderr;
      }

      const executionTime = Date.now() - startTime;

      return {
        success: true,
        command,
        ...(resolvedCommand !== command ? { resolvedCommand } : {}),
        cwd: absoluteCwd,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        executionTime,
        exitCode: 0,
        executionMethod: needsShell ? "shell" : "direct",
      };
    } catch (execError) {
      const error = execError as CommandExecutionError;
      const executionTime = Date.now() - startTime;
      return {
        success: false,
        command,
        ...(resolvedCommand !== command ? { resolvedCommand } : {}),
        cwd: absoluteCwd,
        error: error.message,
        stdout: error.stdout ? error.stdout.trim() : "",
        stderr: error.stderr ? error.stderr.trim() : "",
        exitCode: typeof error.code === "number" ? error.code : 1,
        timedOut: error.killed && error.signal === "SIGTERM",
        executionTime,
      };
    }
  } catch (error) {
    const err = error as CommandExecutionError;
    return {
      success: false,
      command,
      error: err.message,
      stdout: err.stdout ? err.stdout.trim() : "",
      stderr: err.stderr ? err.stderr.trim() : "",
      exitCode: typeof err.code === "number" ? err.code : 1,
      timedOut: err.killed && err.signal === "SIGTERM",
    };
  }
}

export const executeCommandTool = {
  description:
    "Execute terminal commands and return output. Commands require approval unless skipConfirmation is set internally or safe auto-approval policy applies.",
  parameters: z.object({
    command: z.string().optional().describe("The shell command to execute"),
    cwd: z
      .string()
      .default(process.cwd())
      .describe("Current working directory for the command"),
    workspaceRoot: z
      .string()
      .optional()
      .describe(
        "Workspace root path for security validation - ensures paths stay within this boundary",
      ),
    timeout: z.number().default(30000).describe("Timeout in milliseconds"),
    env: z
      .record(z.string())
      .optional()
      .describe("Environment variables to pass to the command"),
    runInBackground: z
      .boolean()
      .default(false)
      .describe(
        "Run the command as a managed background task and return a taskId for TaskList/TaskOutput/TaskStop",
      ),
    description: z
      .string()
      .optional()
      .describe("Optional short description for background task tracking"),
    skipConfirmation: z
      .boolean()
      .default(false)
      .describe(
        "Skip user confirmation - only used internally after user approves the command",
      ),
    approvalPolicy: z
      .enum(["always_prompt", "auto_approve_safe"])
      .default("always_prompt")
      .describe(
        "Approval behavior for the command. Use auto_approve_safe only for wrapper-aware readonly auto-approval.",
      ),
    autoApproveRules: z
      .record(z.any())
      .optional()
      .describe("Optional auto-approve rule map used for terminal command approval."),
  }),
  execute: executeCommand,
};

export default executeCommandTool;
