import type { Processor } from "@mastra/core/processors";
import { redact } from "../../library/safetyMiddleware";

type RedactionSummary = {
  result: unknown;
  redactionCount: number;
  redactionTypes: Set<string>;
};

export const redactToolResult = (
  value: unknown,
  seen = new WeakMap<object, unknown>(),
): RedactionSummary => {
  if (typeof value === "string") {
    const { output, redactions } = redact(value);
    return {
      result: output,
      redactionCount: redactions.length,
      redactionTypes: new Set(redactions.map((entry) => entry.type)),
    };
  }

  if (value === null || typeof value !== "object") {
    return { result: value, redactionCount: 0, redactionTypes: new Set() };
  }

  const existing = seen.get(value);
  if (existing !== undefined) {
    return { result: existing, redactionCount: 0, redactionTypes: new Set() };
  }

  const output: unknown[] | Record<string, unknown> = Array.isArray(value)
    ? []
    : {};
  seen.set(value, output);

  let redactionCount = 0;
  const redactionTypes = new Set<string>();
  for (const [key, entry] of Object.entries(value)) {
    const redacted = redactToolResult(entry, seen);
    output[key as keyof typeof output] = redacted.result as never;
    redactionCount += redacted.redactionCount;
    redacted.redactionTypes.forEach((type) => redactionTypes.add(type));
  }

  return { result: output, redactionCount, redactionTypes };
};

export class ToolResultSafetyProcessor implements Processor {
  readonly id = "tool-result-safety";

  async processToolResult({
    toolName,
    toolCallId,
    args,
    result,
    messageList,
  }: Parameters<NonNullable<Processor["processToolResult"]>>[0]) {
    const redacted = redactToolResult(result);
    if (redacted.redactionCount === 0) {
      return messageList;
    }

    messageList.updateToolInvocation({
      type: "tool-invocation",
      toolInvocation: {
        state: "result",
        toolCallId,
        toolName,
        args,
        result: redacted.result,
      },
    });

    console.warn("Redacted sensitive data from tool result", {
      processorId: this.id,
      toolName,
      redactionCount: redacted.redactionCount,
      redactionTypes: Array.from(redacted.redactionTypes).sort(),
    });

    return messageList;
  }
}