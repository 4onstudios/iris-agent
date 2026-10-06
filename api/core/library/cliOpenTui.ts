import {
  BoxRenderable,
  CliRenderEvents,
  MarkdownRenderable,
  ScrollBoxRenderable,
  SyntaxStyle,
  TextareaRenderable,
  TextRenderable,
  createCliRenderer,
  type CliRenderer,
  type CliRendererConfig,
  type KeyEvent,
} from "@opentui/core";
import type { CliChatUi, CliChatUiOptions } from "./cliChatUi";
import type { ToolExecutionStatus } from "../agent/utils/toolLifecycle";

type ToolRow = {
  id?: string;
  name: string;
  status: ToolExecutionStatus;
  view: TextRenderable;
};
const theme = {
  bg: "#111820",
  panel: "#19232e",
  fg: "#dde7f1",
  muted: "#8c9cae",
  accent: "#73c7ec",
  error: "#ff8e8e",
};

export const chatRendererConfig = {
  screenMode: "alternate-screen",
  externalOutputMode: "passthrough",
  consoleMode: "console-overlay",
  openConsoleOnError: false,
  exitOnCtrlC: false,
  exitSignals: [],
  backgroundColor: theme.bg,
  targetFps: 30,
} satisfies CliRendererConfig;

export const createOpenTuiChatUi = async (
  options: CliChatUiOptions,
): Promise<CliChatUi> => {
  const renderer = await createCliRenderer(chatRendererConfig);
  try {
    return mountOpenTuiChatUi(renderer, options);
  } catch (error) {
    renderer.destroy();
    throw error;
  }
};

