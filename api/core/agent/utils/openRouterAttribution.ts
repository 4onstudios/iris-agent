const DEFAULT_OPENROUTER_SITE_URL = "https://github.com/4onstudios/iris-agent";
const DEFAULT_OPENROUTER_SITE_NAME = "Iris Agent";

export function resolveOpenRouterAttributionHeaders(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return {
    "HTTP-Referer": env.OPENROUTER_SITE_URL || DEFAULT_OPENROUTER_SITE_URL,
    "X-OpenRouter-Title": env.OPENROUTER_SITE_NAME || DEFAULT_OPENROUTER_SITE_NAME,
    "X-OpenRouter-Categories": "cli-agent,ide-extension",
  };
}
