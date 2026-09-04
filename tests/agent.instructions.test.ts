import { CODING_AGENT_INSTRUCTIONS } from "../api/core/agent/index";

describe("coding agent instructions", () => {
  it("remain concise and free of contradictory legacy mandates", () => {
    expect(CODING_AGENT_INSTRUCTIONS.length).toBeLessThan(8_000);
    expect(CODING_AGENT_INSTRUCTIONS).toContain(
      "Do not force a tool call for a purely",
    );
    expect(CODING_AGENT_INSTRUCTIONS).not.toMatch(
      /always use at least one tool|always use multiple tools/i,
    );

    for (const staleToolName of [
      "task_write",
      "task_update",
      "task_complete",
      "task_check",
    ]) {
      expect(CODING_AGENT_INSTRUCTIONS).not.toContain(staleToolName);
    }
  });

  it("preserves mutation, validation, and completion contracts", () => {
    expect(CODING_AGENT_INSTRUCTIONS).toContain(
      "These AIRIS mutation tools return",
    );
    expect(CODING_AGENT_INSTRUCTIONS).toContain(
      "run the narrowest available validation",
    );
    expect(CODING_AGENT_INSTRUCTIONS).toContain(
      "Mastra maxSteps value is the sole action budget",
    );
    expect(CODING_AGENT_INSTRUCTIONS).toContain(
      "blocked, waiting for required input/approval, or out of the runtime's action budget",
    );
  });
});