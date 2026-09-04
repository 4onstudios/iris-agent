export type ConversationMessageLike = {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
};

export type ContextSummaryItemLike = {
  preview: string;
};

export type ParsedSlashCommand = {
  name: string;
  shellCommand: string;
};

type SlashCommandMetadata = {
  name: string;
  description: string;
  executeImmediately: boolean;
  kind: "builtin" | "shell";
  aliases?: string[];
};

export type SlashCommandDescriptor = {
  name: string;
  description: string;
  executeImmediately: boolean;
  kind: "builtin" | "shell";
  aliases: string[];
};

const REGISTERED_SLASH_COMMANDS: SlashCommandMetadata[] = [
  {
    name: "help",
    description: "Show available slash commands.",
    executeImmediately: true,
    kind: "builtin",
  },
  {
    name: "compact",
    description:
      "Summarize recent conversation context into a compact digest.",
    executeImmediately: true,
    kind: "builtin",
  },
  {
    name: "run",
    description: "Run a shell command. Example: /run npm test",
    executeImmediately: false,
    kind: "shell",
    aliases: ["sh", "shell"],
  },
];

const getRegisteredSlashCommand = (name: string) =>
  REGISTERED_SLASH_COMMANDS.find(
    (command) =>
      command.name === name ||
      Boolean(command.aliases?.includes(name)),
  );

export const getSlashCommandDescriptors = (): SlashCommandDescriptor[] =>
  REGISTERED_SLASH_COMMANDS.map((command) => ({
    name: command.name,
    description: command.description,
    executeImmediately: command.executeImmediately,
    kind: command.kind,
    aliases: command.aliases || [],
  }));

export const parseSlashCommandRequest = (input?: string): ParsedSlashCommand | null => {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  if (trimmed.startsWith("//")) return null;

  const rawCommand = trimmed.slice(1).trim();
  if (!rawCommand) return null;

  const [commandName, ...argParts] = rawCommand.split(/\s+/);
  const name = (commandName || "").trim().toLowerCase();
  const args = argParts.join(" ").trim();

  if (!name) return null;

  const resolvedCommand = getRegisteredSlashCommand(name);
  const shellCommand = resolvedCommand?.kind === "shell" ? args : rawCommand;
  return {
    name,
    shellCommand,
  };
};

export const isSlashCommandsFeatureEnabled = (): boolean => {
  const raw = process.env.IRIS_ENABLE_SLASH_COMMANDS;
  return raw === undefined
    ? true
    : !["0", "false", "off", "no"].includes(raw.trim().toLowerCase());
};

const formatSlashCommandsHelp = () => {
  const lines = ["Available slash commands:"];
  for (const command of REGISTERED_SLASH_COMMANDS) {
    const aliasSuffix =
      command.aliases && command.aliases.length > 0
        ? ` (aliases: ${command.aliases.map((alias) => `/${alias}`).join(", ")})`
        : "";
    lines.push(`- /${command.name}${aliasSuffix}: ${command.description}`);
  }
  return lines.join("\n");
};

const buildCompactDigest = (
  conversationHistory?: ConversationMessageLike[],
  contextSummary?: ContextSummaryItemLike[],
) => {
  const recentMessages = (conversationHistory || [])
    .filter((message) => message?.content)
    .slice(-8);
  const recentUserMessages = recentMessages
    .filter((message) => message.role === "user")
    .slice(-3)
    .map((message) => message.content.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .map((text) => (text.length > 140 ? `${text.slice(0, 137)}...` : text));
  const contextItems = (contextSummary || [])
    .slice(-5)
    .map((item) => item.preview.trim())
    .filter(Boolean)
    .map((text) => (text.length > 120 ? `${text.slice(0, 117)}...` : text));

  const lines = [
    "Conversation compact digest:",
    `- Recent messages: ${recentMessages.length}`,
    `- Context snippets: ${contextItems.length}`,
  ];

  if (recentUserMessages.length > 0) {
    lines.push("- Recent user intents:");
    for (const message of recentUserMessages) {
      lines.push(`  - ${message}`);
    }
  }

  if (contextItems.length > 0) {
    lines.push("- Context summary excerpts:");
    for (const item of contextItems) {
      lines.push(`  - ${item}`);
    }
  }

  if (recentUserMessages.length === 0 && contextItems.length === 0) {
    lines.push("- No prior conversation context is available yet.");
  }

  return lines.join("\n");
};

export const executeRegisteredSlashCommand = ({
  parsedCommand,
  conversationHistory,
  contextSummary,
}: {
  parsedCommand: ParsedSlashCommand;
  conversationHistory?: ConversationMessageLike[];
  contextSummary?: ContextSummaryItemLike[];
}) => {
  const command = getRegisteredSlashCommand(parsedCommand.name);
  if (!command || command.kind !== "builtin") {
    return null;
  }

  if (command.name === "help") {
    return {
      success: true,
      response: formatSlashCommandsHelp(),
      toolCalls: [],
      executedToolResults: [],
    };
  }

  if (command.name === "compact") {
    return {
      success: true,
      response: buildCompactDigest(conversationHistory, contextSummary),
      toolCalls: [],
      executedToolResults: [],
    };
  }

  return null;
};
