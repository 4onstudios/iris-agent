import os from "os";
import path from "path";
import fs from "fs/promises";
import sqlite3 from "sqlite3";
import { open, type Database as SqliteDatabase } from "sqlite";

export type RunLifecycleState =
  | "queued"
  | "running"
  | "waiting_tool"
  | "waiting_confirmation"
  | "waiting_user_input"
  | "paused"
  | "succeeded"
  | "failed"
  | "cancelled";

export type RunStopReason =
  | "none"
  | "completed"
  | "awaiting_approval"
  | "awaiting_user_input"
  | "max_steps_reached"
  | "no_progress"
  | "max_attempts"
  | "error"
  | "cancelled";

export type AgentRunRow = {
  run_id: string;
  status: string;
  stop_reason: string;
  objective: string | null;
  workspace_path: string | null;
  model_id: string | null;
  cancel_requested?: number | null;
  cancel_requested_at?: string | null;
  created_at: string;
  updated_at: string;
};

export type AgentRunCheckpointRow = {
  run_id: string;
  sequence: number;
  lifecycle_state: string;
  stop_reason: string;
  event_type: string;
  payload_json: string | null;
  created_at: string;
};

export const isSafeRunId = (runId: string) => /^[A-Za-z0-9._:-]{1,160}$/.test(runId);

const RUN_STORE_DIR = path.join(os.homedir(), ".iris");
const RUN_STORE_DB_PATH =
  process.env.IRIS_AGENT_RUNS_DB_PATH || path.join(RUN_STORE_DIR, "agent-runs.sqlite");

let runStorePromise: Promise<SqliteDatabase> | null = null;

// Serialize all write operations so concurrent calls never overlap on one SQLite connection.
let writeQueue: Promise<unknown> = Promise.resolve();
const enqueueWrite = <T>(fn: () => Promise<T>): Promise<T> => {
  const next = writeQueue.then(fn, fn);
  writeQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
};

