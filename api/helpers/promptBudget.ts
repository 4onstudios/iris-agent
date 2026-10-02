import {
  clearToolResults,
  composeStrategies,
  estimateMessageTokens,
  evictOldest,
} from "@tanstack/ai-compaction";

export type ConversationMessageLike = {
  content?: string;
  role?: string;
  continuationType?: string;
};

export {
  resolveModelContextBudget,
  resolveModelInputTokenLimit,
  resolveModelInputTokenLimitAsync,
  resolveModelSupportsVision,
} from "./modelTokenLimits";

type PromptBudgetBuildOptions<T extends ConversationMessageLike> = {
  effectiveMessage: string;
  conversationHistory?: T[];
  contextInfo: string;
  maxPromptTokens: number;
  maxConversationMessages: number;
  maxConversationMessageTokens: number;
  continuationInstruction?: string;
};

type PromptBudgetBuildResult<T extends ConversationMessageLike> = {
  prompt: string;
  budgetedContextInfo: string;
  budgetedConversationHistory: T[];
  promptEstimatedTokens: number;
};

export const resolvePromptTokenBudget = (
  inputLimit: number,
  ratio = 0.2,
): number =>
  Math.min(
    inputLimit,
    Math.max(512, Math.floor(inputLimit * ratio)),
  );

type ConversationTurnOptions<T extends ConversationMessageLike> = {
  currentMessage: string;
  history?: T[];
  maxPromptTokens: number;
  maxConversationMessages: number;
  maxConversationMessageTokens: number;
  contextInfo?: string;
  continuationInstruction?: string;
};

export const buildConversationTurn = async <T extends ConversationMessageLike>(
  options: ConversationTurnOptions<T>,
): Promise<PromptBudgetBuildResult<T> & { currentMessage: string }> => {
  const maxTokens = Math.max(1, options.maxPromptTokens);
  const instruction = options.continuationInstruction?.trim() || "";
  const instructionSuffix = instruction ? `\n\n${instruction}` : "";
  const contextBudget = options.contextInfo
    ? Math.floor(maxTokens * 0.2)
    : 0;
  const budgetedContextInfo = truncateMiddleByTokens(
    options.contextInfo || "",
    contextBudget,
  );
  const contextSuffix = budgetedContextInfo ? `\n\n${budgetedContextInfo}` : "";
  const available = maxTokens
    - estimateTokensFromChars(instructionSuffix + contextSuffix)
    - 24;
  if (available < 1) {
    throw new Error("Prompt budget cannot fit context and continuation instructions");
  }
  const currentBudget = Math.max(1, Math.floor(available * (
    options.history?.length ? 0.4 : 1
  )));
  const currentMessage = truncateHeadByTokens(options.currentMessage, currentBudget);
  const historyBudget = Math.max(
    0,
    available - estimateTokensFromChars(currentMessage),
  );
  const windowed = options.history?.slice(-options.maxConversationMessages) || [];
  // Keep the immediately preceding exchange intact before compacting older turns.
  const recent = windowed.slice(-2);
  const older = windowed.slice(0, -2);
  const recentHistory = await budgetConversationHistoryByTokens(
    recent,
    2,
    options.maxConversationMessageTokens,
    historyBudget,
  );
  const recentTokens = estimateTokensFromChars(formatConversationTranscript(recentHistory));
  const olderHistory = older.length && historyBudget > recentTokens
    ? await budgetConversationHistoryByTokens(
      older,
      options.maxConversationMessages,
      options.maxConversationMessageTokens,
      historyBudget - recentTokens,
    )
    : [];
  const budgetedConversationHistory = [...olderHistory, ...recentHistory];
  const historyText = formatConversationTranscript(budgetedConversationHistory);
  const prompt = `${historyText ? `${historyText}\n\n**User:** ` : ""}${currentMessage}${contextSuffix}${instructionSuffix}`;
  const boundedPrompt = estimateTokensFromChars(prompt) > maxTokens
    ? truncateHeadByTokens(prompt, maxTokens)
    : prompt;
  return {
    prompt: boundedPrompt,
    currentMessage,
    budgetedContextInfo,
    budgetedConversationHistory,
    promptEstimatedTokens: estimateTokensFromChars(boundedPrompt),
  };
};

