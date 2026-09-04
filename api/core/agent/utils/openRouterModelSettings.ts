type OpenRouterModelSettings = {
  reasoning?: {
    max_tokens: number;
  };
  provider: {
    order?: string[];
    allow_fallbacks?: boolean;
    require_parameters?: boolean;
  };
};

export const resolveOpenRouterModelSettings = (
  modelId: string,
): OpenRouterModelSettings | undefined => {
  const id = modelId.toLowerCase();

  if (id === "moonshotai/kimi-k3") {
    return {
      reasoning: {
        max_tokens: 2048,
      },
      provider: {
        order: ["moonshotai", "baseten", "wafer", "morph", "fireworks"],
        allow_fallbacks: true,
        require_parameters: true,
      },
    };
  }

  if (id === "z-ai/glm-5.2") {
    return {
      provider: {
        order: ["z-ai"],
        allow_fallbacks: false,
        require_parameters: true,
      },
    };
  }

  if (id === "deepseek/deepseek-v4-flash" || id === "deepseek/deepseek-chat") {
    return {
      provider: {
        order: ["deepseek", "together", "fireworks", "lepton"],
        allow_fallbacks: true,
        require_parameters: true,
      },
    };
  }

  return undefined;
};