const initializeRunStore = async (): Promise<SqliteDatabase> => {
  await fs.mkdir(path.dirname(RUN_STORE_DB_PATH), { recursive: true });
  const db = await open({
    filename: RUN_STORE_DB_PATH,
    driver: sqlite3.Database,
  });

  // Set the busy timeout before WAL because switching journal modes also needs
  // a database lock during fresh concurrent sidecar startup.
  await db.exec("PRAGMA busy_timeout = 5000;");
  // Use WAL mode so readers don't block writers (and vice versa).
  await db.exec("PRAGMA journal_mode = WAL;");

  await db.exec(`
    CREATE TABLE IF NOT EXISTS agent_runs (
      run_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      stop_reason TEXT NOT NULL,
      objective TEXT,
      workspace_path TEXT,
      model_id TEXT,
      cancel_requested INTEGER NOT NULL DEFAULT 0,
      cancel_requested_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const runColumns = (await db.all(
    "PRAGMA table_info(agent_runs)",
  )) as Array<{ name?: string }>;
  const hasCancelRequested = runColumns.some((column) => column.name === "cancel_requested");
  const hasCancelRequestedAt = runColumns.some(
    (column) => column.name === "cancel_requested_at",
  );

  if (!hasCancelRequested) {
    await db.exec(
      "ALTER TABLE agent_runs ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0;",
    );
  }

  if (!hasCancelRequestedAt) {
    await db.exec("ALTER TABLE agent_runs ADD COLUMN cancel_requested_at TEXT;");
  }

  await db.exec(`
    CREATE TABLE IF NOT EXISTS agent_run_checkpoints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      lifecycle_state TEXT NOT NULL,
      stop_reason TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(run_id, sequence)
    );
  `);

  await db.exec(
    "CREATE INDEX IF NOT EXISTS idx_agent_run_checkpoints_run_id ON agent_run_checkpoints(run_id, sequence);",
  );

  return db;
};

const getRunStore = async (): Promise<SqliteDatabase> => {
  if (!runStorePromise) {
    runStorePromise = initializeRunStore().catch((error) => {
      runStorePromise = null;
      throw error;
    });
  }

  return runStorePromise;
};

const persistRunLifecycleEvent = async (params: {
  runId: string;
  lifecycleState: RunLifecycleState;
  stopReason: RunStopReason;
  eventType: string;
  payload?: Record<string, unknown>;
  objective?: string;
  workspacePath?: string;
  modelId?: string;
}): Promise<void> => {
  return enqueueWrite(async () => {
  const db = await getRunStore();

  await db.exec("BEGIN IMMEDIATE TRANSACTION;");
  try {
    await db.run(
      `
        INSERT INTO agent_runs(run_id, status, stop_reason, objective, workspace_path, model_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(run_id) DO UPDATE SET
          status=excluded.status,
          stop_reason=excluded.stop_reason,
          objective=COALESCE(excluded.objective, agent_runs.objective),
          workspace_path=COALESCE(excluded.workspace_path, agent_runs.workspace_path),
          model_id=COALESCE(excluded.model_id, agent_runs.model_id),
          updated_at=CURRENT_TIMESTAMP
      `,
      params.runId,
      params.lifecycleState,
      params.stopReason,
      params.objective || null,
      params.workspacePath || null,
      params.modelId || null,
    );

    const sequenceRow = (await db.get(
      "SELECT COALESCE(MAX(sequence), 0) AS maxSequence FROM agent_run_checkpoints WHERE run_id = ?",
      params.runId,
    )) as { maxSequence: number } | undefined;
    const nextSequence = (sequenceRow?.maxSequence || 0) + 1;

    await db.run(
      `
        INSERT INTO agent_run_checkpoints(
          run_id,
          sequence,
          lifecycle_state,
          stop_reason,
          event_type,
          payload_json,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `,
      params.runId,
      nextSequence,
      params.lifecycleState,
      params.stopReason,
      params.eventType,
      params.payload ? JSON.stringify(params.payload) : null,
    );

    await db.exec("COMMIT;");
  } catch (error) {
    await db.exec("ROLLBACK;");
    throw error;
  }
  });
};

export const safePersistRunLifecycleEvent = async (
  params: Parameters<typeof persistRunLifecycleEvent>[0],
): Promise<void> => {
  try {
    await persistRunLifecycleEvent(params);
  } catch (error) {
    const err = error as Error;
    console.warn("[agent] Failed to persist run lifecycle event:", err.message);
  }
};

export const requestRunCancellation = async (runId: string): Promise<boolean> => {
  return enqueueWrite(async () => {
    const db = await getRunStore();
    const result = await db.run(
      `
        UPDATE agent_runs
        SET cancel_requested = 1,
            cancel_requested_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE run_id = ?
      `,
      runId,
    );

    return typeof result?.changes === "number" && result.changes > 0;
  });
};

export const isRunCancellationRequested = async (runId: string): Promise<boolean> => {
  const db = await getRunStore();
  const row = (await db.get(
    "SELECT cancel_requested FROM agent_runs WHERE run_id = ?",
    runId,
  )) as { cancel_requested?: number | null } | undefined;

  return Number(row?.cancel_requested || 0) === 1;
};

export const clearRunCancellationRequest = async (runId: string): Promise<void> => {
  return enqueueWrite(async () => {
    const db = await getRunStore();
    await db.run(
      `
        UPDATE agent_runs
        SET cancel_requested = 0,
            cancel_requested_at = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE run_id = ?
      `,
      runId,
    );
  });
};

const deleteRunData = async (runId: string): Promise<void> => {
  return enqueueWrite(async () => {
    const db = await getRunStore();
    await db.exec("BEGIN IMMEDIATE TRANSACTION;");

    try {
      await db.run("DELETE FROM agent_run_checkpoints WHERE run_id = ?", runId);
      await db.run("DELETE FROM agent_runs WHERE run_id = ?", runId);
      await db.exec("COMMIT;");
    } catch (error) {
      await db.exec("ROLLBACK;");
      throw error;
    }
  });
};

export const deleteRunDataBatch = async (runIds: string[]): Promise<void> => {
  const uniqueSafeRunIds = Array.from(
    new Set(runIds.map((value) => value.trim()).filter((value) => isSafeRunId(value))),
  );

  for (const runId of uniqueSafeRunIds) {
    await deleteRunData(runId);
  }
};

export const getRunSnapshot = async (runId: string): Promise<{
  run: AgentRunRow;
  latestCheckpoint: AgentRunCheckpointRow | null;
} | null> => {
  const db = await getRunStore();
  const run = (await db.get(
    `
      SELECT
        run_id,
        status,
        stop_reason,
        objective,
        workspace_path,
        model_id,
        cancel_requested,
        cancel_requested_at,
        created_at,
        updated_at
      FROM agent_runs
      WHERE run_id = ?
    `,
    runId,
  )) as AgentRunRow | undefined;

  if (!run) return null;

  const latestCheckpoint = (await db.get(
    `
      SELECT
        run_id,
        sequence,
        lifecycle_state,
        stop_reason,
        event_type,
        payload_json,
        created_at
      FROM agent_run_checkpoints
      WHERE run_id = ?
      ORDER BY sequence DESC
      LIMIT 1
    `,
    runId,
  )) as AgentRunCheckpointRow | undefined;

  return {
    run,
    latestCheckpoint: latestCheckpoint || null,
  };
};

export const listRunEvents = async (
  runId: string,
  afterSequence: number,
  limit: number,
): Promise<AgentRunCheckpointRow[]> => {
  const db = await getRunStore();
  return (await db.all(
    `
      SELECT
        run_id,
        sequence,
        lifecycle_state,
        stop_reason,
        event_type,
        payload_json,
        created_at
      FROM agent_run_checkpoints
      WHERE run_id = ? AND sequence > ?
      ORDER BY sequence ASC
      LIMIT ?
    `,
    runId,
    Math.max(0, afterSequence),
    Math.max(1, Math.min(500, limit)),
  )) as AgentRunCheckpointRow[];
};

export const asRunLifecycleState = (value: string | undefined): RunLifecycleState => {
  const valid: RunLifecycleState[] = [
    "queued",
    "running",
    "waiting_tool",
    "waiting_confirmation",
    "waiting_user_input",
    "paused",
    "succeeded",
    "failed",
    "cancelled",
  ];

  if (value && (valid as string[]).includes(value)) {
    return value as RunLifecycleState;
  }

  return "running";
};
