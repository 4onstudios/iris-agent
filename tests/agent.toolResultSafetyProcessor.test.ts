import { ToolResultSafetyProcessor } from "../api/core/agent/utils/toolResultSafetyProcessor";

const runProcessor = async (result: unknown) => {
  const updateToolInvocation = jest.fn();
  const messageList = { updateToolInvocation };
  const processor = new ToolResultSafetyProcessor();

  await processor.processToolResult({
    toolName: "readFile",
    toolCallId: "call-1",
    args: { filePath: ".env" },
    result,
    messageList,
  } as never);

  return { messageList, updateToolInvocation };
};

describe("ToolResultSafetyProcessor", () => {
  it("redacts nested sensitive values before adding a tool result to history", async () => {
    const warning = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const shared = { token: "sk-abcdefghijklmnopqrstuvwxyz123456" };
    const result = { content: shared, duplicate: shared };

    const { updateToolInvocation } = await runProcessor(result);

    expect(updateToolInvocation).toHaveBeenCalledWith({
      type: "tool-invocation",
      toolInvocation: {
        state: "result",
        toolCallId: "call-1",
        toolName: "readFile",
        args: { filePath: ".env" },
        result: {
          content: { token: "[REDACTED:openai_key]" },
          duplicate: { token: "[REDACTED:openai_key]" },
        },
      },
    });
    expect(warning).toHaveBeenCalledWith(
      "Redacted sensitive data from tool result",
      expect.objectContaining({
        toolName: "readFile",
        redactionCount: 1,
        redactionTypes: ["openai_key"],
      }),
    );
    warning.mockRestore();
  });

  it("does not rewrite clean tool results", async () => {
    const { messageList, updateToolInvocation } = await runProcessor({
      content: "export const answer = 42;",
    });

    expect(updateToolInvocation).not.toHaveBeenCalled();
    expect(messageList).toEqual({ updateToolInvocation });
  });
});