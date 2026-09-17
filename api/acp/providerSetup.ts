type Environment = Record<string, string | undefined>;

type ProviderSetup = {
  credential: string;
  modelExample: string;
  description: string;
};

const getConfiguredKey = (
  environment: Environment,
  keys: string[],
): boolean => keys.some((key) => Boolean(environment[key]?.trim()));

const getRequiredProvider = (
  modelId: string,
  environment: Environment,
): ProviderSetup | undefined => {
  const normalizedModelId = modelId.endsWith("-other")
    ? modelId.slice(0, -"-other".length)
    : modelId;

  if (
    normalizedModelId.startsWith("ollama/") ||
    normalizedModelId.startsWith("local/")
  ) {
    return undefined;
  }
  if (
    normalizedModelId.startsWith("huggingface/") ||
    normalizedModelId.endsWith(":fireworks-ai")
  ) {
    return getConfiguredKey(environment, ["HF_TOKEN"])
      ? undefined
      : {
          credential: "HF_TOKEN",
          modelExample: "huggingface/Qwen/Qwen2.5-Coder-32B-Instruct",
          description: "a Hugging Face Inference Providers token",
        };
  }
  if (normalizedModelId.startsWith("openrouter/")) {
    return getConfiguredKey(environment, ["OPENROUTER_API_KEY"])
      ? undefined
      : {
          credential: "OPENROUTER_API_KEY",
          modelExample: "openrouter/openai/gpt-4o",
          description: "an OpenRouter API key",
        };
  }
  if (normalizedModelId.startsWith("openai/")) {
    return getConfiguredKey(environment, ["OPENAI_API_KEY"])
      ? undefined
      : {
          credential: "OPENAI_API_KEY",
          modelExample: "openai/gpt-4o",
          description: "an OpenAI API key",
        };
  }
  if (normalizedModelId.startsWith("anthropic/")) {
    return getConfiguredKey(environment, ["ANTHROPIC_API_KEY"])
      ? undefined
      : {
          credential: "ANTHROPIC_API_KEY",
          modelExample: "anthropic/claude-sonnet-4-5",
          description: "an Anthropic API key",
        };
  }
  if (
    normalizedModelId.startsWith("google/") ||
    normalizedModelId.startsWith("gemini")
  ) {
    if (
      getConfiguredKey(environment, [
        "GOOGLE_GENERATIVE_AI_API_KEY",
        "GEMINI_API_KEY",
      ])
    ) {
      return undefined;
    }
    return {
      credential: "GOOGLE_GENERATIVE_AI_API_KEY",
      modelExample: "google/gemini-2.5-pro",
      description: "a Google AI API key",
    };
  }
  if (normalizedModelId.includes("/")) {
    return getConfiguredKey(environment, ["OPENROUTER_API_KEY"])
      ? undefined
      : {
          credential: "OPENROUTER_API_KEY",
          modelExample: normalizedModelId,
          description: "an OpenRouter API key",
        };
  }
  if (normalizedModelId.startsWith("claude")) {
    if (
      getConfiguredKey(environment, [
        "ANTHROPIC_API_KEY",
        "OPENROUTER_API_KEY",
      ])
    ) {
      return undefined;
    }
    return {
      credential: "ANTHROPIC_API_KEY",
      modelExample: "anthropic/claude-sonnet-4-5",
      description: "an Anthropic API key",
    };
  }
  if (
    normalizedModelId.startsWith("gpt") ||
    normalizedModelId.startsWith("o1") ||
    normalizedModelId.startsWith("o3")
  ) {
    if (
      getConfiguredKey(environment, ["OPENAI_API_KEY", "OPENROUTER_API_KEY"])
    ) {
      return undefined;
    }
    return {
      credential: "OPENAI_API_KEY",
      modelExample: "openai/gpt-4o",
      description: "an OpenAI API key",
    };
  }
  return getConfiguredKey(environment, ["OPENAI_API_KEY", "OPENROUTER_API_KEY"])
    ? undefined
    : {
        credential: "OPENROUTER_API_KEY",
        modelExample: `openrouter/${normalizedModelId}`,
        description: "an OpenRouter API key",
      };
};

export const getMissingProviderSetup = (
  modelId: string,
  environment: Environment = process.env,
): string | undefined => {
  const requiredProvider = getRequiredProvider(modelId, environment);
  if (!requiredProvider) return undefined;

  const { credential, description, modelExample } = requiredProvider;
  return [
    `Iris Agent cannot start model '${modelId}' because ${credential} is not configured.`,
    "",
    `Provide ${description} before starting the agent:`,
    `  ${credential}=<your-api-key> npx -y @4onstudios/iris-agent@latest --acp --modelId ${modelId}`,
    "",
    "For VS Code ACP Client, add the key to the agent's environment in settings.json:",
    JSON.stringify(
      {
        "acp.agents": {
          "Iris Agent": {
            command: "npx",
            args: ["-y", "@4onstudios/iris-agent@latest", "--acp", "--modelId", modelId],
            env: { [credential]: "<your-api-key>" },
          },
        },
      },
      null,
      2,
    ),
    "",
    "Supported provider options:",
    "  OpenRouter: OPENROUTER_API_KEY with --modelId openrouter/openai/gpt-4o",
    "  OpenAI: OPENAI_API_KEY with --modelId openai/gpt-4o",
    "  Anthropic: ANTHROPIC_API_KEY with --modelId anthropic/claude-sonnet-4-5",
    "  Google: GOOGLE_GENERATIVE_AI_API_KEY with --modelId google/gemini-2.5-pro",
    "  Hugging Face: HF_TOKEN with --modelId huggingface/Qwen/Qwen2.5-Coder-32B-Instruct",
    "  Local Ollama: no cloud key; use --modelId ollama/<model> (optionally set OLLAMA_BASE_URL).",
    `Example selected-model identifier: ${modelExample}`,
  ].join("\n");
};