const TOKEN_TO_CHAR_RATIO = 4;
const TOOL_RESULTS_CONTINUATION_TYPE = "tool_results";
const compactConversationHistory = composeStrategies(
  clearToolResults({ keepRecentToolResults: 3 }),
  evictOldest(),
);

// This agent never emits `role: "tool"` messages: tool results are
// serialized into `role: "user"` strings carrying
// `continuationType: "tool_results"` (see `api/agent.ts`). TanStack's
// `clearToolResults`/`evictOldest` strategies key off `role === "tool"` to
// find/preserve tool output, so without this mapping they treat these
// messages as ordinary user turns. Tag them as `role: "tool"` for the
// duration of compaction, then restore the original role afterward.
const tagToolResultsAsToolRole = <T extends ConversationMessageLike>(
  history: T[],
): T[] =>
  history.map((message) =>
    message.continuationType === TOOL_RESULTS_CONTINUATION_TYPE
      ? ({ ...message, role: "tool" } as T)
      : message,
  );

const restoreToolResultsRole = <T extends ConversationMessageLike>(
  history: T[],
): T[] =>
  history.map((message) =>
    message.continuationType === TOOL_RESULTS_CONTINUATION_TYPE
      ? ({ ...message, role: "user" } as T)
      : message,
  );

export const truncateText = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 31))}\n\n[truncated: prompt budget exceeded]`;
};

export const truncateMiddle = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) return value;
  const marker = "\n\n[truncated middle content for prompt budget]\n\n";
  if (maxChars <= marker.length + 2) {
    return truncateText(value, maxChars);
  }

  const remaining = maxChars - marker.length;
  const head = Math.floor(remaining * 0.7);
  const tail = remaining - head;
  return `${value.slice(0, head)}${marker}${value.slice(Math.max(0, value.length - tail))}`;
};

export const estimateTokensFromChars = (value: string): number =>
  Math.ceil((value || "").length / TOKEN_TO_CHAR_RATIO);

export const truncateTextByTokens = (value: string, maxTokens: number): string => {
  const safeMaxTokens = Math.max(0, maxTokens);
  const maxChars = safeMaxTokens * TOKEN_TO_CHAR_RATIO;
  return truncateText(value || "", maxChars);
};

export const truncateHeadByTokens = (value: string, maxTokens: number): string => {
  const safeMaxTokens = Math.max(0, maxTokens);
  const maxChars = safeMaxTokens * TOKEN_TO_CHAR_RATIO;
  if (value.length <= maxChars) return value;

  const keepChars = Math.max(0, maxChars - 31);
  return `\n\n[truncated: prompt budget exceeded]\n${value.slice(
    Math.max(0, value.length - keepChars),
  )}`;
};

export const truncateMiddleByTokens = (value: string, maxTokens: number): string => {
  const safeMaxTokens = Math.max(0, maxTokens);
  const maxChars = safeMaxTokens * TOKEN_TO_CHAR_RATIO;
  return truncateMiddle(value || "", maxChars);
};

export const budgetConversationHistory = <T extends ConversationMessageLike>(
  history: T[] | undefined,
  maxMessages: number,
  maxCharsPerMessage: number,
): T[] => {
  if (!history || history.length === 0) return [];

  return history
    .slice(-maxMessages)
    .map((message) => ({
      ...message,
      content: truncateText(message.content || "", maxCharsPerMessage),
    }));
};

export const budgetConversationHistoryByTokens = async <T extends ConversationMessageLike>(
  history: T[] | undefined,
  maxMessages: number,
  maxTokensPerMessage: number,
  maxTotalTokens: number,
): Promise<T[]> => {
  if (!history || history.length === 0) return [];

  const safeMaxMessages = Math.max(1, maxMessages);
  const safeMaxTokensPerMessage = Math.max(0, maxTokensPerMessage);
  const safeMaxTotalTokens = Math.max(0, maxTotalTokens);
  const windowed = history.slice(-safeMaxMessages);
  const taggedWindowed = tagToolResultsAsToolRole(windowed);
  const compacted = restoreToolResultsRole(
    ((await compactConversationHistory(taggedWindowed as never, {
      maxTokens: safeMaxTotalTokens,
      estimate: (message) => estimateMessageTokens(message as never),
    })) as T[] | null | undefined) ?? taggedWindowed,
  );

  const truncatedMessages = compacted.slice(-safeMaxMessages);

  // Every message is capped by how much of the total budget remains, so
  // the aggregate can never exceed `safeMaxTotalTokens` regardless of how
  // many messages there are. Tool-results messages are additionally
  // allowed extra room up to that remaining budget (rather than the fixed
  // per-message limit) since clearToolResults already trimmed/stubbed
  // older ones and the remaining ones may legitimately be large; ordinary
  // messages are still capped at the smaller of the per-message limit and
  // what's left of the total.
  //
  // Budget is allocated newest-first (iterating from the end of
  // `truncatedMessages` backwards) so the most recent, most relevant
  // messages get first claim on the remaining budget. If we allocated
  // oldest-first instead, an early message could consume the entire
  // budget and leave nothing for the newest messages — the ones most
  // likely to matter for the current turn.
  let remainingTotalTokens = safeMaxTotalTokens;
  const result: T[] = new Array(truncatedMessages.length);

  for (let i = truncatedMessages.length - 1; i >= 0; i -= 1) {
    const message = truncatedMessages[i];
    const original = message as unknown as T;
    const content = typeof message.content === "string" ? message.content : "";
    const isToolResultsContinuation =
      (original as ConversationMessageLike).continuationType ===
      TOOL_RESULTS_CONTINUATION_TYPE;
    const perMessageBudget = isToolResultsContinuation
      ? Math.max(0, remainingTotalTokens)
      : Math.min(safeMaxTokensPerMessage, Math.max(0, remainingTotalTokens));

    const truncatedContent = truncateTextByTokens(content, perMessageBudget);
    remainingTotalTokens = Math.max(
      0,
      remainingTotalTokens - estimateTokensFromChars(truncatedContent),
    );

    result[i] = {
      ...original,
      content: truncatedContent,
    };
  }

  return result;
};

const formatRoleLabel = (role?: string): string => {
  if (role === "user") return "User";
  if (role === "assistant") return "Assistant";
  if (role === "tool") return "Tool";
  if (role === "system") return "System";
  return "Assistant";
};

const formatConversationTranscript = <T extends ConversationMessageLike>(
  history: T[],
): string =>
  history
    .map((message) => `**${formatRoleLabel(message.role)}:** ${message.content || ""}`)
    .join("\n\n");

export const buildPromptWithinTokenBudget = async <T extends ConversationMessageLike>(
  options: PromptBudgetBuildOptions<T>,
): Promise<PromptBudgetBuildResult<T>> => {
  const {
    effectiveMessage,
    conversationHistory,
    contextInfo,
    maxPromptTokens,
    maxConversationMessages,
    maxConversationMessageTokens,
    continuationInstruction,
  } = options;

  const history = conversationHistory?.slice() || [];
  // HTTP callers include the current turn in conversationHistory; do not
  // compact it as prior history or replay it twice.
  if (history.length && history[history.length - 1]?.content === effectiveMessage) {
    history.pop();
  }
  return buildConversationTurn({
    currentMessage: effectiveMessage,
    history,
    contextInfo,
    maxPromptTokens,
    maxConversationMessages,
    maxConversationMessageTokens,
    continuationInstruction,
  });
};
