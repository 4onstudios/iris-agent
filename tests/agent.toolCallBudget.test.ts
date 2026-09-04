import { RequestContext } from "@mastra/core/request-context";
import {
  enforceToolCallBudgetForTools,
  type ToolCallBudget,
} from "../api/core/agent/utils/toolCallBudget";

describe("tool call budget admission", () => {
  it("preserves opaque provider-defined tool markers", () => {
    const providerTool = Object.freeze({ marker: true });
    const tools = enforceToolCallBudgetForTools({ webSearch: providerTool });

    expect(tools.webSearch).toBe(providerTool);
  });

  it("rejects sibling tool calls beyond the request budget before execution", async () => {
    const firstExecute = jest.fn<Promise<{ success: boolean }>, [unknown, unknown]>(
      async () => ({ success: true }),
    );
    const secondExecute = jest.fn<Promise<{ success: boolean }>, [unknown, unknown]>(
      async () => ({ success: true }),
    );
    const tools = enforceToolCallBudgetForTools({
      first: { execute: firstExecute },
      second: { execute: secondExecute },
    });
    const requestContext = new RequestContext<{ toolCallBudget?: ToolCallBudget }>([
      ["toolCallBudget", { limit: 1, admitted: 0 }],
    ]);
    const executionContext = { requestContext };

    await expect(tools.first.execute?.({}, executionContext)).resolves.toEqual({ success: true });
    await expect(tools.second.execute?.({}, executionContext)).rejects.toThrow(
      "Tool call budget exhausted (1)",
    );

    expect(firstExecute).toHaveBeenCalledTimes(1);
    expect(secondExecute).not.toHaveBeenCalled();
  });

  it("marks repeated identical calls as a loop", async () => {
    const execute = jest.fn<Promise<{ success: boolean }>, [unknown, unknown]>(
      async () => ({ success: true }),
    );
    const tools = enforceToolCallBudgetForTools({ readFile: { execute } });
    const budget: ToolCallBudget = { limit: 10, admitted: 0 };
    const requestContext = new RequestContext<{ toolCallBudget?: ToolCallBudget }>([
      ["toolCallBudget", budget],
    ]);
    const executionContext = { requestContext };

    await tools.readFile.execute?.({ filePath: "README.md" }, executionContext);
    await tools.readFile.execute?.({ filePath: "README.md" }, executionContext);
    await tools.readFile.execute?.({ filePath: "README.md" }, executionContext);

    expect(execute).toHaveBeenCalledTimes(3);
    expect(budget.stopReason).toBe("repeated_call");
    expect(budget.admitted).toBe(3);
  });
});