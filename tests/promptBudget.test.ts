import {
  buildPromptWithinTokenBudget,
} from "../api/helpers/promptBudget";

describe("prompt budgeting", () => {
  it("preserves a full current request when it fits with prior history", async () => {
    const currentMessage = `Opening instruction: ${"x".repeat(19_900)}`;
    const result = await buildPromptWithinTokenBudget({
      effectiveMessage: currentMessage,
      priorConversationHistory: [
        { role: "user", content: "Earlier question" },
        { role: "assistant", content: "Earlier answer" },
      ],
      contextInfo: "",
      maxPromptTokens: 8_800,
      maxConversationMessages: 12,
      maxConversationMessageTokens: 1_200,
    });

    expect(result.prompt).toContain("Opening instruction:");
    expect(result.prompt).toContain("x".repeat(19_900));
    expect(result.promptEstimatedTokens).toBeLessThanOrEqual(8_800);
  });

  it("keeps the beginning of an oversized current request", async () => {
    const result = await buildPromptWithinTokenBudget({
      effectiveMessage: `Opening instruction: ${"x".repeat(20_000)}`,
      priorConversationHistory: [
        { role: "user", content: "Earlier question" },
        { role: "assistant", content: "Earlier answer" },
      ],
      contextInfo: "",
      maxPromptTokens: 1_000,
      maxConversationMessages: 12,
      maxConversationMessageTokens: 1_200,
    });

    expect(result.prompt).toContain("Opening instruction:");
    expect(result.promptEstimatedTokens).toBeLessThanOrEqual(1_000);
    expect(result.prompt).toMatch(/\*\*User:\*\* Opening instruction: x{1000}/);
  });

  it("does not drop a fitting continuation tail before applying the token budget", async () => {
    const continuation = `${"tool result ".repeat(450)}[last tool result]`;
    const result = await buildPromptWithinTokenBudget({
      effectiveMessage: continuation,
      priorConversationHistory: [],
      contextInfo: "",
      maxPromptTokens: 2_000,
      maxConversationMessages: 12,
      maxConversationMessageTokens: 1_200,
    });

    expect(result.prompt).toContain("[last tool result]");
    expect(result.prompt).toContain("tool result");
    expect(result.promptEstimatedTokens).toBeLessThanOrEqual(2_000);
  });
});
