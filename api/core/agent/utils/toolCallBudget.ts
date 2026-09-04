import type { RequestContext } from "@mastra/core/request-context";

export type ToolCallBudget = {
  limit: number;
  admitted: number;
  consecutiveSignature?: string;
  consecutiveCount?: number;
  stopReason?: "limit" | "repeated_call";
};

type ToolExecutionContext = {
  requestContext?: RequestContext<{ toolCallBudget?: ToolCallBudget }>;
};

type ExecutableTool = {
  // eslint-disable-next-line no-unused-vars
  execute?: (...args: never[]) => unknown;
};

// eslint-disable-next-line no-unused-vars
type BudgetedExecute = (input: unknown, context: ToolExecutionContext) => unknown;

const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
};

const MAX_CONSECUTIVE_IDENTICAL_CALLS = 3;

const admitToolCall = (
  toolName: string,
  input: unknown,
  context: ToolExecutionContext | undefined,
): void => {
  const budget = context?.requestContext?.get("toolCallBudget");
  if (!budget) {
    return;
  }

  if (budget.admitted >= budget.limit) {
    budget.stopReason = "limit";
    throw new Error(`Tool call budget exhausted (${budget.limit})`);
  }

  budget.admitted += 1;
  const signature = `${toolName}:${stableStringify(input)}`;
  if (budget.consecutiveSignature === signature) {
    budget.consecutiveCount = (budget.consecutiveCount || 1) + 1;
  } else {
    budget.consecutiveSignature = signature;
    budget.consecutiveCount = 1;
  }

  if ((budget.consecutiveCount || 0) >= MAX_CONSECUTIVE_IDENTICAL_CALLS) {
    budget.stopReason = "repeated_call";
  }
};

export const enforceToolCallBudget = <TTool>(tool: TTool, toolName = "tool"): TTool => {
  if (typeof tool !== "object" || tool === null) {
    return tool;
  }

  const executableTool = tool as TTool & ExecutableTool;
  if (typeof executableTool.execute !== "function") {
    return tool;
  }

  const execute = executableTool.execute as BudgetedExecute;
  const budgetedExecute = async (input: unknown, context: ToolExecutionContext) => {
    admitToolCall(toolName, input, context);
    return execute.call(tool, input, context);
  };

  return new Proxy(tool, {
    get(target, property) {
      if (property === "execute") {
        return budgetedExecute;
      }

      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
};

export const enforceToolCallBudgetForTools = <TTools extends Record<string, unknown>>(
  tools: TTools,
): TTools => Object.fromEntries(
  Object.entries(tools).map(([name, tool]) => [name, enforceToolCallBudget(tool, name)]),
) as TTools;
