import { getMissingProviderSetup } from "../api/core/library/providerSetup";

describe("provider setup", () => {
  it("reports how to configure the selected OpenRouter model", () => {
    expect(
      getMissingProviderSetup("openrouter/openai/gpt-4o", {}),
    ).toContain("OPENROUTER_API_KEY");
  });

  it("accepts the selected provider credential", () => {
    expect(
      getMissingProviderSetup("openrouter/openai/gpt-4o", {
        OPENROUTER_API_KEY: "test-key",
      }),
    ).toBeUndefined();
  });

  it("requires OpenRouter credentials for un-namespaced slash models", () => {
    expect(
      getMissingProviderSetup("xiaomi/mimo-v2.5", {
        OPENAI_API_KEY: "openai-key",
      }),
    ).toContain("OPENROUTER_API_KEY");
    expect(
      getMissingProviderSetup("xiaomi/mimo-v2.5", {
        OPENROUTER_API_KEY: "openrouter-key",
      }),
    ).toBeUndefined();
  });

  it("provides a VS Code ACP Client environment configuration", () => {
    expect(getMissingProviderSetup("anthropic/claude-sonnet-4-5", {})).toContain(
      '"env": {\n        "ANTHROPIC_API_KEY": "<your-api-key>"',
    );
  });

  it("does not require a cloud credential for local models", () => {
    expect(getMissingProviderSetup("ollama/qwen2.5-coder", {})).toBeUndefined();
  });
});
