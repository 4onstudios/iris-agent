import { PassThrough } from "node:stream";
import {
  createCliChatUi,
  createPlainChatUi,
  getOpenTuiRuntimeError,
  type CliChatUi,
} from "../api/core/library/cliChatUi";
import { runCliChatTurn } from "../api/core/library/cliChatTurn";

const mockOpenTui = jest.fn();
jest.mock("../api/core/library/cliOpenTui", () => ({
  createOpenTuiChatUi: (...args: unknown[]) => mockOpenTui(...args),
}));

const makeUi = (): jest.Mocked<CliChatUi> => ({
  readInput: jest.fn(),
  beginTurn: jest.fn(),
  appendText: jest.fn(),
  toolCall: jest.fn(),
  toolResult: jest.fn(),
  setStatus: jest.fn(),
  showError: jest.fn(),
  finishTurn: jest.fn(),
  dispose: jest.fn(),
});
const chunks = (
  ...values: Array<{ type: string; payload?: Record<string, unknown> }>
) =>
  new ReadableStream({
    start(controller) {
      for (const value of values) controller.enqueue(value);
      controller.close();
    },
  });

describe("CLI chat runtime selection", () => {
  it("requires a compatible runtime and Node FFI", () => {
    expect(getOpenTuiRuntimeError({ node: "22.13.0" }, [], "")).toContain(
      "Bun",
    );
    expect(
      getOpenTuiRuntimeError({ node: "26.3.0" }, ["--experimental-ffi"], ""),
    ).toBeDefined();
    expect(getOpenTuiRuntimeError({ node: "26.4.0" }, [], "")).toBeDefined();
    expect(
      getOpenTuiRuntimeError({ node: "26.4.0" }, ["--experimental-ffi"], ""),
    ).toBeUndefined();
    expect(
      getOpenTuiRuntimeError({ node: "27.0.0" }, [], "--experimental-ffi"),
    ).toBeUndefined();
    expect(
      getOpenTuiRuntimeError(
        { node: "26.4.0" },
        ["--no-experimental-ffi"],
        "--experimental-ffi",
      ),
    ).toBeDefined();
    expect(
      getOpenTuiRuntimeError({ node: "24.0.0", bun: "1.3.0" }, [], ""),
    ).toBeUndefined();
    expect(getOpenTuiRuntimeError({ bun: "1.2.9" }, [], "")).toBeDefined();
  });

  it("does not load OpenTUI in plain mode", async () => {
    const ui = await createCliChatUi({ mode: "plain" });
    try {
      expect(mockOpenTui).not.toHaveBeenCalled();
    } finally {
      ui.dispose();
    }
  });

  it.each([
    ["--no-experimental-ffi", ["--experimental-ffi"], true],
    ["--experimental-ffi", ["--no-experimental-ffi"], false],
    ["--experimental-ffi --no-experimental-ffi", [], false],
    ["--no-experimental-ffi --experimental-ffi", [], true],
    ["", ["--no-experimental-ffi", "--experimental-ffi"], true],
    ["", ["--experimental-ffi", "--no-experimental-ffi"], false],
  ])("applies Node flag precedence for %s and %j", (nodeOptions, execArgv, enabled) => {
    expect(
      getOpenTuiRuntimeError({ node: "26.4.0" }, execArgv, nodeOptions) === undefined,
    ).toBe(enabled);
  });
});

describe("plain chat input", () => {
  it("retains piped messages through EOF", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const ui = createPlainChatUi(input, output);
    try {
      const first = ui.readInput();
      input.end("first\nsecond\n");
      expect(await first).toBe("first");
      expect(await ui.readInput()).toBe("second");
      expect(await ui.readInput()).toBeNull();
    } finally {
      ui.dispose();
    }
  });

  it("settles a waiting prompt when input closes and removes signal listeners", async () => {
    const before = process.listenerCount("SIGINT");
    const input = new PassThrough();
    const ui = createPlainChatUi(input, new PassThrough());
    const waiting = ui.readInput();
    input.end();
    expect(await waiting).toBeNull();
    ui.dispose();
    expect(process.listenerCount("SIGINT")).toBe(before);
  });
});

