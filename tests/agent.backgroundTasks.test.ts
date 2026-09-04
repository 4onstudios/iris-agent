import {
  __resetBackgroundTasksForTests,
  getBackgroundTaskOutput,
  listBackgroundTasks,
  stopBackgroundTask,
} from "../api/core/agent/tools/backgroundTasks";
import { executeCommand } from "../api/core/agent/tools/executeCommand";
import path from "path";

const quoteForShell = (value: string): string => {
  if (process.platform === "win32") {
    return `"${value.replace(/"/g, '""')}"`;
  }

  return `'${value.replace(/'/g, `'"'"'`)}'`;
};

const toShellPath = (value: string): string =>
  process.platform === "win32" ? value.replace(/\\/g, "/") : value;

const buildNodeScriptCommand = (scriptFileName: string): string => {
  const nodePath = toShellPath(process.execPath);
  const scriptPath = toShellPath(
    path.join(__dirname, "fixtures", scriptFileName),
  );

  return `${quoteForShell(nodePath)} ${quoteForShell(scriptPath)}`;
};

describe("background task integration", () => {
  beforeEach(async () => {
    await __resetBackgroundTasksForTests();
  });

  afterEach(async () => {
    await __resetBackgroundTasksForTests();
  });

  it("starts a managed background task via executeCommand and exposes it through task APIs", async () => {
    const start = await executeCommand({
      command: buildNodeScriptCommand("background-task-print.js"),
      cwd: process.cwd(),
      runInBackground: true,
      skipConfirmation: true,
      description: "background smoke",
    });

    expect(start.success).toBe(true);
    expect(start.status).toBe("in_progress");
    expect(typeof start.taskId).toBe("string");

    const taskId = String(start.taskId);

    const active = listBackgroundTasks({ activeOnly: true, limit: 10 });
    expect(active.some((task) => task.taskId === taskId)).toBe(true);

    let output = getBackgroundTaskOutput({ taskId, tailChars: 4000 }) as {
      success: boolean;
      status?: string;
      output?: string;
      exitCode?: number | null;
    };

    for (let i = 0; i < 20; i++) {
      const isTerminal = ["completed", "failed", "stopped"].includes(
        String(output.status),
      );
      const hasExpectedOutput = (output.output || "").includes("bg-ok");
      if (isTerminal || hasExpectedOutput) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
      output = getBackgroundTaskOutput({ taskId, tailChars: 4000 }) as {
        success: boolean;
        status?: string;
        output?: string;
        exitCode?: number | null;
      };
    }

    expect(output.success).toBe(true);
    expect(["running", "completed", "failed", "stopped"]).toContain(
      output.status,
    );
    expect(output.output || "").toContain("bg-ok");
    if (output.status !== "running") {
      expect(output.exitCode).toBe(0);
    }
  });

  it("stops a long-running background task", async () => {
    const start = await executeCommand({
      command: buildNodeScriptCommand("background-task-hang.js"),
      cwd: process.cwd(),
      runInBackground: true,
      skipConfirmation: true,
      description: "long running task",
    });

    expect(start.success).toBe(true);
    const taskId = String(start.taskId);

    const stopped = (await stopBackgroundTask({
      taskId,
      reason: "test stop",
    })) as { success: boolean; status?: string };

    expect(stopped.success).toBe(true);
    expect(stopped.status).toBe("stopped");

    const snapshot = getBackgroundTaskOutput({
      taskId,
    }) as { success: boolean; status?: string; output?: string };

    expect(snapshot.success).toBe(true);
    expect(snapshot.status).toBe("stopped");
    expect(snapshot.output || "").toContain("test stop");
  });

  it("enforces output byte cap for multibyte UTF-8 output", async () => {
    const start = await executeCommand({
      command: buildNodeScriptCommand("background-task-utf8-flood.js"),
      cwd: process.cwd(),
      runInBackground: true,
      skipConfirmation: true,
      description: "utf8 flood",
    });

    expect(start.success).toBe(true);
    const taskId = String(start.taskId);

    let output = getBackgroundTaskOutput({ taskId, tailChars: 20000 }) as {
      success: boolean;
      status?: string;
      output?: string;
      outputTruncated?: boolean;
    };

    for (let i = 0; i < 20; i++) {
      const isTerminal = ["completed", "failed", "stopped"].includes(
        String(output.status),
      );
      if (isTerminal) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
      output = getBackgroundTaskOutput({ taskId, tailChars: 20000 }) as {
        success: boolean;
        status?: string;
        output?: string;
        outputTruncated?: boolean;
      };
    }

    expect(output.success).toBe(true);
    expect(output.outputTruncated).toBe(true);
    expect(Buffer.byteLength(output.output || "", "utf8")).toBeLessThanOrEqual(
      64 * 1024,
    );
  });
});
