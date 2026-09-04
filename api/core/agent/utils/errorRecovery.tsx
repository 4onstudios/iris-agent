/**
 * Error Recovery Utilities
 * Automatic retry logic and error-specific recovery strategies
 */

import path from "path";

type ToolParams = Record<string, unknown>;

type ToolResult = Record<string, unknown> & {
  success?: boolean;
  error?: string;
};

type ToolLike = {
  name?: string;
  // eslint-disable-next-line no-unused-vars
  execute: (params: ToolParams) => Promise<ToolResult>;
};

type ToolLikeGeneric<TParams extends ToolParams, TResult extends ToolResult> = {
  name?: string;
  // eslint-disable-next-line no-unused-vars
  execute: (params: TParams) => Promise<TResult>;
};

type RecoveryOptions = {
  maxRetries?: number;
  // eslint-disable-next-line no-unused-vars
  searchFiles?: ((pattern: string) => Promise<string[]>) | null;
  workspacePath?: string;
  timeout?: number;
};

type RecoveryResult =
  | {
      recovered: true;
      strategy: string;
      params: ToolParams;
      suggestion?: string;
    }
  | {
      recovered: false;
      strategy?: string;
      suggestion?: string;
    };

type RecoveryMiddlewareOptions = {
  maxRetries?: number;
  // eslint-disable-next-line no-unused-vars
  onError?: ((error: Error, attempt: number, params: ToolParams) => Promise<boolean> | boolean) | null;
};

type ErrnoError = Error & {
  code?: string;
};

const isNonRetryableSecurityError = (message: string): boolean => {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("security error")
    || normalized.includes("outside workspace root")
    || normalized.includes("outside workspace boundary")
    || normalized.includes("access denied")
  );
};

/**
 * Execute tool with automatic retry and error recovery
 * @param {object} tool - Tool object with execute method
 * @param {object} params - Tool parameters
 * @param {object} options - Options {maxRetries, searchFiles}
 * @returns {Promise<any>} Tool result
 */
export const executeToolWithRecovery = async <
  TParams extends ToolParams,
  TResult extends ToolResult,
>(
  tool: ToolLikeGeneric<TParams, TResult>,
  params: TParams,
  options: RecoveryOptions = {}
): Promise<TResult | ToolResult> => {
  const { maxRetries = 2, searchFiles = null } = options;
  let lastError: Error | null = null;
  const toolLabel = tool.name || "unnamed_tool";

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // Execute the tool
      const result = await tool.execute(params);

      // If successful and this was a retry, log the recovery
      if (attempt > 0 && result && !result.error) {
        console.log(
          `✅ Tool ${toolLabel} succeeded after ${attempt} ${
            attempt === 1 ? "retry" : "retries"
          }`
        );
      }

      // If successful, reset error tracking
      if (result && !result.error) {
        return result;
      }

      // If result has error but not an exception, treat as soft error
      if (result && result.error) {
        lastError = new Error(String(result.error));
        throw lastError;
      }

      return result;
    } catch (error) {
      const err = error as Error;
      lastError = err;
      console.warn(
        `⚠️ Tool ${toolLabel} failed (attempt ${attempt + 1}/${
          maxRetries + 1
        }):`,
        err.message
      );

      if (isNonRetryableSecurityError(err.message)) {
        break;
      }

      // Don't retry on last attempt
      if (attempt === maxRetries) {
        break;
      }

      // Attempt to fix common issues
      const recoveryResult = await attemptRecovery(tool, params, err, {
        searchFiles,
      });

      if (recoveryResult.recovered) {
        console.log(`✅ Recovered from error: ${recoveryResult.strategy}`);
        // Update params with recovered values
        Object.assign(params, recoveryResult.params);
        continue; // Retry with updated params
      }

      // If recovery failed, wait before retry
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }

  // All retries failed, return error response
  return {
    success: false,
    error: lastError?.message || "Unknown error",
    suggestion: getErrorSuggestion(lastError || new Error("Unknown error"), tool.name || "unknown"),
  };
};

/**
 * Attempt to recover from common errors
 * @param {object} tool - Tool object
 * @param {object} params - Original params
 * @param {Error} error - Error that occurred
 * @param {object} context - Additional context {searchFiles}
 * @returns {Promise<object>} {recovered, strategy, params}
 */