describe("CLI agent stream", () => {
  it("updates the UI before the stream completes and keeps the memory scope", async () => {
    const ui = makeUi();
    const controller = new AbortController();
    let source: ReadableStreamDefaultController<any>;
    let resolveDelta: () => void;
    const deltaSeen = new Promise<void>((resolve) => {
      resolveDelta = resolve;
    });
    ui.appendText.mockImplementation(() => resolveDelta());
    const stream = new ReadableStream({
      start(value) {
        source = value;
      },
    });
    const agent = { stream: jest.fn(async () => ({ fullStream: stream })) };
    const memory = { thread: "same-thread", resource: "cli-session" };
    const turn = runCliChatTurn(
      agent,
      "  code\n    next line",
      { memory, maxSteps: 50 },
      ui,
      controller.signal,
    );
    source.enqueue({
      type: "text-delta",
      payload: { text: "Partial response" },
    });
    await deltaSeen;
    expect(ui.appendText).toHaveBeenCalledWith("Partial response");
    expect(agent.stream).toHaveBeenCalledWith("  code\n    next line", {
      memory,
      maxSteps: 50,
      abortSignal: controller.signal,
    });
    source.close();
    await turn;
    expect(stream.locked).toBe(false);
  });

  it("keeps concurrent calls running through progress results and labels failures/approval", async () => {
    const ui = makeUi();
    const stream = chunks(
      {
        type: "tool-call",
        payload: { toolCallId: "same", toolName: "readFile" },
      },
      {
        type: "tool-call",
        payload: { toolCallId: "same", toolName: "readFile" },
      },
      {
        type: "tool-result",
        payload: { toolCallId: "same", result: { status: "in_progress" } },
      },
      {
        type: "tool-result",
        payload: { toolCallId: "same", result: { status: "completed" } },
      },
      {
        type: "tool-error",
        payload: { toolCallId: "same", toolName: "readFile" },
      },
      { type: "tool-call", payload: { toolName: "executeCommand" } },
      {
        type: "tool-result",
        payload: {
          toolName: "executeCommand",
          result: { status: "pending_confirmation" },
        },
      },
      { type: "text-delta", payload: { text: "Done" } },
    );
    await runCliChatTurn(
      { stream: async () => ({ fullStream: stream }) },
      "hello",
      {},
      ui,
      new AbortController().signal,
    );
    expect(ui.toolResult.mock.calls.map(([status]) => status)).toEqual([
      "in_progress",
      "completed",
      "failed",
      "pending_confirmation",
    ]);
    expect(ui.setStatus.mock.calls.map(([status]) => status)).toEqual([
      "Thinking...",
      "Running readFile...",
      "Running tools...",
      "Thinking...",
      "Running executeCommand...",
      "Thinking...",
      "Responding...",
    ]);
  });

  it("cancels a blocked read, propagates the abort signal, and releases the reader", async () => {
    const cancelStream = jest.fn();
    const stream = new ReadableStream({ cancel: cancelStream });
    const controller = new AbortController();
    const ui = makeUi();
    const turn = runCliChatTurn(
      {
        stream: async (_prompt, options) => {
          expect(options.abortSignal).toBe(controller.signal);
          return { fullStream: stream };
        },
      },
      "hello",
      {},
      ui,
      controller.signal,
    );
    await Promise.resolve();
    controller.abort();
    await expect(turn).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelStream).toHaveBeenCalledTimes(1);
    expect(ui.appendText).not.toHaveBeenCalled();
    expect(stream.locked).toBe(false);
  });

  it("surfaces provider error chunks and releases the reader on failure", async () => {
    const error = { message: "Invalid key", statusCode: 401 };
    const stream = chunks({ type: "error", payload: { error } });
    await expect(
      runCliChatTurn(
        { stream: async () => ({ fullStream: stream }) },
        "hello",
        {},
        makeUi(),
        new AbortController().signal,
      ),
    ).rejects.toBe(error);
    expect(stream.locked).toBe(false);
  });

  it("uses final text when there are no deltas and retains generate-only agents", async () => {
    const ui = makeUi();
    await runCliChatTurn(
      {
        stream: async () => ({
          fullStream: chunks(),
          text: Promise.resolve("Final text"),
        }),
      },
      "hello",
      {},
      ui,
      new AbortController().signal,
    );
    expect(ui.appendText).toHaveBeenLastCalledWith("Final text");
    await runCliChatTurn(
      { generate: async () => ({ text: "Generated text" }) },
      "hello",
      {},
      ui,
      new AbortController().signal,
    );
    expect(ui.appendText).toHaveBeenLastCalledWith("Generated text");
  });
});
