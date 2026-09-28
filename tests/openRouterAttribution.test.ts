import { resolveOpenRouterAttributionHeaders } from "../api/core/agent/utils/openRouterAttribution";

describe("resolveOpenRouterAttributionHeaders", () => {
  it("attributes Iris Agent with its OpenRouter app identity and categories", () => {
    expect(resolveOpenRouterAttributionHeaders({})).toEqual({
      "HTTP-Referer": "https://github.com/4onstudios/iris-agent",
      "X-OpenRouter-Title": "Iris Agent",
      "X-OpenRouter-Categories": "cli-agent,ide-extension",
    });
  });

  it("respects existing OpenRouter site URL and name overrides", () => {
    expect(
      resolveOpenRouterAttributionHeaders({
        OPENROUTER_SITE_URL: "https://example.com/iris",
        OPENROUTER_SITE_NAME: "Custom Iris",
      }),
    ).toEqual({
      "HTTP-Referer": "https://example.com/iris",
      "X-OpenRouter-Title": "Custom Iris",
      "X-OpenRouter-Categories": "cli-agent,ide-extension",
    });
  });
});
