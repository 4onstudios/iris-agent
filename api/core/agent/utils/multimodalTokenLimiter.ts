import { TokenLimiterProcessor } from "@mastra/core/processors";
import type { ProcessInputStepArgs } from "@mastra/core/processors";

type MutableRecord = Record<string, unknown>;
type MessageListLike = ProcessInputStepArgs["messageList"];

const EMPTY_BUDGET_ERROR_MARKER =
  "No messages fit within the remaining token budget";
const EMERGENCY_TRUNCATION_NOTICE =
  "[conversation truncated to fit token budget for this step]";
const EMERGENCY_MAX_CONTENT_CHARS = 1_200;

const isRecord = (value: unknown): value is MutableRecord =>
  typeof value === "object" && value !== null;

const asString = (value: unknown): string =>
  typeof value === "string" ? value : "";

const truncateText = (value: string, maxChars = EMERGENCY_MAX_CONTENT_CHARS): string => {
  if (value.length <= maxChars) {
    return value;
  }

  const head = value.slice(0, Math.max(0, maxChars - EMERGENCY_TRUNCATION_NOTICE.length - 2));
  return `${head}\n${EMERGENCY_TRUNCATION_NOTICE}`;
};

const getMessageParts = (message: MutableRecord): unknown[] => {
  if (Array.isArray(message.content)) {
    return message.content;
  }
  if (isRecord(message.content) && Array.isArray(message.content.parts)) {
    return message.content.parts;
  }
  return [];
};

const getMessageId = (message: MutableRecord): string | null => {
  const id = message.id;
  return typeof id === "string" && id.length > 0 ? id : null;
};

const getMessageRole = (message: MutableRecord): string => {
  const role = message.role;
  return typeof role === "string" ? role : "";
};

const compactMessageContent = (message: MutableRecord): void => {
  const content = message.content;

  if (typeof content === "string") {
    message.content = truncateText(content);
    return;
  }

  if (Array.isArray(content)) {
    const textParts = content
      .filter((part) => isRecord(part) && part.type === "text")
      .map((part) => asString((part as MutableRecord).text).trim())
      .filter((text) => text.length > 0);

    const merged = textParts.join("\n\n").trim();
    message.content = truncateText(merged || EMERGENCY_TRUNCATION_NOTICE);
    return;
  }

  if (isRecord(content) && Array.isArray(content.parts)) {
    const textParts = content.parts
      .filter((part) => isRecord(part) && part.type === "text")
      .map((part) => asString((part as MutableRecord).text).trim())
      .filter((text) => text.length > 0);

    const merged = textParts.join("\n\n").trim();
    message.content = truncateText(merged || EMERGENCY_TRUNCATION_NOTICE);
    return;
  }

  message.content = EMERGENCY_TRUNCATION_NOTICE;
};

const applyEmergencyBudgetFallback = async (
  messageList: MessageListLike,
): Promise<boolean> => {
  const messages = messageList?.get?.all?.db?.();
  if (!Array.isArray(messages) || messages.length === 0) {
    return false;
  }

  const records = messages.filter((msg) => isRecord(msg)) as MutableRecord[];
  if (records.length === 0) {
    return false;
  }

  let latestUserMessage: MutableRecord | null = null;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (getMessageRole(records[index]) === "user") {
      latestUserMessage = records[index];
      break;
    }
  }

  const lastMessage = records[records.length - 1] || null;
  const keepSet = new Set<MutableRecord>();
  if (latestUserMessage) keepSet.add(latestUserMessage);
  if (lastMessage) keepSet.add(lastMessage);
  if (keepSet.size === 0 && records[0]) keepSet.add(records[0]);

  const removeIds = records
    .filter((message) => !keepSet.has(message))
    .map((message) => getMessageId(message))
    .filter((id): id is string => Boolean(id));

  if (removeIds.length > 0 && typeof messageList.removeByIds === "function") {
    await messageList.removeByIds(removeIds);
  }

  keepSet.forEach((message) => compactMessageContent(message));
  return removeIds.length > 0 || keepSet.size > 0;
};

const isNoMessagesFitBudgetError = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.message.includes(EMPTY_BUDGET_ERROR_MARKER);
};

