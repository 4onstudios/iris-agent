import { renderCliMarkdown } from "../api/core/library/cliMarkdown";

const stripAnsi = (value: string): string =>
  value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");

describe("renderCliMarkdown", () => {
  it("renders headings, emphasis, and lists for terminal output", () => {
    const output = stripAnsi(
      renderCliMarkdown("# Summary\n\n**Ready**\n\n- first\n- second", 80),
    );

    expect(output).toContain("Summary");
    expect(output).toContain("Ready");
    expect(output).toContain("first");
    expect(output).toContain("second");
    expect(output).not.toContain("**Ready**");
    expect(output).not.toContain("- first");
  });

  it("renders fenced code blocks without Markdown fences", () => {
    const output = stripAnsi(
      renderCliMarkdown("```ts\nconst answer = 42;\n```", 80),
    );

    expect(output).toContain("const answer = 42;");
    expect(output).not.toContain("```");
  });

  it("renders inline formatting nested inside list items", () => {
    const output = stripAnsi(
      renderCliMarkdown(
        "- Warmest day of the week (~**24°C**)\n- **0% rain chance**",
        80,
      ),
    );

    expect(output).toContain("24°C");
    expect(output).toContain("0% rain chance");
    expect(output).not.toContain("**");
  });
});
