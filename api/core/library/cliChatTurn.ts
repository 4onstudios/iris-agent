import { resolveToolExecutionStatus } from "../agent/utils/toolLifecycle";
import {
  normalizeTokenUsage,
  type TokenUsageSummary,
} from "../../helpers/tokenUsage";
import type { CliChatUi } from "./cliChatUi";

type CliAgentChunk = { type: string; payload?: Record<string, unknown> };
export interface CliChatAgent {
  stream?: (
    prompt: string,
    options: Record<string, unknown>,
  ) => Promise<{
    fullStream: ReadableStream<CliAgentChunk>;
    text?: Promise<string> | string;
    usage?: Promise<unknown> | unknown;
  }>;
  generate?: (
    prompt: string,
    options: Record<string, unknown>,
  ) => Promise<unknown>;
}

const waitForAbortable = async <T>(
  value: PromiseLike<T> | T,
  signal: AbortSignal,
): Promise<T> => {
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const abort = new Promise<never>((_, reject) => {
    onAbort = () =>
      reject(
        signal.reason ??
          new DOMException("The operation was aborted", "AbortError"),
      );
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([Promise.resolve(value), abort]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
};

/** Consume the existing agent protocol; the UI never owns agent execution. */
export const runCliChatTurn = async (
  agent: CliChatAgent,
  prompt: string,
  options: Record<string, unknown>,
  ui: CliChatUi,
  signal: AbortSignal,
): Promise<TokenUsageSummary | undefined> => {
  signal.throwIfAborted();
  ui.setStatus("Thinking...");
  const turnOptions = { ...options, abortSignal: signal };
  if (typeof agent.stream !== "function") {
    if (typeof agent.generate !== "function") {
      throw new Error("Agent does not support streaming or text generation");
    }
    const result = await agent.generate(prompt, turnOptions);
    signal.throwIfAborted();
    const usage =
      result && typeof result === "object"
        ? normalizeTokenUsage((result as Record<string, unknown>).usage)
        : undefined;
    const text =
      typeof result === "string"
        ? result
        : result && typeof result === "object" && "text" in result
          ? String(result.text || "")
          : JSON.stringify(result, null, 2) || "";
    ui.appendText(text);
    return usage;
  }

  const streamResult = await agent.stream(prompt, turnOptions);
  const reader = streamResult.fullStream.getReader();
  const cancelReader = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancelReader, { once: true });
  let drained = false;
  let hasOutput = false;
  let usage: TokenUsageSummary | undefined;
  const pendingIds = new Map<string, number>();
  let anonymousCalls = 0;
  const pendingCount = () =>
    [...pendingIds.values()].reduce((total, count) => total + count, 0) +
    anonymousCalls;

  try {
    if (signal.aborted) cancelReader();
    signal.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) {
        drained = true;
        break;
      }
      const payload = value?.payload || {};
      if (value?.type === "text-delta") {
        const text = typeof payload.text === "string" ? payload.text : "";
        if (text) {
          hasOutput = true;
          ui.appendText(text);
          if (!pendingCount()) ui.setStatus("Responding...");
        }
      } else if (value?.type === "tool-call") {
        const name =
          typeof payload.toolName === "string" ? payload.toolName : "tool";
        const id =
          typeof payload.toolCallId === "string"
            ? payload.toolCallId
            : undefined;
        if (id) pendingIds.set(id, (pendingIds.get(id) || 0) + 1);
        else anonymousCalls++;
        ui.toolCall(name, id);
        ui.setStatus(
          pendingCount() > 1 ? "Running tools..." : `Running ${name}...`,
        );
      } else if (
        value?.type === "tool-result" ||
        value?.type === "tool-error"
      ) {
        const id =
          typeof payload.toolCallId === "string"
            ? payload.toolCallId
            : undefined;
        const name =
          typeof payload.toolName === "string" ? payload.toolName : undefined;
        const status =
          value.type === "tool-error"
            ? "failed"
            : resolveToolExecutionStatus(
                payload.result ??
                  payload.output ??
                  payload.content ??
                  payload.data,
              );
        ui.toolResult(status, id, name);
        if (status !== "pending" && status !== "in_progress") {
          if (id) {
            const count = pendingIds.get(id) || 0;
            if (count > 1) pendingIds.set(id, count - 1);
            else pendingIds.delete(id);
          } else if (anonymousCalls) anonymousCalls--;
          if (!pendingCount()) ui.setStatus("Thinking...");
        }
      } else if (value?.type === "error") {
        const error = payload.error ?? payload.message;
        throw error && typeof error === "object"
          ? error
          : new Error(
              typeof error === "string" ? error : "Agent stream failed",
            );
      }
    }
    if (!hasOutput && streamResult.text) {
      const text = await streamResult.text;
      signal.throwIfAborted();
      if (text) ui.appendText(text);
    }
    try {
      usage = normalizeTokenUsage(
        await waitForAbortable(streamResult.usage, signal),
      );
    } catch (error) {
      signal.throwIfAborted();
      console.warn(
        "[cli] Could not read provider token usage for context stats:",
        error instanceof Error ? error.message : String(error),
      );
    }
  } finally {
    signal.removeEventListener("abort", cancelReader);
    if (!drained) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return usage;
};
