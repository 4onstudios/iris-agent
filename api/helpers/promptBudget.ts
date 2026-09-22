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
  resolveModelInputTokenLimit,
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

const TOKEN_TO_CHAR_RATIO = 4;
const MIN_SECTION_TOKENS = 64;
const compactConversationHistory = composeStrategies(
  clearToolResults({ keepRecentToolResults: 3 }),
  evictOldest(),
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
  const compacted =
    (await compactConversationHistory(windowed as never, {
      maxTokens: safeMaxTotalTokens,
      estimate: (message) => estimateMessageTokens(message as never),
    })) ?? windowed;

  return compacted
    .slice(-safeMaxMessages)
    .map((message) => {
      const original = message as unknown as T;
      const content = typeof message.content === "string" ? message.content : "";
      const isToolResultsContinuation =
        (original as ConversationMessageLike).continuationType === "tool_results";
      const perMessageBudget = isToolResultsContinuation
        ? Math.max(safeMaxTokensPerMessage, safeMaxTotalTokens)
        : safeMaxTokensPerMessage;

      return {
        ...original,
        content: truncateTextByTokens(content, perMessageBudget),
      };
    });
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

  const safeMaxPromptTokens = Math.max(512, maxPromptTokens);
  const safeContinuation =
    typeof continuationInstruction === "string"
      ? continuationInstruction.trim()
      : "";
  const continuationTokens = safeContinuation
    ? estimateTokensFromChars(`\n\n${safeContinuation}`)
    : 0;
  const baseBudget = Math.max(
    256,
    safeMaxPromptTokens - continuationTokens,
  );

  const hasHistory = Array.isArray(conversationHistory) && conversationHistory.length > 0;
  const historyBudget = hasHistory ? Math.max(MIN_SECTION_TOKENS, Math.floor(baseBudget * 0.6)) : 0;
  const contextBudget = hasHistory
    ? Math.max(MIN_SECTION_TOKENS, baseBudget - historyBudget)
    : Math.max(MIN_SECTION_TOKENS, Math.floor(baseBudget * 0.7));

  const budgetedConversationHistory = hasHistory
    ? await budgetConversationHistoryByTokens(
      conversationHistory,
      maxConversationMessages,
      maxConversationMessageTokens,
      historyBudget,
    )
    : [];

  const budgetedContextInfo = truncateMiddleByTokens(contextInfo || "", contextBudget);

  let prompt = "";

  if (budgetedConversationHistory.length > 0) {
    const transcript = formatConversationTranscript(budgetedConversationHistory);
    prompt = `${transcript}\n\n${budgetedContextInfo}`;
  } else {
    const messageBudget = Math.max(MIN_SECTION_TOKENS, baseBudget - contextBudget);
    const budgetedMessage = truncateTextByTokens(effectiveMessage || "", messageBudget);
    prompt = `${budgetedMessage}\n\n${budgetedContextInfo}`;
  }

  if (safeContinuation.length > 0) {
    const promptWithContinuation = `${prompt}\n\n${safeContinuation}`;
    if (estimateTokensFromChars(promptWithContinuation) <= safeMaxPromptTokens) {
      prompt = promptWithContinuation;
    } else {
      const compressedPrompt = truncateMiddleByTokens(
        prompt,
        Math.max(MIN_SECTION_TOKENS, safeMaxPromptTokens - continuationTokens),
      );
      prompt = `${compressedPrompt}\n\n${safeContinuation}`;
    }
  }

  const promptEstimatedTokens = estimateTokensFromChars(prompt);
  if (promptEstimatedTokens > safeMaxPromptTokens) {
    const hardLimitedPrompt = budgetedConversationHistory.some(
      (message) => message.continuationType === "tool_results",
    )
      ? truncateHeadByTokens(prompt, safeMaxPromptTokens)
      : truncateMiddleByTokens(prompt, safeMaxPromptTokens);
    return {
      prompt: hardLimitedPrompt,
      budgetedContextInfo,
      budgetedConversationHistory,
      promptEstimatedTokens: estimateTokensFromChars(hardLimitedPrompt),
    };
  }

  return {
    prompt,
    budgetedContextInfo,
    budgetedConversationHistory,
    promptEstimatedTokens,
  };
};