/** Separate mounting also permits tests with OpenTUI's real in-memory renderer. */
export const mountOpenTuiChatUi = (
  renderer: CliRenderer,
  options: CliChatUiOptions,
): CliChatUi => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: theme.fg },
    "markup.heading": { fg: theme.accent, bold: true },
    "markup.strong": { bold: true },
    "markup.italic": { italic: true },
    keyword: { fg: "#b59bea" },
    string: { fg: "#9fd7a3" },
    comment: { fg: theme.muted, italic: true },
    number: { fg: "#edc48e" },
  });
  // DESTROY is emitted before child teardown; release their shared style afterwards.
  renderer.once(CliRenderEvents.DESTROY, () =>
    queueMicrotask(() => syntaxStyle.destroy()),
  );
  let closed = false;
  let pendingInput: ((input: string | null) => void) | undefined;
  let cancel: (() => void) | undefined;
  let assistant: MarkdownRenderable | undefined;
  let sequence = 0;
  let toolRows: ToolRow[] = [];
  let busy = false;

  const layout = new BoxRenderable(renderer, {
    id: "chat",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    paddingX: 1,
  });
  const header = new TextRenderable(renderer, {
    id: "chat-header",
    content: `Iris Agent  •  ${options.modelId || "default model"}\n${options.workspaceRoot || process.cwd()}`,
    fg: theme.accent,
    flexShrink: 0,
    height: 2,
    wrapMode: "none",
  });
  const transcript = new ScrollBoxRenderable(renderer, {
    id: "chat-transcript",
    flexGrow: 1,
    flexShrink: 1,
    minHeight: 1,
    scrollY: true,
    scrollX: false,
    stickyScroll: true,
    stickyStart: "bottom",
    contentOptions: { flexDirection: "column", gap: 1, paddingRight: 1 },
  });
  const status = new TextRenderable(renderer, {
    id: "chat-status",
    content: "Ready",
    fg: theme.muted,
    height: 1,
    flexShrink: 0,
  });
  const composerBox = new BoxRenderable(renderer, {
    id: "chat-composer-box",
    border: true,
    borderColor: theme.accent,
    backgroundColor: theme.panel,
    flexShrink: 0,
    paddingX: 1,
  });
  const composer = new TextareaRenderable(renderer, {
    id: "chat-composer",
    minHeight: Math.min(3, Math.max(1, renderer.height - 7)),
    maxHeight: Math.max(1, Math.min(8, renderer.height - 7)),
    flexGrow: 1,
    wrapMode: "word",
    textColor: theme.fg,
    backgroundColor: theme.panel,
    focusedBackgroundColor: theme.panel,
    placeholder: "Message Iris…",
    cursorStyle: { style: "line", blinking: true },
    selectionOccupancy: "boundary",
    keyBindings: [
      { name: "return", action: "submit" },
      { name: "return", shift: true, action: "newline" },
      { name: "return", meta: true, action: "newline" },
      { name: "j", ctrl: true, action: "newline" },
      { name: "linefeed", action: "newline" },
    ],
    onSubmit: () => {
      if (closed) return;
      // Terminals without kitty/modifyOtherKeys send Shift+Enter as plain Enter;
      // a trailing backslash gives a portable line-continuation fallback.
      const cursor = composer.cursorOffset;
      if (cursor > 0 && composer.getTextRange(cursor - 1, cursor) === "\\") {
        composer.deleteCharBackward();
        composer.newLine();
        return;
      }
      if (busy || !pendingInput || !composer.plainText.trim()) return;
      const input = composer.plainText;
      composer.setText("");
      const resolve = pendingInput;
      pendingInput = undefined;
      resolve(input);
    },
  });
  const help = new TextRenderable(renderer, {
    id: "chat-help",
    content:
      "Enter send · Shift/Option+Enter, Ctrl+J or \\+Enter newline · Esc cancel · Ctrl+C cancel/quit · PgUp/PgDn scroll · Ctrl+L logs",
    fg: theme.muted,
    wrapMode: "none",
    height: 1,
    flexShrink: 0,
  });
  layout.add(header);
  layout.add(transcript);
  layout.add(status);
  composerBox.add(composer);
  layout.add(composerBox);
  layout.add(help);
  renderer.root.add(layout);
  composer.focus();

  const finishAssistant = () => {
    if (assistant) assistant.streaming = false;
    assistant = undefined;
  };
  const addText = (content: string, fg = theme.fg) => {
    transcript.add(
      new TextRenderable(renderer, {
        id: `chat-entry-${++sequence}`,
        content,
        fg,
        wrapMode: "word",
        flexShrink: 0,
      }),
    );
  };
  const close = () => renderer.destroy();
  const interrupt = () => {
    if (cancel) {
      status.content = "Cancelling...";
      cancel();
    } else close();
  };
  const terminate = () => {
    process.exitCode = 143;
    close();
  };
  const hangup = () => {
    process.exitCode = 129;
    close();
  };
  const resize = (_width: number, height: number) => {
    composer.minHeight = Math.min(3, Math.max(1, height - 7));
    composer.maxHeight = Math.max(1, Math.min(8, height - 7));
  };
  const cleanup = () => {
    if (closed) return;
    closed = true;
    cancel?.();
    pendingInput?.(null);
    pendingInput = undefined;
    renderer.keyInput.off("keypress", onKey);
    renderer.off(CliRenderEvents.RESIZE, resize);
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    process.off("SIGHUP", hangup);
  };
  const onKey = (key: KeyEvent) => {
    if (key.eventType === "release") return;
    if (key.name === "escape" && busy) {
      key.preventDefault();
      interrupt();
    } else if (key.ctrl && key.name === "c") {
      key.preventDefault();
      interrupt();
    } else if (key.ctrl && key.name === "d" && !composer.plainText && !busy) {
      key.preventDefault();
      close();
    } else if (key.name === "pageup" || key.name === "pagedown") {
      key.preventDefault();
      transcript.scrollBy(key.name === "pageup" ? -1 : 1, "viewport");
    } else if (key.ctrl && key.name === "l") {
      key.preventDefault();
      renderer.console.toggle();
      composer.focus();
    }
  };
  renderer.keyInput.on("keypress", onKey);
  renderer.on(CliRenderEvents.RESIZE, resize);
  renderer.once(CliRenderEvents.DESTROY, cleanup);
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  process.on("SIGHUP", hangup);

  const updateToolRow = (row: ToolRow) => {
    const label =
      row.status === "pending_confirmation"
        ? "approval required"
        : row.status === "in_progress" || row.status === "pending"
          ? "running"
          : row.status;
    row.view.content = `⚙ ${row.name} · ${label}`;
    row.view.fg = row.status === "failed" ? theme.error : theme.muted;
  };
  return {
    readInput: () =>
      closed
        ? Promise.resolve(null)
        : new Promise((resolve) => {
            pendingInput = resolve;
            composer.focus();
          }),
    beginTurn: (input, onCancel) => {
      if (closed) return;
      busy = true;
      cancel = onCancel;
      toolRows = [];
      finishAssistant();
      addText(`You\n${input}`, theme.accent);
      status.content = "Thinking...";
      transcript.scrollTo(transcript.scrollHeight);
    },
    appendText: (text) => {
      if (closed) return;
      if (!assistant) {
        addText("Iris", theme.muted);
        assistant = new MarkdownRenderable(renderer, {
          id: `chat-entry-${++sequence}`,
          content: "",
          syntaxStyle,
          fg: theme.fg,
          streaming: true,
          conceal: true,
          flexShrink: 0,
        });
        transcript.add(assistant);
      }
      assistant.content += text;
    },
    toolCall: (name, id) => {
      if (closed) return;
      finishAssistant();
      const view = new TextRenderable(renderer, {
        id: `chat-entry-${++sequence}`,
        fg: theme.muted,
        flexShrink: 0,
        wrapMode: "word",
      });
      const row: ToolRow = { id, name, status: "in_progress", view };
      toolRows.push(row);
      transcript.add(view);
      updateToolRow(row);
    },
    toolResult: (executionStatus, id, name) => {
      if (closed) return;
      const row = toolRows.find(
        (item) =>
          (id
            ? item.id === id
            : item.id === undefined && (!name || item.name === name)) &&
          (item.status === "pending" || item.status === "in_progress"),
      );
      if (row) {
        row.status = executionStatus;
        updateToolRow(row);
      } else {
        addText(
          `⚙ ${name || "tool"} · ${executionStatus}`,
          executionStatus === "failed" ? theme.error : theme.muted,
        );
      }
    },
    setStatus: (label) => {
      if (!closed) status.content = label;
    },
    showError: (message, hint) => {
      if (closed) return;
      finishAssistant();
      addText(`Error: ${message}${hint ? `\n${hint}` : ""}`, theme.error);
    },
    finishTurn: (outcome) => {
      if (closed) return;
      finishAssistant();
      for (const row of toolRows) {
        if (row.status === "in_progress" || row.status === "pending") {
          row.view.content = `⚙ ${row.name} · ${outcome === "cancelled" ? "cancelled" : "no final result"}`;
        }
      }
      if (outcome === "cancelled") addText("Cancelled.", theme.muted);
      busy = false;
      cancel = undefined;
      status.content = "Ready";
      composer.focus();
    },
    dispose: close,
  };
};
