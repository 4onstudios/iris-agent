import { resolveOpenRouterModelSettings } from "../api/core/agent/utils/openRouterModelSettings";

describe("resolveOpenRouterModelSettings", () => {
  it("bounds Kimi K3 reasoning and prioritizes reliable tool providers", () => {
    expect(resolveOpenRouterModelSettings("moonshotai/kimi-k3")).toEqual({
      reasoning: { max_tokens: 2048 },
      provider: {
        order: ["moonshotai", "baseten", "wafer", "morph", "fireworks"],
        allow_fallbacks: true,
        require_parameters: true,
      },
    });
  });

  it("does not change other OpenRouter models", () => {
    expect(resolveOpenRouterModelSettings("openai/gpt-5.3-codex")).toBeUndefined();
  });

  it("routes GLM-5.2 to native z-ai endpoint and requires standard tool format", () => {
    expect(resolveOpenRouterModelSettings("z-ai/glm-5.2")).toEqual({
      provider: {
        order: ["z-ai"],
        allow_fallbacks: false,
        require_parameters: true,
      },
    });
  });
  it("does not apply glm-5 settings to the old model id", () => {
    expect(resolveOpenRouterModelSettings("z-ai/glm-5")).toBeUndefined();
  });

  it.each(["deepseek/deepseek-v4-flash", "deepseek/deepseek-chat"])(
    "pins %s to deepseek-native providers and requires standard tool format",
    (modelId) => {
      expect(resolveOpenRouterModelSettings(modelId)).toEqual({
        provider: {
          order: ["deepseek", "together", "fireworks", "lepton"],
          allow_fallbacks: true,
          require_parameters: true,
        },
      });
    },
  );
});