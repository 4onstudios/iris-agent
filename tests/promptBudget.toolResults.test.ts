import {
  budgetConversationHistoryByTokens,
  estimateTokensFromChars,
  type ConversationMessageLike,
} from "../api/helpers/promptBudget";

describe("budgetConversationHistoryByTokens tool_results compaction", () => {
  it("clears stale tool_results continuation messages via clearToolResults", async () => {
    const bigToolOutput = "x".repeat(2000);
    const history: ConversationMessageLike[] = [
      { role: "user", content: bigToolOutput, continuationType: "tool_results" },
      { role: "assistant", content: "ack 1" },
      { role: "user", content: "small tool 2", continuationType: "tool_results" },
      { role: "assistant", content: "ack 2" },
      { role: "user", content: "small tool 3", continuationType: "tool_results" },
      { role: "assistant", content: "ack 3" },
      { role: "user", content: "small tool 4", continuationType: "tool_results" },
      { role: "assistant", content: "final ack" },
    ];

    const budgeted = await budgetConversationHistoryByTokens(
      history,
      history.length,
      1000,
      60,
    );

    const toolResultMessages = budgeted.filter(
      (message) => message.continuationType === "tool_results",
    );

    // clearToolResults should have stubbed out all but the most recent
    // `keepRecentToolResults` (3) tool_results messages instead of leaving
    // every one of them untouched (which would happen if these messages
    // were not recognized as tool output because their role is "user").
    const clearedCount = toolResultMessages.filter(
      (message) => message.content === "[tool output cleared to save context]",
    ).length;

    expect(clearedCount).toBeGreaterThan(0);

    // Every tool_results message must keep its original role/continuationType
    // after compaction — the "tool" role tagging used internally to make
    // clearToolResults recognize these messages must not leak into the
    // final output.
    for (const message of budgeted) {
      if (message.continuationType === "tool_results") {
        expect(message.role).toBe("user");
      }
    }
  });

  it("caps a single oversized tool_results message at the total token budget", async () => {
    const maxTotalTokens = 60;
    const maxTokensPerMessage = 1000;
    // Content large enough to far exceed maxTotalTokens on its own — with
    // keepRecentToolResults=3, this single message is kept untouched by
    // clearToolResults, and evictOldest cannot shrink a message it keeps,
    // so per-message truncation is the only thing bounding its size.
    const oversizedToolOutput = "y".repeat(2000);
    const history: ConversationMessageLike[] = [
      {
        role: "user",
        content: oversizedToolOutput,
        continuationType: "tool_results",
      },
    ];

    const budgeted = await budgetConversationHistoryByTokens(
      history,
      history.length,
      maxTokensPerMessage,
      maxTotalTokens,
    );

    expect(budgeted).toHaveLength(1);
    // A small allowance accounts for `truncateText`'s fixed-length
    // "[truncated...]" marker suffix (pre-existing, unrelated to this
    // fix) — the key assertion is that the result stays in the same
    // order of magnitude as maxTotalTokens rather than reaching
    // maxTokensPerMessage (1000), which was the reported bug.
    expect(estimateTokensFromChars(budgeted[0].content || "")).toBeLessThanOrEqual(
      maxTotalTokens + 10,
    );
  });

  it("shares the remaining budget across multiple tool_results messages instead of allowing each one to reach the total budget", async () => {
    const maxTotalTokens = 200;
    const maxTokensPerMessage = 1000;
    // Three large tool_results messages, each individually smaller than
    // maxTotalTokens, but their combined size exceeds it. Since all three
    // are within keepRecentToolResults=3, clearToolResults leaves them
    // untouched — per-message truncation must ensure their combined size
    // still respects maxTotalTokens.
    const largeToolOutput = "z".repeat(600);
    const history: ConversationMessageLike[] = [
      { role: "user", content: largeToolOutput, continuationType: "tool_results" },
      { role: "user", content: largeToolOutput, continuationType: "tool_results" },
      { role: "user", content: largeToolOutput, continuationType: "tool_results" },
    ];

    const budgeted = await budgetConversationHistoryByTokens(
      history,
      history.length,
      maxTokensPerMessage,
      maxTotalTokens,
    );

    const totalTokens = budgeted.reduce(
      (sum, message) => sum + estimateTokensFromChars(message.content || ""),
      0,
    );

    // Small allowance for truncateText's marker overhead (see above); the
    // key assertion is that three messages sharing a 200-token budget
    // don't each independently consume the full budget (previously would
    // have summed to ~600 tokens).
    expect(totalTokens).toBeLessThanOrEqual(maxTotalTokens + 30);
  });

  it("caps an ordinary (non-tool_results) message at the total token budget, not the per-message limit", async () => {
    const maxTotalTokens = 10;
    const maxTokensPerMessage = 250;
    // An ordinary user message with no continuationType at all — only the
    // fixed per-message limit applied to it previously, so a message far
    // smaller than maxTokensPerMessage but larger than maxTotalTokens
    // would be returned untouched at up to maxTokensPerMessage tokens.
    const largeMessage = "a".repeat(1000);
    const history: ConversationMessageLike[] = [
      { role: "user", content: largeMessage },
    ];

    const budgeted = await budgetConversationHistoryByTokens(
      history,
      history.length,
      maxTokensPerMessage,
      maxTotalTokens,
    );

    expect(budgeted).toHaveLength(1);
    // Small allowance for truncateText's marker overhead (see above); the
    // key assertion is that the result stays near maxTotalTokens (10)
    // rather than reaching maxTokensPerMessage (250).
    expect(estimateTokensFromChars(budgeted[0].content || "")).toBeLessThanOrEqual(
      maxTotalTokens + 10,
    );
  });
});
