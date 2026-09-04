import {
  MultimodalTokenLimiterProcessor,
  redactMultimodalPayloads,
} from "../api/core/agent/utils/multimodalTokenLimiter";
import { TokenLimiterProcessor } from "@mastra/core/processors";

describe("redactMultimodalPayloads", () => {
  it("temporarily replaces image data while preserving text and restoring the payload", () => {
    const image = "data:image/png;base64," + "a".repeat(400_000);
    const messages = [
      {
        role: "user",
        content: {
          parts: [
            { type: "text", text: "Describe this image" },
            { type: "image", image, mediaType: "image/png" },
          ],
        },
      },
    ];

    const restore = redactMultimodalPayloads(messages);

    expect(messages[0].content.parts[0]).toEqual({
      type: "text",
      text: "Describe this image",
    });
    expect(messages[0].content.parts[1].image).toBe("[multimodal image]");

    restore();

    expect(messages[0].content.parts[1].image).toBe(image);
  });

  it("handles Mastra-normalized URL images and array content", () => {
    const image = new URL("data:image/png;base64," + "a".repeat(400_000));
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "Describe this image" },
          { type: "image", image, mediaType: "image/png" },
        ],
      },
    ];

    const restore = redactMultimodalPayloads(messages);

    expect(messages[0].content[1].image).toBe("[multimodal image]");

    restore();

    expect(messages[0].content[1].image).toBe(image);
  });

  it("handles image file parts", () => {
    const data = "a".repeat(400_000);
    const messages = [
      {
        role: "user",
        content: {
          parts: [{ type: "file", data, mediaType: "image/png" }],
        },
      },
    ];

    const restore = redactMultimodalPayloads(messages);

    expect(messages[0].content.parts[0].data).toBe("[multimodal image]");

    restore();

    expect(messages[0].content.parts[0].data).toBe(data);
  });

  it("handles images nested inside tool-result output.value (e.g. MCP screenshot tool)", () => {
    const data = "a".repeat(400_000);
    const messages = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_1",
            toolName: "mcp_blender_get_viewport_screenshot",
            output: {
              type: "content",
              value: [
                { type: "text", text: "Screenshot captured" },
                { type: "media", data, mediaType: "image/png" },
              ],
            },
          },
        ],
      },
    ];

    const restore = redactMultimodalPayloads(messages);

    const value = (messages[0].content[0] as any).output.value;
    expect(value[0]).toEqual({ type: "text", text: "Screenshot captured" });
    expect(value[1].data).toBe("[multimodal image]");

    restore();

    expect(value[1].data).toBe(data);
  });

  it("lets a large normalized image pass Mastra token limiting", async () => {
    const image = new URL("data:image/png;base64," + "a".repeat(400_000));
    const message = {
      id: "message-1",
      role: "user",
      content: {
        parts: [
          { type: "text", text: "Describe this image" },
          { type: "image", image, mediaType: "image/png" },
        ],
      },
    };
    const removeByIds = jest.fn();
    const processor = new MultimodalTokenLimiterProcessor(1_000);

    await processor.processInputStep({
      messageList: {
        get: { all: { db: () => [message] } },
        getAllSystemMessages: () => [],
        removeByIds,
      },
    } as any);

    expect(removeByIds).not.toHaveBeenCalled();
    expect(message.content.parts[1].image).toBe(image);
  });

  it("permanently strips a top-level image part when the model does not support vision", async () => {
    const image = new URL("data:image/png;base64," + "a".repeat(1_000));
    const message = {
      id: "message-1",
      role: "user",
      content: {
        parts: [
          { type: "text", text: "Describe this image" },
          { type: "image", image, mediaType: "image/png" },
        ],
      },
    };
    const processor = new MultimodalTokenLimiterProcessor(1_000, false);

    await processor.processInputStep({
      messageList: {
        get: { all: { db: () => [message] } },
        getAllSystemMessages: () => [],
        removeByIds: jest.fn(),
      },
    } as any);

    expect(message.content.parts[1]).toEqual({
      type: "text",
      text: "[Image omitted: the selected model does not support image input]",
    });
  });

  it("permanently strips an image nested in a tool-result output.value when the model does not support vision", async () => {
    const message = {
      id: "message-1",
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_1",
          toolName: "mcp_blender_get_viewport_screenshot",
          output: {
            type: "content",
            value: [
              { type: "text", text: "Screenshot captured" },
              { type: "media", data: "a".repeat(1_000), mediaType: "image/png" },
            ],
          },
        },
      ],
    };
    const processor = new MultimodalTokenLimiterProcessor(1_000, false);

    await processor.processInputStep({
      messageList: {
        get: { all: { db: () => [message] } },
        getAllSystemMessages: () => [],
        removeByIds: jest.fn(),
      },
    } as any);

    const value = (message.content[0] as any).output.value;
    expect(value[0]).toEqual({ type: "text", text: "Screenshot captured" });
    expect(value[1]).toEqual({
      type: "text",
      text: "[Image omitted: the selected model does not support image input]",
    });
  });

  it("falls back to compact latest messages when no messages fit budget", async () => {
    const original = TokenLimiterProcessor.prototype.processInputStep;
    const processSpy = jest
      .spyOn(TokenLimiterProcessor.prototype, "processInputStep")
      .mockImplementationOnce(async () => {
        throw new Error(
          "TokenLimiterProcessor: No messages fit within the remaining token budget. Cannot send LLM a request with no messages.",
        );
      })
      .mockImplementationOnce(async () => undefined);

    const messages = [
      {
        id: "sys-1",
        role: "system",
        content: "system context ".repeat(400),
      },
      {
        id: "user-1",
        role: "user",
        content: "user request ".repeat(400),
      },
      {
        id: "assistant-1",
        role: "assistant",
        content: "assistant draft ".repeat(400),
      },
    ];
    const removeByIds = jest.fn();
    const processor = new MultimodalTokenLimiterProcessor(64_000);

    try {
      await processor.processInputStep({
        messageList: {
          get: { all: { db: () => messages } },
          getAllSystemMessages: () => [],
          removeByIds,
        },
      } as any);

      expect(processSpy).toHaveBeenCalledTimes(2);
      expect(removeByIds).toHaveBeenCalledTimes(1);
      expect(removeByIds).toHaveBeenCalledWith(["sys-1"]);
      expect(typeof messages[1].content).toBe("string");
      expect((messages[1].content as string).length).toBeLessThanOrEqual(1_200);
      expect(typeof messages[2].content).toBe("string");
      expect((messages[2].content as string).length).toBeLessThanOrEqual(1_200);
    } finally {
      processSpy.mockRestore();
      TokenLimiterProcessor.prototype.processInputStep = original;
    }
  });

  it("waits for message removal before retrying the limiter", async () => {
    const original = TokenLimiterProcessor.prototype.processInputStep;
    const processSpy = jest
      .spyOn(TokenLimiterProcessor.prototype, "processInputStep")
      .mockImplementationOnce(async () => {
        throw new Error(
          "TokenLimiterProcessor: No messages fit within the remaining token budget. Cannot send LLM a request with no messages.",
        );
      })
      .mockImplementationOnce(async () => undefined);
    const messages = [
      { id: "old", role: "assistant", content: "old" },
      { id: "latest", role: "user", content: "latest" },
    ];
    let removalFinished = false;

    try {
      await new MultimodalTokenLimiterProcessor(64_000).processInputStep({
        messageList: {
          get: { all: { db: () => messages } },
          getAllSystemMessages: () => [],
          removeByIds: async () => {
            await Promise.resolve();
            removalFinished = true;
          },
        },
      } as any);

      expect(removalFinished).toBe(true);
      expect(processSpy).toHaveBeenCalledTimes(2);
    } finally {
      processSpy.mockRestore();
      TokenLimiterProcessor.prototype.processInputStep = original;
    }
  });
});