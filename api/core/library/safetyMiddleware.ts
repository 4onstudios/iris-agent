/**
 * Safety Middleware for LLM Requests
 * Detects and redacts PII and secrets before passing to LLM providers
 */

type SafetyPattern = {
  name: string;
  regex: RegExp;
};

type Redaction = {
  type: string;
  value: string;
  position: number;
  length: number;
};

export type SafetyMessage = {
  role: string;
  content: string;
  [key: string]: unknown;
};

export type SafetyRequest = {
  messages: SafetyMessage[];
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
};

type AuditEvent = {
  timestamp: string;
  redactionCount: number;
  redactionTypes: string[];
  hasSecrets: boolean;
  hasPII: boolean;
  processingTime?: number;
};

type BlockEvent = {
  reason: string;
  timestamp: string;
  redactionCount: number;
  redactionTypes: string[];
};

type SafetyOptions = {
  blockOnSecrets?: boolean;
  blockOnPII?: boolean;
  // eslint-disable-next-line no-unused-vars
  onAudit?: ((event: AuditEvent) => void) | null;
  // eslint-disable-next-line no-unused-vars
  onBlock?: ((event: BlockEvent) => void) | null;
};

type SafetyError = Error & {
  code?: string;
  redactionTypes?: string[];
};

// PII Patterns - can be upgraded with stronger libraries like zod-validation or microsoft-presidio
export const PII_PATTERNS: SafetyPattern[] = [
  { name: "email", regex: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
  { name: "phone", regex: /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g },
  { name: "credit_card", regex: /\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/g },
  { name: "ssn", regex: /\b\d{3}-\d{2}-\d{4}\b/g },
  { name: "ip_address", regex: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g },
];

// Secret Patterns - API keys, tokens, etc.
export const SECRET_PATTERNS: SafetyPattern[] = [
  { name: "openai_key", regex: /sk-[a-zA-Z0-9]{20,}/g },
  { name: "anthropic_key", regex: /sk-ant-[a-zA-Z0-9-_]{20,}/g },
  { name: "aws_key", regex: /AKIA[0-9A-Z]{16}/g },
  {
    name: "aws_secret",
    regex:
      /(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[:=]\s*['"]?([A-Za-z0-9/+=]{40})['"]?/g,
  },
  { name: "jwt", regex: /eyJ[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+/g },
  { name: "github_token", regex: /gh[pousr]_[A-Za-z0-9_]{36,}/g },
  { name: "stripe_key", regex: /sk_(live|test)_[0-9a-zA-Z]{24,}/g },
  { name: "huggingface_key", regex: /hf_[a-zA-Z0-9]{20,}/g },
];

/**
 * Redact sensitive information from text
 * @param {string} text - Text to scan and redact
 * @returns {{ output: string, redactions: Array<{type: string, value: string, position: number}> }}
 */
export function redact(text: string) {
  if (!text || typeof text !== "string") {
    return { output: text, redactions: [] };
  }

  let redactions: Redaction[] = [];
  let output = text;

  const allPatterns = [...PII_PATTERNS, ...SECRET_PATTERNS];

  for (const pattern of allPatterns) {
    const matches = [
      ...text.matchAll(new RegExp(pattern.regex.source, pattern.regex.flags)),
    ];

    for (const match of matches) {
      const originalValue = match[0];
      const position = match.index;

      redactions.push({
        type: pattern.name,
        value: originalValue,
        position: position,
        length: originalValue.length,
      });
    }
  }

  // Sort by position to replace from end to start (prevents offset issues)
  redactions.sort((a, b) => b.position - a.position);

  // Replace all matches
  for (const redaction of redactions) {
    const placeholder = `[REDACTED:${redaction.type}]`;
    output =
      output.substring(0, redaction.position) +
      placeholder +
      output.substring(redaction.position + redaction.length);
  }

  // Reverse to chronological order for logging
  redactions.reverse();

  return { output, redactions };
}

/**
 * Redact sensitive information from messages array
 * @param {Array<{role: string, content: string}>} messages
 * @returns {{safeMessages: Array, totalRedactions: Array}}
 */
export function redactMessages(messages: SafetyMessage[]) {
  let totalRedactions: Array<{
    messageIndex: number;
    role: string;
    redactions: Redaction[];
  }> = [];

  const safeMessages = messages.map((msg: SafetyMessage, index: number) => {
    const { output, redactions } = redact(msg.content);

    if (redactions.length > 0) {
      totalRedactions.push({
        messageIndex: index,
        role: msg.role,
        redactions: redactions,
      });
    }

    return { ...msg, content: output };
  });

  return { safeMessages, totalRedactions };
}

/**
 * Higher-order function to wrap LLM handlers with safety middleware
 * @param {Function} handler - Original LLM handler function
 * @param {Object} options - Configuration options
 * @param {boolean} options.blockOnSecrets - Block requests containing secrets
 * @param {boolean} options.blockOnPII - Block requests containing PII
 * @param {Function} options.onAudit - Audit callback function
 * @param {Function} options.onBlock - Called when request is blocked
 * @returns {Function} - Wrapped handler function
 */
export function withSafetyMiddleware(
  // eslint-disable-next-line no-unused-vars
  handler: (req: SafetyRequest) => Promise<unknown>,
  options: SafetyOptions = {},
) {
  const {
    blockOnSecrets = false,
    blockOnPII = false,
    onAudit = null,
    onBlock = null,
  } = options;

  return async (req: SafetyRequest) => {
    const startTime = Date.now();
    let totalRedactions: Redaction[] = [];

    // Redact messages
    const safeMessages = req.messages.map((msg) => {
      const { output, redactions } = redact(msg.content);
      totalRedactions.push(...redactions);
      return { ...msg, content: output };
    });

    // Check for blocking conditions
    const secretTypes = [
      "openai_key",
      "anthropic_key",
      "aws_key",
      "aws_secret",
      "jwt",
      "github_token",
      "stripe_key",
      "huggingface_key",
    ];
    const piiTypes = ["email", "phone", "credit_card", "ssn", "ip_address"];

    const hasSecrets = totalRedactions.some((r) =>
      secretTypes.includes(r.type)
    );
    const hasPII = totalRedactions.some((r) => piiTypes.includes(r.type));

    // 🚨 Fail-closed if secrets detected
    if (blockOnSecrets && hasSecrets) {
      const error = new Error(
        "Request blocked: secrets detected in prompt",
      ) as SafetyError;
      error.code = "SECURITY_BLOCK_SECRETS";
      error.redactionTypes = [...new Set(totalRedactions.map((r) => r.type))];

      if (onBlock) {
        onBlock({
          reason: "secrets_detected",
          timestamp: new Date().toISOString(),
          redactionCount: totalRedactions.length,
          redactionTypes: error.redactionTypes,
        });
      }

      throw error;
    }

    // 🚨 Fail-closed if PII detected
    if (blockOnPII && hasPII) {
      const error = new Error("Request blocked: PII detected in prompt") as SafetyError;
      error.code = "SECURITY_BLOCK_PII";
      error.redactionTypes = [...new Set(totalRedactions.map((r) => r.type))];

      if (onBlock) {
        onBlock({
          reason: "pii_detected",
          timestamp: new Date().toISOString(),
          redactionCount: totalRedactions.length,
          redactionTypes: error.redactionTypes,
        });
      }

      throw error;
    }

    // 🔍 Audit (no raw PII/secrets logged!)
    if (onAudit && totalRedactions.length > 0) {
      onAudit({
        timestamp: new Date().toISOString(),
        redactionCount: totalRedactions.length,
        redactionTypes: [...new Set(totalRedactions.map((r) => r.type))],
        hasSecrets,
        hasPII,
        processingTime: Date.now() - startTime,
      });
    }

    // Call the wrapped handler with safe messages
    const response = await handler({
      ...req,
      messages: safeMessages,
      metadata: {
        ...req.metadata,
        redacted: totalRedactions.length > 0,
        redactionCount: totalRedactions.length,
      },
    });

    return response;
  };
}

/**
 * Create a safe LLM wrapper with default audit logging
 * @param {Function} handler - Original LLM handler
 * @param {Object} options - Options
 * @returns {Function} - Safe wrapped handler
 */
export function createSafeLLM(
  // eslint-disable-next-line no-unused-vars
  handler: (req: SafetyRequest) => Promise<unknown>,
  options: SafetyOptions = {},
) {
  const defaultAudit = (event: AuditEvent) => {
    if (event.redactionCount > 0) {
      console.warn("[Safety Middleware]", {
        redacted: event.redactionCount,
        types: event.redactionTypes,
        time: event.timestamp,
      });
    }
  };

  return withSafetyMiddleware(handler, {
    blockOnSecrets: true,
    blockOnPII: false,
    onAudit: options.onAudit || defaultAudit,
    onBlock:
      options.onBlock ||
      ((event: BlockEvent) => {
        console.error("[Safety Middleware] BLOCKED:", event);
      }),
    ...options,
  });
}

export default {
  redact,
  redactMessages,
  withSafetyMiddleware,
  createSafeLLM,
  PII_PATTERNS,
  SECRET_PATTERNS,
};
