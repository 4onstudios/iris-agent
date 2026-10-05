import { createInterface } from "node:readline";
import { isCliSpinnerEnabled, startCliSpinner } from "./cliSpinner";
import { renderCliMarkdown } from "./cliMarkdown";
import type { ToolExecutionStatus } from "../agent/utils/toolLifecycle";

export type CliChatUiMode = "auto" | "opentui" | "plain";
export type CliChatTurnOutcome = "completed" | "cancelled" | "failed";

export interface CliChatUi {
  readInput(): Promise<string | null>;
  beginTurn(input: string, cancel: () => void): void;
  appendText(text: string): void;
  toolCall(name: string, id?: string): void;
  toolResult(status: ToolExecutionStatus, id?: string, name?: string): void;
  setStatus(label: string): void;
  showError(message: string, hint?: string): void;
  finishTurn(outcome: CliChatTurnOutcome): void;
  dispose(): void;
}

export interface CliChatUiOptions {
  mode?: CliChatUiMode;
  workspaceRoot?: string;
  modelId?: string;
}

export const OPENTUI_RUNTIME_HINT =
  "OpenTUI chat needs Bun >=1.3.0, or Node.js >=26.4.0 with --experimental-ffi. " +
  "Run bun dist/cli.js --chat, or node --experimental-ffi dist/cli.js --chat. " +
  "Use --chat-ui plain for the readline interface.";

export const getOpenTuiRuntimeError = (
  versions: { node?: string; bun?: string } = process.versions,
  execArgv: readonly string[] = process.execArgv,
  nodeOptions = process.env.NODE_OPTIONS || "",
): string | undefined => {
  const atLeast = (
    version: string | undefined,
    major: number,
    minor: number,
  ) => {
    const parts = /^(\d+)\.(\d+)/.exec(version || "");
    return Boolean(
      parts &&
      (+parts[1] > major || (+parts[1] === major && +parts[2] >= minor)),
    );
  };
  if (versions.bun) {
    return atLeast(versions.bun, 1, 3) ? undefined : OPENTUI_RUNTIME_HINT;
  }
  const flags = [...nodeOptions.split(/\s+/), ...execArgv];
  let ffiEnabled = false;
  for (const flag of flags) {
    if (flag === "--experimental-ffi") ffiEnabled = true;
    else if (flag === "--no-experimental-ffi") ffiEnabled = false;
  }
  return atLeast(versions.node, 26, 4) && ffiEnabled
    ? undefined
    : OPENTUI_RUNTIME_HINT;
};

export const createCliChatUi = async (
  options: CliChatUiOptions,
): Promise<CliChatUi> => {
  const mode = options.mode || "auto";
  const terminal = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (
    mode === "plain" ||
    (mode === "auto" &&
      (!terminal || process.env.CI || process.env.TERM === "dumb"))
  ) {
    return createPlainChatUi();
  }
  if (!terminal) {
    throw new Error(
      "OpenTUI chat requires an interactive terminal. Use --chat-ui plain for piped input/output.",
    );
  }
  const runtimeError = getOpenTuiRuntimeError();
  if (runtimeError) {
    if (mode === "opentui") throw new Error(runtimeError);
    console.warn(`Using plain chat. ${runtimeError}`);
    return createPlainChatUi();
  }
  try {
    // The HTTP service, SDK, ACP transport and plain chat never load native UI code.
    // Keep optional native code outside the compile-time dependency graph.
    const modulePath = "./cliOpenTui.js";
    const { createOpenTuiChatUi }: {
      createOpenTuiChatUi(options: CliChatUiOptions): Promise<CliChatUi>;
    } = await import(modulePath);
    return await createOpenTuiChatUi(options);
  } catch (error) {
    if (mode === "opentui") throw error;
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Unable to start OpenTUI; using plain chat: ${message}`);
    return createPlainChatUi();
  }
};

export const createPlainChatUi = (
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): CliChatUi => {
  const rl = createInterface({ input, output });
  const queued: string[] = [];
  let pendingInput: ((value: string | null) => void) | undefined;
  let ended = false;
  let stopped = false;
  let markdown = "";
  let cancel: (() => void) | undefined;
  let stopSpinner = () => {};

  const resolveInput = (value: string | null) => {
    const resolve = pendingInput;
    pendingInput = undefined;
    resolve?.(value);
  };
  const close = () => {
    stopped = true;
    queued.length = 0;
    cancel?.();
    resolveInput(null);
    rl.close();
  };
  const interrupt = () => {
    if (cancel) {
      cancel();
    } else {
      close();
    }
  };
  const terminate = () => {
    process.exitCode = 143;
    close();
  };
  const disconnect = () => {
    process.exitCode = 129;
    close();
  };
  rl.on("line", (line) => {
    if (pendingInput) resolveInput(line);
    else queued.push(line);
  });
  rl.on("close", () => {
    ended = true;
    resolveInput(null);
  });
  rl.on("SIGINT", interrupt);
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  process.on("SIGHUP", disconnect);

  return {
    readInput: async () => {
      if (stopped) return null;
      if (queued.length) return queued.shift()!;
      if (ended) return null;
      return new Promise<string | null>((resolve) => {
        pendingInput = resolve;
        rl.setPrompt("\n> ");
        rl.prompt();
      });
    },
    beginTurn: (_input, onCancel) => {
      markdown = "";
      cancel = onCancel;
    },
    appendText: (text) => {
      markdown += text;
    },
    toolCall: (name) => {
      stopSpinner();
      output.write(`\n⚙️  [Calling tool: ${name}]...\n`);
    },
    toolResult: (status) => {
      if (status === "pending_confirmation") {
        output.write("approval required.\n");
      } else if (status === "failed") {
        output.write("failed.\n");
      } else if (
        status !== "pending" &&
        status !== "in_progress" &&
        !isCliSpinnerEnabled()
      ) {
        output.write("done.\n");
      }
    },
    setStatus: (label) => {
      stopSpinner();
      stopSpinner = startCliSpinner(label);
    },
    showError: (message, hint) => {
      stopSpinner();
      console.error(`❌ Error: ${message}`);
      if (hint) console.error(hint);
    },
    finishTurn: (outcome) => {
      stopSpinner();
      stopSpinner = () => {};
      cancel = undefined;
      if (markdown) output.write(renderCliMarkdown(markdown));
      if (outcome === "cancelled") output.write("\nCancelled.\n");
      output.write("\n");
    },
    dispose: () => {
      stopSpinner();
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
      process.off("SIGHUP", disconnect);
      close();
    },
  };
};
