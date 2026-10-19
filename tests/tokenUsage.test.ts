import {
  buildContextWindowStats,
  extractLastStepUsage,
} from "../api/helpers/tokenUsage";

describe("context window stats", () => {
  it("reports remaining context based on provider token usage", () => {
    expect(
      buildContextWindowStats(
        {
          contextWindowTokens: 100_000,
          inputTokens: 80_000,
          maxOutputTokens: 20_000,
        },
        { inputTokens: 60_000, outputTokens: 5_000, totalTokens: 65_000 },
      ),
    ).toEqual({
      contextWindowTokens: 100_000,
      inputLimitTokens: 80_000,
      outputLimitTokens: 20_000,
      inputTokens: 60_000,
      outputTokens: 5_000,
      usedTokens: 65_000,
      remainingTokens: 35_000,
      utilizationPercent: 65,
    });
  });

  it("does not claim a remaining count when provider usage is unavailable", () => {
    expect(
      buildContextWindowStats(
        {
          contextWindowTokens: 100_000,
          inputTokens: 80_000,
          maxOutputTokens: 20_000,
        },
        undefined,
      ),
    ).toEqual({
      contextWindowTokens: 100_000,
      inputLimitTokens: 80_000,
      outputLimitTokens: 20_000,
    });
  });

  it("uses only the final model step for context usage", () => {
    expect(
      extractLastStepUsage([
        { usage: { inputTokens: 60_000, outputTokens: 1_000 } },
        { usage: { inputTokens: 62_000, outputTokens: 500 } },
      ]),
    ).toEqual({ inputTokens: 62_000, outputTokens: 500, totalTokens: 62_500 });
    expect(extractLastStepUsage([{ text: "no usage" }])).toBeUndefined();
    expect(extractLastStepUsage(undefined)).toBeUndefined();
  });
});
