import { WorkspaceMutationBridge } from "./workspaceMutationBridge";
import { redactToolResult } from "./toolResultSafetyProcessor";

type CapturedResult = {
  toolCallId: string;
  result: Record<string, unknown>;
};

type ToolInvocationUpdate = {
  toolInvocation?: {
    state?: string;
    toolCallId?: string;
    result?: unknown;
  };
};

const getGenerationId = (requestContext: unknown): string | undefined => {
  if (!requestContext || typeof requestContext !== "object") return undefined;
  const get = (requestContext as { get?: (key: string) => unknown }).get;
  if (typeof get !== "function") return undefined;
  const value = get.call(requestContext, "workspaceMutationGenerationId");
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

export class CapturedWorkspaceMutationBridge extends WorkspaceMutationBridge {
  private readonly processedResults = new Map<
    string,
    Map<string, Record<string, unknown>>
  >();

  takeProcessedResults(generationId: string, toolCallIds: string[]): CapturedResult[] {
    const results: CapturedResult[] = [];
    const generationResults = this.processedResults.get(generationId);
    if (!generationResults) return results;

    for (const toolCallId of toolCallIds) {
      const result = generationResults.get(toolCallId);
      if (!result) continue;
      generationResults.delete(toolCallId);
      results.push({ toolCallId, result });
    }

    if (generationResults.size === 0) {
      this.processedResults.delete(generationId);
    }

    return results;
  }

  clearProcessedResults(generationId: string): void {
    this.processedResults.delete(generationId);
  }

  override async processToolResult(
    args: Parameters<WorkspaceMutationBridge["processToolResult"]>[0],
  ) {
    const messageList = args.messageList;
    const generationId = getGenerationId(args.requestContext);
    const originalUpdateToolInvocation = messageList.updateToolInvocation;
    messageList.updateToolInvocation = (update: ToolInvocationUpdate) => {
      const invocation = update.toolInvocation;
      const sanitizedResult = redactToolResult(invocation?.result).result;
      if (
        invocation?.state === "result" &&
        typeof invocation.toolCallId === "string" &&
        sanitizedResult &&
        typeof sanitizedResult === "object" &&
        generationId
      ) {
        let generationResults = this.processedResults.get(generationId);
        if (!generationResults) {
          generationResults = new Map();
          this.processedResults.set(generationId, generationResults);
        }
        generationResults.set(
          invocation.toolCallId,
          sanitizedResult as Record<string, unknown>,
        );
      }
      return originalUpdateToolInvocation.call(
        messageList,
        {
          ...update,
          toolInvocation: invocation
            ? { ...invocation, result: sanitizedResult }
            : invocation,
        } as never,
      );
    };

    try {
      return await super.processToolResult(args);
    } finally {
      messageList.updateToolInvocation = originalUpdateToolInvocation;
    }
  }
}
