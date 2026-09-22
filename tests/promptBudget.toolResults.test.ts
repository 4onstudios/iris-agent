import {
  budgetConversationHistoryByTokens,
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
});
