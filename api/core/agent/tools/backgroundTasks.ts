import { spawn, type ChildProcess } from "child_process";
import { z } from "zod";

export type BackgroundTaskStatus =
  | "running"
  | "completed"
  | "failed"
  | "stopped";

type BackgroundTaskRecord = {
  id: string;
  command: string;
  cwd: string;
  description: string;
  status: BackgroundTaskStatus;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  output: string;
  outputTruncated: boolean;
  pid?: number;
  process?: ChildProcess;
  usesProcessGroup: boolean;
  stopReason?: string;
};

type StartBackgroundTaskParams = {
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  description?: string;
};

const OUTPUT_LIMIT_BYTES = 64 * 1024;
const TERMINATION_GRACE_MS = 1500;
const TERMINAL_TASK_TTL_MS = 60 * 60 * 1000;
const MAX_TERMINAL_TASKS_RETAINED = 200;
const tasks = new Map<string, BackgroundTaskRecord>();
let evictedTasksTotal = 0;

const getRetentionStats = () => ({
  maxTerminalTasksRetained: MAX_TERMINAL_TASKS_RETAINED,
  terminalTaskTtlMs: TERMINAL_TASK_TTL_MS,
  evictedTasksTotal,
});

const sweepTerminalTasks = () => {
  const now = Date.now();
  const terminalEntries = Array.from(tasks.entries()).filter(([, task]) =>
    ["completed", "failed", "stopped"].includes(task.status),
  );

  for (const [id, task] of terminalEntries) {
    const terminalAt = task.endedAt || task.startedAt;
    if (now - terminalAt > TERMINAL_TASK_TTL_MS) {
      tasks.delete(id);
      evictedTasksTotal += 1;
    }
  }

  const remainingTerminal = Array.from(tasks.entries())
    .filter(([, task]) => ["completed", "failed", "stopped"].includes(task.status))
    .sort((a, b) => {
      const aTime = a[1].endedAt || a[1].startedAt;
      const bTime = b[1].endedAt || b[1].startedAt;
      return bTime - aTime;
    });

  if (remainingTerminal.length > MAX_TERMINAL_TASKS_RETAINED) {
    const overflow = remainingTerminal.slice(MAX_TERMINAL_TASKS_RETAINED);
    for (const [id] of overflow) {
      tasks.delete(id);
      evictedTasksTotal += 1;
    }
  }
};

const waitForProcessExit = async (
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return true;
  }

  return await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("close", finish);
      child.off("exit", finish);
      resolve(true);
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.off("close", finish);
      child.off("exit", finish);
      resolve(false);
    }, timeoutMs);

    child.once("close", finish);
    child.once("exit", finish);
  });
};

const taskKillOnWindows = async (pid: number, force: boolean): Promise<boolean> => {
  return await new Promise((resolve) => {
    const args = ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])];
    const killer = spawn("taskkill", args, {
      windowsHide: true,
      stdio: "ignore",
    });

    killer.on("error", () => resolve(false));
    killer.on("close", (code) => resolve(code === 0));
  });
};

