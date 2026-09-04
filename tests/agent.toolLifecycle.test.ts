import {
  countUniqueToolCalls,
  normalizeToolLifecycle,
  resolveToolExecutionStatus,
  type ExecutedToolResult,
  type PendingToolCall,
} from "../api/core/agent/utils/toolLifecycle";

describe("normalizeToolLifecycle", () => {
  it("keeps only terminal executed result for the same tool call", () => {
    const pending: PendingToolCall[] = [];
    const executed: ExecutedToolResult[] = [
      {
        name: "runTerminalCommand",
        args: { command: "npm test" },
        toolCallId: "tool-1",
        result: { status: "in_progress", output: "running" },
      },
      {
        name: "runTerminalCommand",
        args: { command: "npm test" },
        toolCallId: "tool-1",
        result: { status: "completed", output: "ok" },
      },
    ];

    const normalized = normalizeToolLifecycle(pending, executed);

    expect(normalized.executedToolResults).toHaveLength(1);
    expect(normalized.executedToolResults[0].result).toEqual({
      status: "completed",
      output: "ok",
    });
  });

  it("drops pending tool calls that already have an executed result", () => {
    const pending: PendingToolCall[] = [
      {
        name: "readFile",
        args: { filePath: "src/index.ts" },
        toolCallId: "tool-2",
      },
    ];
    const executed: ExecutedToolResult[] = [
      {
        name: "readFile",
        args: { filePath: "src/index.ts" },
        toolCallId: "tool-2",
        result: { status: "completed", content: "hello" },
      },
    ];

    const normalized = normalizeToolLifecycle(pending, executed);

    expect(normalized.pendingToolCalls).toHaveLength(0);
    expect(normalized.executedToolResults).toHaveLength(1);
  });

  it("keeps a pending call until a terminal result arrives", () => {
    const normalized = normalizeToolLifecycle(
      [
        {
          name: "readFile",
          args: { filePath: "src/index.ts" },
          toolCallId: "tool-3",
        },
      ],
      [
        {
          name: "readFile",
          args: { filePath: "src/index.ts" },
          toolCallId: "tool-3",
          result: { status: "in_progress", output: "still running" },
        },
      ],
    );

    expect(normalized.pendingToolCalls).toHaveLength(1);
    expect(normalized.executedToolResults).toHaveLength(1);
    expect(normalized.pendingToolCalls[0]).toEqual({
      name: "readFile",
      args: { filePath: "src/index.ts" },
      toolCallId: "tool-3",
    });
  });

  it("removes a pending call once it requires confirmation without making it terminal", () => {
    const result = {
      status: "pending_confirmation",
      confirmationId: "confirm-1",
      command: "git status",
    };
    const normalized = normalizeToolLifecycle(
      [
        {
          name: "runTerminalCommand",
          args: { command: "git status" },
          toolCallId: "tool-confirmation",
        },
      ],
      [
        {
          name: "runTerminalCommand",
          args: { command: "git status" },
          toolCallId: "tool-confirmation",
          result,
        },
      ],
    );

    expect(resolveToolExecutionStatus(result)).toBe("pending_confirmation");
    expect(normalized.pendingToolCalls).toEqual([]);
    expect(normalized.executedToolResults).toHaveLength(1);
  });

  it("reconciles anonymous confirmation results one-for-one", () => {
    const call: PendingToolCall = {
      name: "runTerminalCommand",
      args: { command: "git status" },
    };
    const normalized = normalizeToolLifecycle(
      [call, call],
      [
        {
          ...call,
          result: {
            status: "pending_confirmation",
            confirmationId: "confirm-1",
          },
        },
      ],
    );

    expect(normalized.pendingToolCalls).toHaveLength(1);
    expect(normalized.executedToolResults).toHaveLength(1);
  });

  it("treats opaque results as terminal unless they explicitly say they are in progress", () => {
    const normalized = normalizeToolLifecycle(
      [
        {
          name: "readFile",
          args: { filePath: "src/index.ts" },
          toolCallId: "tool-opaque",
        },
        {
          name: "readFile",
          args: { filePath: "src/index.ts" },
          toolCallId: "tool-progress",
        },
      ],
      [
        {
          name: "readFile",
          args: { filePath: "src/index.ts" },
          toolCallId: "tool-opaque",
          result: { content: "hello" },
        },
        {
          name: "readFile",
          args: { filePath: "src/index.ts" },
          toolCallId: "tool-progress",
          result: { status: "in_progress", output: "still running" },
        },
      ],
    );

    expect(normalized.pendingToolCalls).toHaveLength(1);
    expect(normalized.pendingToolCalls[0]).toEqual({
      name: "readFile",
      args: { filePath: "src/index.ts" },
      toolCallId: "tool-progress",
    });
    expect(normalized.executedToolResults).toHaveLength(2);
  });

  it("treats raw string results as completed payloads", () => {
    const normalized = normalizeToolLifecycle(
      [
        {
          name: "listFiles",
          args: { path: "src" },
          toolCallId: "tool-string",
        },
        {
          name: "listFiles",
          args: { path: "src" },
          toolCallId: "tool-reserved-string",
        },
      ],
      [
        {
          name: "listFiles",
          args: { path: "src" },
          toolCallId: "tool-string",
          result: "opaque output",
        },
        {
          name: "listFiles",
          args: { path: "src" },
          toolCallId: "tool-reserved-string",
          result: "error",
        },
      ],
    );

    expect(normalized.pendingToolCalls).toHaveLength(0);
    expect(normalized.executedToolResults).toHaveLength(2);
    for (const payload of [
      "opaque output",
      "in_progress",
      "error",
      "pending_confirmation",
    ]) {
      expect(resolveToolExecutionStatus(payload)).toBe("completed");
    }
    expect(resolveToolExecutionStatus({ status: "in_progress" })).toBe(
      "in_progress",
    );
    expect(resolveToolExecutionStatus({ status: "failed" })).toBe("failed");
    expect(resolveToolExecutionStatus({ status: "pending_confirmation" })).toBe(
      "pending_confirmation",
    );
  });

  it("treats a successful background-task launch as terminal even when status is in_progress", () => {
    const pending: PendingToolCall[] = [
      {
        name: "executeCommand",
        args: { command: "npm run dev", runInBackground: true },
        toolCallId: "tool-background",
      },
    ];
    const executed: ExecutedToolResult[] = [
      {
        name: "executeCommand",
        args: { command: "npm run dev", runInBackground: true },
        toolCallId: "tool-background",
        result: {
          success: true,
          status: "in_progress",
          taskId: "bg-task-42",
        },
      },
    ];

    const normalized = normalizeToolLifecycle(pending, executed);

    expect(resolveToolExecutionStatus(executed[0].result)).toBe("completed");
    expect(normalized.pendingToolCalls).toHaveLength(0);
    expect(normalized.executedToolResults).toHaveLength(1);
  });

  it("counts unique tool invocations once when the same call appears in pending and executed snapshots", () => {
    const pending: PendingToolCall[] = [
      {
        name: "executeCommand",
        args: { command: "npm test" },
        toolCallId: "tool-usage-1",
      },
      {
        name: "readFile",
        args: { filePath: "src/index.ts" },
        toolCallId: "tool-usage-2",
      },
    ];
    const executed: ExecutedToolResult[] = [
      {
        name: "executeCommand",
        args: { command: "npm test" },
        toolCallId: "tool-usage-1",
        result: { status: "completed" },
      },
    ];

    expect(countUniqueToolCalls(pending, executed)).toBe(2);
  });

  it("counts repeated invocations with distinct tool call IDs separately", () => {
    const executed: ExecutedToolResult[] = [
      {
        name: "readFile",
        args: { filePath: "src/index.ts" },
        toolCallId: "tool-repeat-1",
        result: { status: "completed" },
      },
      {
        name: "readFile",
        args: { filePath: "src/index.ts" },
        toolCallId: "tool-repeat-2",
        result: { status: "completed" },
      },
    ];

    expect(countUniqueToolCalls([], executed)).toBe(2);
  });

  it("preserves anonymous result multiplicity when counting pre-normalized results", () => {
    const executed: ExecutedToolResult[] = [
      {
        name: "readFile",
        args: { filePath: "src/index.ts" },
        result: { status: "completed" },
      },
      {
        name: "readFile",
        args: { filePath: "src/index.ts" },
        result: { status: "completed" },
      },
    ];

    expect(countUniqueToolCalls([], executed)).toBe(2);
  });

  it("counts an anonymous pending call and its in-progress result once", () => {
    const pending: PendingToolCall[] = [
      {
        name: "readFile",
        args: { filePath: "src/index.ts" },
      },
    ];
    const executed: ExecutedToolResult[] = [
      {
        name: "readFile",
        args: { filePath: "src/index.ts" },
        result: { status: "in_progress" },
      },
    ];

    expect(countUniqueToolCalls(pending, executed)).toBe(1);
  });

  it("counts an identified and an anonymous pending call additively", () => {
    const pending: PendingToolCall[] = [
      {
        name: "readFile",
        args: { filePath: "src/index.ts" },
        toolCallId: "identified-call",
      },
      {
        name: "readFile",
        args: { filePath: "src/index.ts" },
      },
    ];
    const normalized = normalizeToolLifecycle(pending, []);

    expect(normalized.pendingToolCalls).toHaveLength(2);
    expect(
      countUniqueToolCalls(
        normalized.pendingToolCalls,
        normalized.executedToolResults,
      ),
    ).toBe(2);
  });

  it("counts an identified pending call and its anonymous in-progress result once", () => {
    const pending: PendingToolCall[] = [
      {
        name: "readFile",
        args: { filePath: "src/index.ts" },
        toolCallId: "tool-usage-anonymous-result",
      },
    ];
    const executed: ExecutedToolResult[] = [
      {
        name: "readFile",
        args: { filePath: "src/index.ts" },
        result: { status: "in_progress" },
      },
    ];
    const normalized = normalizeToolLifecycle(pending, executed);

    expect(normalized.pendingToolCalls).toHaveLength(1);
    expect(
      countUniqueToolCalls(
        normalized.pendingToolCalls,
        normalized.executedToolResults,
      ),
    ).toBe(1);
  });

  it("reconciles an identified pending call with an anonymous settled result", () => {
    const pending: PendingToolCall[] = [
      {
        name: "readFile",
        args: { filePath: "src/index.ts" },
        toolCallId: "identified-call",
      },
    ];
    const executed: ExecutedToolResult[] = [
      {
        name: "readFile",
        args: { filePath: "src/index.ts" },
        result: { status: "completed", content: "hello" },
      },
    ];
    const normalized = normalizeToolLifecycle(pending, executed);

    expect(normalized.pendingToolCalls).toEqual([]);
    expect(normalized.executedToolResults).toHaveLength(1);
  });

  it("reconciles anonymous calls by signature multiplicity", () => {
    const call: PendingToolCall = {
      name: "readFile",
      args: { filePath: "src/index.ts" },
    };
    const oneExecutedCall: ExecutedToolResult[] = [
      { ...call, result: { status: "completed" } },
    ];
    const twoExecutedCalls: ExecutedToolResult[] = [
      { ...call, result: { status: "in_progress" } },
      { ...call, result: { status: "completed" } },
    ];

    expect(countUniqueToolCalls([call, call], oneExecutedCall)).toBe(2);
    expect(countUniqueToolCalls([call], twoExecutedCalls)).toBe(1);
  });

  it("keeps a tool call pending when its result payload is missing", () => {
    const normalized = normalizeToolLifecycle(
      [
        {
          name: "readFile",
          args: { filePath: "src/index.ts" },
          toolCallId: "missing-result",
        },
      ],
      [
        {
          name: "readFile",
          args: { filePath: "src/index.ts" },
          toolCallId: "missing-result",
          result: undefined,
        },
      ],
    );

    expect(resolveToolExecutionStatus(undefined)).toBe("unknown");
    expect(normalized.pendingToolCalls).toHaveLength(1);
    expect(normalized.executedToolResults).toHaveLength(1);
  });

  it("matches a completed result that is missing the pending call ID", () => {
    const normalized = normalizeToolLifecycle(
      [
        {
          name: "updateWorkingMemory",
          args: { content: "Verified the fix." },
          toolCallId: "call_19",
        },
      ],
      [
        {
          name: "updateWorkingMemory",
          args: { content: "Verified the fix." },
          result: { status: "completed" },
        },
      ],
    );

    expect(normalized.pendingToolCalls).toEqual([]);
    expect(normalized.executedToolResults).toHaveLength(1);
  });

  it("consumes anonymous results one-for-one for same-signature pending calls", () => {
    const normalized = normalizeToolLifecycle(
      [
        {
          name: "readFile",
          args: { filePath: "src/index.ts" },
        },
        {
          name: "readFile",
          args: { filePath: "src/index.ts" },
        },
      ],
      [
        {
          name: "readFile",
          args: { filePath: "src/index.ts" },
          result: { status: "completed", content: "hello" },
        },
      ],
    );

    expect(normalized.pendingToolCalls).toHaveLength(1);
    expect(normalized.executedToolResults).toHaveLength(1);
  });

  it("preserves distinct anonymous results while consuming matching pending calls", () => {
    const call: PendingToolCall = {
      name: "readFile",
      args: { filePath: "src/index.ts" },
    };
    const normalized = normalizeToolLifecycle(
      [call, call],
      [
        { ...call, result: { status: "completed", content: "first" } },
        { ...call, result: { status: "completed", content: "second" } },
      ],
    );

    expect(normalized.pendingToolCalls).toEqual([]);
    expect(normalized.executedToolResults).toHaveLength(2);
  });

  it("preserves repeated pending calls when toolCallId is missing", () => {
    const pending: PendingToolCall[] = [
      {
        name: "grepSearch",
        args: { pattern: "foo", path: "src" },
      },
      {
        name: "grepSearch",
        args: { path: "src", pattern: "foo" },
      },
    ];

    const normalized = normalizeToolLifecycle(pending, []);

    expect(normalized.pendingToolCalls).toHaveLength(2);
    expect(normalized.pendingToolCalls).toEqual(pending);
  });

  it("collapses changed in-progress payloads into one anonymous invocation", () => {
    const call: PendingToolCall = {
      name: "readFile",
      args: { filePath: "src/index.ts" },
    };
    const normalized = normalizeToolLifecycle(
      [call],
      [
        { ...call, result: { status: "in_progress", output: "10%" } },
        { ...call, result: { status: "in_progress", output: "20%" } },
      ],
    );

    expect(normalized.executedToolResults).toHaveLength(1);
    expect(normalized.executedToolResults[0].result).toEqual({
      status: "in_progress",
      output: "20%",
    });
  });

  it("replaces a corrected anonymous terminal result after allocating its pending slot", () => {
    const call: PendingToolCall = {
      name: "readFile",
      args: { filePath: "src/index.ts" },
    };
    const normalized = normalizeToolLifecycle(
      [call],
      [
        { ...call, result: { status: "failed", error: "temporary failure" } },
        { ...call, result: { status: "completed", content: "hello" } },
      ],
    );

    expect(normalized.pendingToolCalls).toEqual([]);
    expect(normalized.executedToolResults).toHaveLength(1);
    expect(normalized.executedToolResults[0].result).toEqual({
      status: "completed",
      content: "hello",
    });
  });

  it("preserves distinct anonymous terminal results when there are no pending calls", () => {
    const call: PendingToolCall = {
      name: "readFile",
      args: { filePath: "src/index.ts" },
    };
    const normalized = normalizeToolLifecycle(
      [],
      [
        { ...call, result: { status: "completed", content: "first" } },
        { ...call, result: { status: "completed", content: "second" } },
      ],
    );

    expect(normalized.executedToolResults).toHaveLength(2);
    expect(
      normalized.executedToolResults.map((result) => result.result),
    ).toEqual([
      { status: "completed", content: "first" },
      { status: "completed", content: "second" },
    ]);
  });

  it("preserves distinct anonymous terminal results from different lifecycle steps", () => {
    const call: PendingToolCall = {
      name: "readFile",
      args: { filePath: "src/index.ts" },
    };
    const normalized = normalizeToolLifecycle(
      [call],
      [
        {
          ...call,
          lifecycleStepIndex: 0,
          result: { status: "completed", content: "first" },
        },
        {
          ...call,
          lifecycleStepIndex: 1,
          result: { status: "completed", content: "second" },
        },
      ],
    );

    expect(normalized.pendingToolCalls).toEqual([]);
    expect(normalized.executedToolResults).toHaveLength(2);
    expect(
      normalized.executedToolResults.map((result) => result.result),
    ).toEqual([
      { status: "completed", content: "first" },
      { status: "completed", content: "second" },
    ]);
  });

  it("preserves equal anonymous terminal results from different lifecycle steps", () => {
    const call: PendingToolCall = {
      name: "readFile",
      args: { filePath: "src/index.ts" },
    };
    const terminalResult = { status: "completed", content: "same" };
    const normalized = normalizeToolLifecycle(
      [call],
      [
        {
          ...call,
          lifecycleStepIndex: 0,
          result: terminalResult,
        },
        {
          ...call,
          lifecycleStepIndex: 1,
          result: terminalResult,
        },
      ],
    );

    expect(normalized.pendingToolCalls).toEqual([]);
    expect(normalized.executedToolResults).toHaveLength(2);
    expect(
      normalized.executedToolResults.map((result) => result.result),
    ).toEqual([terminalResult, terminalResult]);
  });

  it("replaces a corrected anonymous terminal result settling an identified pending call", () => {
    const normalized = normalizeToolLifecycle(
      [
        {
          name: "readFile",
          args: { filePath: "src/index.ts" },
          toolCallId: "identified-call",
        },
      ],
      [
        {
          name: "readFile",
          args: { filePath: "src/index.ts" },
          result: { status: "failed", error: "temporary failure" },
        },
        {
          name: "readFile",
          args: { filePath: "src/index.ts" },
          result: { status: "completed", content: "hello" },
        },
      ],
    );

    expect(normalized.pendingToolCalls).toEqual([]);
    expect(normalized.executedToolResults).toHaveLength(1);
    expect(normalized.executedToolResults[0].result).toEqual({
      status: "completed",
      content: "hello",
    });
  });
});
