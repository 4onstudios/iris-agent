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
const MESSAGE_OVERHEAD_TOKENS = 10;
const SUMMARY_MESSAGE_LIMIT = 8;
const SUMMARY_MESSAGE_CHAR_LIMIT = 220;

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

export const budgetConversationHistoryByTokens = <T extends ConversationMessageLike>(
  history: T[] | undefined,
  maxMessages: number,
  maxTokensPerMessage: number,
  maxTotalTokens: number,
): T[] => {
  if (!history || history.length === 0) return [];

  const safeMaxMessages = Math.max(1, maxMessages);
  const safeMaxTokensPerMessage = Math.max(0, maxTokensPerMessage);
  const safeMaxTotalTokens = Math.max(0, maxTotalTokens);
  const windowed = history.slice(-safeMaxMessages);
  const droppedByWindow = history.slice(0, Math.max(0, history.length - windowed.length));
  const selected: T[] = [];
  let remainingTokens = safeMaxTotalTokens;
  let selectedStartIndex = windowed.length;

  for (let i = windowed.length - 1; i >= 0; i -= 1) {
    if (remainingTokens <= MESSAGE_OVERHEAD_TOKENS) break;

    const message = windowed[i];
    const content = typeof message.content === "string" ? message.content : "";
    if (!content) continue;

    const isToolResultsContinuation = message.continuationType === "tool_results";

    const perMessageBudget = Math.min(
      isToolResultsContinuation
        ? Math.max(safeMaxTokensPerMessage, safeMaxTotalTokens)
        : safeMaxTokensPerMessage,
      remainingTokens - MESSAGE_OVERHEAD_TOKENS,
    );
    if (perMessageBudget <= 0) break;

    const truncatedContent = truncateTextByTokens(content, perMessageBudget);
    const estimatedTokens =
      estimateTokensFromChars(truncatedContent) + MESSAGE_OVERHEAD_TOKENS;
    if (estimatedTokens > remainingTokens) break;

    selected.unshift({
      ...message,
      content: truncatedContent,
    });
    selectedStartIndex = i;

    remainingTokens -= estimatedTokens;
  }

  const omittedMessages = [...droppedByWindow, ...windowed.slice(0, selectedStartIndex)];
  if (omittedMessages.length === 0) {
    if (selected.length > 0) {
      return selected;
    }

    const fallbackMessage = windowed[windowed.length - 1];
    const fallbackBudget = Math.min(
      safeMaxTokensPerMessage,
      safeMaxTotalTokens - MESSAGE_OVERHEAD_TOKENS,
    );
    if (fallbackBudget <= 0) {
      return [];
    }

    return [
      {
        ...fallbackMessage,
        content: truncateTextByTokens(fallbackMessage.content || "", fallbackBudget),
      },
    ];
  }

  const summaryBudget = Math.min(
    Math.max(1, Math.floor(safeMaxTotalTokens * 0.25)),
    Math.max(0, safeMaxTotalTokens - MESSAGE_OVERHEAD_TOKENS),
  );
  if (summaryBudget <= 0) {
    return selected;
  }

  const summaryText = truncateTextByTokens(
    buildConversationSummary(omittedMessages),
    summaryBudget,
  );
  const summaryTokenUsage = estimateTokensFromChars(summaryText) + MESSAGE_OVERHEAD_TOKENS;

  const selectedWithTokens = selected.map((message) => ({
    message,
    tokenUsage:
      estimateTokensFromChars(typeof message.content === "string" ? message.content : "") +
      MESSAGE_OVERHEAD_TOKENS,
  }));

  let selectedTokenUsage = selectedWithTokens.reduce((total, entry) => total + entry.tokenUsage, 0);
  while (selectedTokenUsage + summaryTokenUsage > safeMaxTotalTokens && selectedWithTokens.length > 0) {
    const removed = selectedWithTokens.shift();
    if (!removed) break;
    selectedTokenUsage -= removed.tokenUsage;
  }

  const summarizedConversation = {
    role: "system",
    content: summaryText,
  } as T;

  if (selectedWithTokens.length > 0) {
    return [summarizedConversation, ...selectedWithTokens.map((entry) => entry.message)];
  }

  return [
    summarizedConversation,
  ];
};

const formatRoleLabel = (role?: string): string => {
  if (role === "user") return "User";
  if (role === "assistant") return "Assistant";
  if (role === "tool") return "Tool";
  if (role === "system") return "System";
  return "Assistant";
};

const buildConversationSummary = <T extends ConversationMessageLike>(history: T[]): string => {
  if (history.length === 0) return "";

  const recentEntries = history.slice(-SUMMARY_MESSAGE_LIMIT);
  const parts = recentEntries.map((message) => {
    const role = formatRoleLabel(message.role);
    const content = truncateText(
      (message.content || "").replace(/\s+/g, " ").trim(),
      SUMMARY_MESSAGE_CHAR_LIMIT,
    ).trim();

    return content ? `${role}: ${content}` : role;
  });

  return `Conversation state: ${parts.join("; ")}`;
};

const formatConversationTranscript = <T extends ConversationMessageLike>(
  history: T[],
): string =>
  history
    .map((message) => `**${formatRoleLabel(message.role)}:** ${message.content || ""}`)
    .join("\n\n");

export const buildPromptWithinTokenBudget = <T extends ConversationMessageLike>(
  options: PromptBudgetBuildOptions<T>,
): PromptBudgetBuildResult<T> => {
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
    ? budgetConversationHistoryByTokens(
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