const sendTerminationSignal = async (
  task: BackgroundTaskRecord,
  force: boolean,
): Promise<boolean> => {
  const pid = task.pid;
  if (!pid) return false;

  if (process.platform === "win32") {
    return taskKillOnWindows(pid, force);
  }

  try {
    const signal = force ? "SIGKILL" : "SIGTERM";
    if (task.usesProcessGroup) {
      process.kill(-pid, signal);
      return true;
    }

    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
};

const terminateTaskProcess = async (task: BackgroundTaskRecord): Promise<boolean> => {
  const child = task.process;
  if (!child) return true;

  await sendTerminationSignal(task, false);
  let exited = await waitForProcessExit(child, TERMINATION_GRACE_MS);
  if (exited) return true;

  await sendTerminationSignal(task, true);
  exited = await waitForProcessExit(child, TERMINATION_GRACE_MS);
  return exited;
};

export const __resetBackgroundTasksForTests = async () => {
  const runningTasks = Array.from(tasks.values()).filter(
    (task) => task.status === "running",
  );

  await Promise.all(
    runningTasks.map(async (task) => {
      task.status = "stopped";
      task.endedAt = Date.now();
      task.stopReason = "Stopped by test reset";
      appendTaskOutput(task, "\n[background-task-stop] Stopped by test reset\n");
      await terminateTaskProcess(task);
    }),
  );

  tasks.clear();
  evictedTasksTotal = 0;
};

const trimUtf8TailToByteLimit = (input: string, maxBytes: number): string => {
  if (maxBytes <= 0) return "";

  const buffer = Buffer.from(input, "utf8");
  if (buffer.length <= maxBytes) {
    return input;
  }

  let start = buffer.length - maxBytes;

  // Avoid starting in the middle of a UTF-8 continuation sequence.
  while (start < buffer.length && (buffer[start] & 0b11000000) === 0b10000000) {
    start += 1;
  }

  return buffer.subarray(start).toString("utf8");
};

const appendTaskOutput = (task: BackgroundTaskRecord, chunk: string) => {
  if (!chunk) return;
  const nextOutput = task.output + chunk;
  if (Buffer.byteLength(nextOutput, "utf8") <= OUTPUT_LIMIT_BYTES) {
    task.output = nextOutput;
    return;
  }

  task.outputTruncated = true;
  task.output = trimUtf8TailToByteLimit(nextOutput, OUTPUT_LIMIT_BYTES);
};

const makeTaskId = (): string =>
  `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

export const startBackgroundTask = ({
  command,
  cwd,
  env = {},
  description,
}: StartBackgroundTaskParams) => {
  sweepTerminalTasks();

  const id = makeTaskId();
  const usesProcessGroup = process.platform !== "win32";
  const child = spawn(command, {
    cwd,
    env: { ...process.env, ...env },
    shell: true,
    detached: usesProcessGroup,
  });

  const task: BackgroundTaskRecord = {
    id,
    command,
    cwd,
    description: description || command,
    status: "running",
    startedAt: Date.now(),
    output: "",
    outputTruncated: false,
    pid: child.pid,
    process: child,
    usesProcessGroup,
  };

  tasks.set(id, task);

  child.stdout?.on("data", (data: Buffer | string) => {
    appendTaskOutput(task, data.toString());
  });

  child.stderr?.on("data", (data: Buffer | string) => {
    appendTaskOutput(task, data.toString());
  });

  child.on("error", (error) => {
    appendTaskOutput(task, `\n[background-task-error] ${error.message}\n`);
    task.status = "failed";
    task.endedAt = Date.now();
    task.exitCode = 1;
  });

  child.on("close", (code, signal) => {
    if (task.status === "stopped") {
      task.endedAt = task.endedAt || Date.now();
      task.exitCode = code;
      task.signal = signal;
      task.process = undefined;
      return;
    }

    task.status = code === 0 ? "completed" : "failed";
    task.endedAt = Date.now();
    task.exitCode = code;
    task.signal = signal;
    task.process = undefined;
  });

  return {
    success: true,
    status: "in_progress",
    taskId: id,
    pid: child.pid,
    command,
    cwd,
    description: task.description,
    startedAt: task.startedAt,
    message: `Started background task ${id}`,
  };
};

export const listBackgroundTasks = ({
  activeOnly = true,
  limit = 20,
}: {
  activeOnly?: boolean;
  limit?: number;
}) => {
  sweepTerminalTasks();

  const ordered = Array.from(tasks.values())
    .filter((task) => (activeOnly ? task.status === "running" : true))
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, Math.max(1, Math.min(limit, 100)));

  return ordered.map((task) => ({
    taskId: task.id,
    command: task.command,
    description: task.description,
    cwd: task.cwd,
    status: task.status,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    pid: task.pid,
    exitCode: task.exitCode,
    signal: task.signal,
    retention: getRetentionStats(),
  }));
};

export const getBackgroundTaskOutput = ({
  taskId,
  tailChars = 3000,
}: {
  taskId: string;
  tailChars?: number;
}) => {
  sweepTerminalTasks();

  const task = tasks.get(taskId);
  if (!task) {
    return {
      success: false,
      error: `Background task '${taskId}' not found`,
    };
  }

  const normalizedTailChars = Math.max(256, Math.min(tailChars, 20000));
  return {
    success: true,
    taskId,
    status: task.status,
    command: task.command,
    description: task.description,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    exitCode: task.exitCode,
    signal: task.signal,
    output: task.output.slice(-normalizedTailChars),
    outputTruncated: task.outputTruncated || task.output.length > normalizedTailChars,
    totalOutputChars: task.output.length,
    retention: getRetentionStats(),
  };
};

export const stopBackgroundTask = ({
  taskId,
  reason = "Stopped by TaskStop",
}: {
  taskId: string;
  reason?: string;
}) => {
  sweepTerminalTasks();

  const task = tasks.get(taskId);
  if (!task) {
    return {
      success: false,
      error: `Background task '${taskId}' not found`,
    };
  }

  if (task.status !== "running") {
    return {
      success: true,
      taskId,
      status: task.status,
      message: `Task ${taskId} is already in terminal status '${task.status}'`,
    };
  }

  task.status = "stopped";
  task.endedAt = Date.now();
  task.stopReason = reason;
  appendTaskOutput(task, `\n[background-task-stop] ${reason}\n`);

  return terminateTaskProcess(task).then((killed) => ({
    success: true,
    taskId,
    status: task.status,
    killed,
    reason,
    retention: getRetentionStats(),
    message: `Stop signal sent to task ${taskId}`,
  }));
};

export const taskListTool = {
  description:
    "List background tasks started with runInBackground. Use activeOnly=true by default.",
  parameters: z.object({
    activeOnly: z.boolean().default(true),
    limit: z.number().min(1).max(100).default(20),
  }),
  execute: async ({ activeOnly = true, limit = 20 }: { activeOnly?: boolean; limit?: number }) => ({
    success: true,
    tasks: listBackgroundTasks({ activeOnly, limit }),
    retention: getRetentionStats(),
  }),
};

export const taskOutputTool = {
  description:
    "Get non-blocking status and output snapshot for a background task.",
  parameters: z.object({
    taskId: z.string().describe("Background task ID"),
    tailChars: z.number().min(256).max(20000).default(3000),
  }),
  execute: async ({ taskId, tailChars = 3000 }: { taskId: string; tailChars?: number }) =>
    getBackgroundTaskOutput({ taskId, tailChars }),
};

export const taskStopTool = {
  description:
    "Stop a running background task by task ID.",
  parameters: z.object({
    taskId: z.string().describe("Background task ID"),
    reason: z.string().default("Stopped by TaskStop"),
  }),
  execute: async ({ taskId, reason = "Stopped by TaskStop" }: { taskId: string; reason?: string }) =>
    await stopBackgroundTask({ taskId, reason }),
};
