export type SerializableToolResult = {
  tool?: string;
  name?: string;
  status?: string;
  result?: unknown;
};

const MAX_RESULT_CHARS = 12_000;
const MAX_CONTINUATION_CHARS = 240_000;
const TRUNCATION_MARKER = "\n[truncated for final-answer synthesis]";

const truncateForContinuation = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - TRUNCATION_MARKER.length))}${TRUNCATION_MARKER}`;
};

const toRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
};

const firstNonEmptyString = (...values: unknown[]): string => {
  for (const value of values) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
  }
  return "";
};

export const serializeToolResultForContinuation = (
  toolResult: SerializableToolResult,
  unknownToolLabel = "unknown_tool",
): string => {
  const toolName = toolResult.tool || toolResult.name || unknownToolLabel;
  const rawResult = toRecord(toolResult.result) || {};
  const nestedValue = toRecord(rawResult.value);

  const status =
    firstNonEmptyString(toolResult.status, rawResult.status, nestedValue?.status) || "completed";

  const output = firstNonEmptyString(
    rawResult.output,
    rawResult.content,
    rawResult.text,
    rawResult.stdout,
    rawResult.stderr,
    nestedValue?.output,
    nestedValue?.content,
    nestedValue?.text,
    nestedValue?.stdout,
    nestedValue?.stderr,
  );

  const error = firstNonEmptyString(rawResult.error, nestedValue?.error);
  const resultPath = firstNonEmptyString(
    rawResult.filePath,
    rawResult.path,
    nestedValue?.filePath,
    nestedValue?.path,
  );

  const exitCode =
    typeof rawResult.exitCode !== "undefined"
      ? rawResult.exitCode
      : typeof nestedValue?.exitCode !== "undefined"
        ? nestedValue.exitCode
        : undefined;

  const indicatesFailure =
    rawResult.success === false ||
    nestedValue?.success === false ||
    (typeof exitCode === "number" && exitCode !== 0);

  const displayStatus = indicatesFailure ? "failed" : status;

  const parts = [
    `Tool: ${toolName}`,
    `Status: ${displayStatus}`,
    resultPath ? `Path: ${resultPath}` : "",
    typeof exitCode !== "undefined" ? `ExitCode: ${String(exitCode)}` : "",
    error ? `Error: ${error}` : "",
    output ? `Output:\n${output}` : "",
    `ResultJSON:\n${JSON.stringify(toolResult.result ?? {}, null, 2)}`,
  ].filter((part) => part.length > 0);

  return truncateForContinuation(parts.join("\n"), MAX_RESULT_CHARS);
};

export const serializeToolResultsForContinuation = (
  toolResults: SerializableToolResult[],
  unknownToolLabel = "unknown_tool",
): string => {
  const serializedResults = toolResults.map((toolResult) =>
    serializeToolResultForContinuation(toolResult, unknownToolLabel),
  );
  const selected: string[] = [];
  let remainingChars = MAX_CONTINUATION_CHARS;

  for (let index = serializedResults.length - 1; index >= 0; index -= 1) {
    const separatorChars = selected.length > 0 ? 2 : 0;
    const result = serializedResults[index];
    if (result.length + separatorChars > remainingChars) break;
    selected.unshift(result);
    remainingChars -= result.length + separatorChars;
  }

  const omittedCount = serializedResults.length - selected.length;
  const omissionNotice = omittedCount > 0
    ? `[${omittedCount} older tool result${omittedCount === 1 ? "" : "s"} omitted for payload safety]\n\n`
    : "";

  return `${omissionNotice}${selected.join("\n\n")}`;
};