const isImagePart = (part: MutableRecord): boolean => {
  if (part.type === "image" || part.type === "image-data" || part.type === "image-url") {
    return true;
  }

  if (part.type === "media") {
    const mediaType = typeof part.mediaType === "string" ? part.mediaType : "";
    return mediaType.startsWith("image/");
  }

  const mediaType =
    typeof part.mediaType === "string"
      ? part.mediaType
      : typeof part.mimeType === "string"
        ? part.mimeType
        : "";
  return part.type === "file" && mediaType.startsWith("image/");
};

/**
 * Tool-result parts nest their payload inside `output.value` (AI SDK v2
 * `LanguageModelV2ToolResultOutput` with `type: 'content'`), e.g. an MCP
 * screenshot tool returns `{ type: 'tool-result', output: { type: 'content',
 * value: [{ type: 'media', data, mediaType }] } }`. Images here are *not*
 * top-level content parts, so callers must also inspect this nested array to
 * find/redact images embedded in tool results.
 */
const getToolResultOutputValueParts = (part: MutableRecord): MutableRecord[] => {
  if (part.type !== "tool-result") {
    return [];
  }

  const output = part.output;
  if (!isRecord(output) || output.type !== "content" || !Array.isArray(output.value)) {
    return [];
  }

  return output.value.filter(isRecord);
};

const redactPartPayload = (
  part: MutableRecord,
  restorations: Array<() => void>,
): void => {
  for (const key of ["image", "data", "url"] as const) {
    if (!(key in part)) {
      continue;
    }

    const payload = part[key];
    part[key] = "[multimodal image]";
    restorations.push(() => {
      part[key] = payload;
    });
  }
};

export const redactMultimodalPayloads = (
  messages: unknown[],
): (() => void) => {
  const restorations: Array<() => void> = [];

  for (const message of messages) {
    if (!isRecord(message)) {
      continue;
    }

    for (const part of getMessageParts(message)) {
      if (!isRecord(part)) {
        continue;
      }
      if (isImagePart(part)) {
        redactPartPayload(part, restorations);
      }
      for (const nested of getToolResultOutputValueParts(part)) {
        if (isImagePart(nested)) {
          redactPartPayload(nested, restorations);
        }
      }
    }
  }

  return () => {
    for (const restore of restorations) {
      restore();
    }
  };
};

const IMAGE_UNSUPPORTED_PLACEHOLDER_TEXT =
  "[Image omitted: the selected model does not support image input]";

/**
 * Permanently converts image content parts (e.g. tool-result screenshots or
 * user-attached images) into a text placeholder. Used when the target model
 * does not support image input, to avoid provider-level 400/404 errors such
 * as OpenRouter's "No endpoints found that support image input".
 */
const stripUnsupportedImageParts = (messages: unknown[]): void => {
  for (const message of messages) {
    if (!isRecord(message)) {
      continue;
    }

    const parts = getMessageParts(message);
    if (parts.length === 0) {
      continue;
    }

    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      if (!isRecord(part)) {
        continue;
      }

      if (isImagePart(part)) {
        parts[i] = { type: "text", text: IMAGE_UNSUPPORTED_PLACEHOLDER_TEXT };
        continue;
      }

      // Tool-result parts carry images nested inside `output.value[]`; strip
      // those in place so the surrounding tool-result part (and its other
      // text entries) are preserved.
      const nestedParts = getToolResultOutputValueParts(part);
      if (nestedParts.length === 0) {
        continue;
      }

      for (let j = 0; j < nestedParts.length; j += 1) {
        if (isImagePart(nestedParts[j])) {
          nestedParts[j] = { type: "text", text: IMAGE_UNSUPPORTED_PLACEHOLDER_TEXT };
        }
      }
      (part.output as MutableRecord).value = nestedParts;
    }
  }
};

export class MultimodalTokenLimiterProcessor extends TokenLimiterProcessor {
  private readonly supportsVision: boolean;

  constructor(limit: number, supportsVision = true) {
    super(limit);
    this.supportsVision = supportsVision;
  }

  override async processInputStep(args: ProcessInputStepArgs): Promise<void> {
    const messages = args.messageList.get.all.db();

    if (!this.supportsVision) {
      stripUnsupportedImageParts(messages);
    }

    const restore = redactMultimodalPayloads(messages);

    try {
      await super.processInputStep(args);
    } catch (error) {
      if (!isNoMessagesFitBudgetError(error)) {
        throw error;
      }

      const didApplyFallback = await applyEmergencyBudgetFallback(args.messageList);
      if (!didApplyFallback) {
        throw error;
      }

      await super.processInputStep(args);
    } finally {
      restore();
    }
  }
}