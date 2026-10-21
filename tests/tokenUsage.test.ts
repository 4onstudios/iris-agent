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

  it("bases remaining context on the provider-capped window", () => {
    expect(
      buildContextWindowStats(
        {
          contextWindowTokens: 4_096,
          inputTokens: 3_277,
          maxOutputTokens: 819,
        },
        { inputTokens: 2_500, outputTokens: 500, totalTokens: 3_000 },
      ),
    ).toMatchObject({
      contextWindowTokens: 4_096,
      usedTokens: 3_000,
      remainingTokens: 1_096,
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