const attemptRecovery = async (
  tool: { name?: string },
  params: ToolParams,
  error: ErrnoError,
  context: RecoveryOptions = {}
): Promise<RecoveryResult> => {
  const { searchFiles } = context;

  void tool;

  // File not found - try searching for it
  if (error.code === "ENOENT" || error.message.includes("no such file")) {
    console.log("🔍 File not found, attempting search...");

    if (searchFiles && typeof params.filePath === "string") {
      try {
        const fileName = path.basename(params.filePath);
        const searchResult = await searchFiles(`**/*${fileName}*`);

        if (searchResult && searchResult.length > 0) {
          console.log(`✅ Found file at: ${searchResult[0]}`);
          return {
            recovered: true,
            strategy: "file_search",
            params: { ...params, filePath: searchResult[0] },
          };
        }
      } catch (searchError) {
        const err = searchError as Error;
        console.warn("Search failed:", err.message);
      }
    }
  }

  // Permission denied
  if (error.message.includes("permission denied") || error.code === "EACCES") {
    return {
      recovered: false,
      strategy: "permission_error",
      suggestion:
        "This operation requires elevated permissions. Please check file permissions or run with appropriate access.",
    };
  }

  // Path traversal / invalid path
  if (error.message.includes("path") && error.message.includes("invalid")) {
    console.log("🔍 Invalid path, attempting normalization...");

    if (typeof params.filePath === "string") {
      const normalized = path.normalize(params.filePath);
      if (normalized !== params.filePath) {
        return {
          recovered: true,
          strategy: "path_normalization",
          params: { ...params, filePath: normalized },
        };
      }
    }
  }

  // Timeout error
  if (error.message.includes("timeout") || error.code === "ETIMEDOUT") {
    console.log("⏱️ Timeout detected, will retry with longer timeout...");
    return {
      recovered: true,
      strategy: "increase_timeout",
      params: {
        ...params,
        timeout:
          (typeof params.timeout === "number" ? params.timeout : 5000) * 2,
      },
    };
  }

  // No recovery strategy found
  return { recovered: false };
};

/**
 * Get helpful error suggestion based on error and tool
 * @param {Error} error - The error
 * @param {string} toolName - Tool name
 * @returns {string} Suggestion text
 */
const getErrorSuggestion = (error: Error, toolName: string) => {
  const message = error.message.toLowerCase();

  void toolName;

  if (message.includes("not found") || message.includes("enoent")) {
    return "File or directory not found. Try using searchFiles to locate the correct path, or verify the path exists in the workspace.";
  }

  if (message.includes("permission")) {
    return "Permission denied. Check file permissions or try a different approach that doesn't require elevated access.";
  }

  if (message.includes("timeout")) {
    return "Operation timed out. The file or operation may be too large. Try processing smaller chunks or using a different approach.";
  }

  if (message.includes("syntax") || message.includes("parse")) {
    return "Syntax or parsing error. Verify the content format and try again with corrected syntax.";
  }

  if (message.includes("network") || message.includes("connection")) {
    return "Network or connection error. Check internet connectivity and try again.";
  }

  // Generic suggestion
  return "Operation failed. Review the error message and try an alternative approach or break the task into smaller steps.";
};

/**
 * Wrap multiple tools with recovery
 * @param {object[]} tools - Array of tool objects
 * @returns {object[]} Tools with recovery wrappers
 */
export const wrapToolsWithRecovery = (tools: ToolLike[]): ToolLike[] => {
  return tools.map((tool) => ({
    ...tool,
    execute: async (params: ToolParams) => {
      const searchTool = tools.find((t) => t.name === "searchFiles");

      return executeToolWithRecovery(tool, params, {
        // Pass searchFiles tool if available for file recovery
        searchFiles: searchTool
          ? async (pattern: string) => {
              const result = await searchTool.execute({ pattern });
              const files = result.files;
              return Array.isArray(files)
                ? files.filter((file): file is string => typeof file === "string")
                : [];
            }
          : null,
      });
    },
  }));
};

/**
 * Create error recovery middleware for tool execution
 * @param {Function} executeFunc - Original execute function
 * @param {object} options - Recovery options
 * @returns {Function} Wrapped execute function
 */
export const createRecoveryMiddleware = (
  // eslint-disable-next-line no-unused-vars
  executeFunc: (params: ToolParams) => Promise<ToolResult>,
  options: RecoveryMiddlewareOptions = {}
) => {
  return async (params: ToolParams) => {
    const { maxRetries = 2, onError = null } = options;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await executeFunc(params);
      } catch (error) {
        const err = error as Error;
        if (onError) {
          const shouldRetry = await onError(err, attempt, params);
          if (!shouldRetry || attempt === maxRetries) {
            throw err;
          }
        } else if (attempt === maxRetries) {
          throw err;
        }

        // Wait before retry
        await new Promise((resolve) =>
          setTimeout(resolve, 1000 * (attempt + 1))
        );
      }
    }

    throw new Error("Recovery middleware exhausted retries without result");
  };
};
