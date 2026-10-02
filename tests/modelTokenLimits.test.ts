import {
  resolveModelContextBudget,
  resolveModelInputTokenLimit,
  resolveModelInputTokenLimitAsync,
} from "../api/helpers/modelTokenLimits";

describe("model input limits", () => {
  afterEach(() => jest.restoreAllMocks());

  it("uses the provider window minus output headroom for an arbitrary small model", async () => {
    const fetchModel = jest.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          context_length: 4_096,
          top_provider: { context_length: 4_096, max_completion_tokens: 2_048 },
        },
      }),
    } as Response);
    const env = { OPENROUTER_API_KEY: "test-key" };

    const first = await resolveModelInputTokenLimitAsync("openrouter/example/small-model", env);
    const second = await resolveModelInputTokenLimitAsync("openrouter/example/small-model", env);

    expect(first).toBe(3_277);
    expect(second).toBe(first);
    expect(await resolveModelContextBudget("openrouter/example/small-model", env)).toEqual({
      inputTokens: 3_277,
      maxOutputTokens: 819,
    });
    expect(fetchModel).toHaveBeenCalledTimes(1);
    expect(fetchModel.mock.calls[0]?.[0].toString()).toBe(
      "https://openrouter.ai/api/v1/model/example/small-model",
    );
  });

  it("uses the documented maximum input when lower than the context window", async () => {
    jest.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          context_length: 400_000,
          top_provider: { context_length: 400_000, max_completion_tokens: 128_000 },
        },
      }),
    } as Response);

    expect(await resolveModelInputTokenLimitAsync(
      "openrouter/openai/gpt-5.3-codex",
      { OPENROUTER_API_KEY: "test-key" },
    )).toBe(272_000);
  });

  it("uses fresh metadata rather than a stale catalog entry", async () => {
    jest.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          context_length: 256_000,
          top_provider: { context_length: 256_000, max_completion_tokens: 32_000 },
        },
      }),
    } as Response);
    expect(await resolveModelContextBudget(
      "openrouter/z-ai/glm-5.2",
      {},
    )).toEqual({ inputTokens: 224_000, maxOutputTokens: 32_000 });
  });

  it("does not guess a context window from an unfamiliar model name", async () => {
    expect(resolveModelInputTokenLimit("custom/claude-1m-preview")).toBe(16_000);
    expect(await resolveModelInputTokenLimitAsync(
      "local/claude-1m-preview",
      {},
    )).toBe(16_000);
  });

  it("honors an explicit override without a metadata lookup", async () => {
    const fetchModel = jest.spyOn(globalThis, "fetch");
    expect(await resolveModelInputTokenLimitAsync(
      "openrouter/example/unknown",
      { IRIS_AGENT_INPUT_TOKEN_LIMIT: "6000" },
    )).toBe(6_000);
    expect(fetchModel).not.toHaveBeenCalled();
  });

  it("warns and falls back conservatively if metadata is unavailable", async () => {
    const fetchModel = jest.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    const warning = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await resolveModelInputTokenLimitAsync(
      "openrouter/example/offline-model",
      {},
    )).toBe(16_000);
    expect(await resolveModelInputTokenLimitAsync(
      "openrouter/example/offline-model",
      {},
    )).toBe(16_000);
    expect(fetchModel).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("example/offline-model"),
      "offline",
    );
  });
});
