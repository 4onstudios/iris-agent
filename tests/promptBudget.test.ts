import {
  buildPromptWithinTokenBudget,
  truncateHeadByTokens,
} from "../api/helpers/promptBudget";
import { serializeToolResultsForContinuation } from "../api/core/containers/chat/toolResultSerialization";

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

  it("retains newest tool evidence when a synthesis continuation exceeds the budget", async () => {
    const continuation = serializeToolResultsForContinuation([
      { tool: "earlier_tool", result: { output: "old evidence ".repeat(600) } },
      { tool: "latest_tool", result: { output: "latest evidence marker" } },
    ]);
    const instruction = "Synthesize the answer using the latest tool evidence.";
    const result = await buildPromptWithinTokenBudget({
      effectiveMessage: continuation,
      priorConversationHistory: [
        { role: "user", content: "Original task" },
        { role: "assistant", content: "Running tools" },
      ],
      contextInfo: "",
      maxPromptTokens: 1_000,
      maxConversationMessages: 12,
      maxConversationMessageTokens: 1_200,
      continuationInstruction: instruction,
    });

    expect(result.prompt).toContain("latest evidence marker");
    expect(result.prompt).toContain("Tool: latest_tool");
    expect(result.prompt).toContain(instruction);
    expect(result.promptEstimatedTokens).toBeLessThanOrEqual(1_000);
  });

  it.each([0, 1, 9, 10, 100])("keeps tail truncation within a %i-token budget", (budget) => {
    const result = truncateHeadByTokens("x".repeat(1_000) + "tail", budget);
    expect(result.length).toBeLessThanOrEqual(budget * 4);
    if (budget > 0) expect(result.endsWith("tail")).toBe(true);
  });
});
