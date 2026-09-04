/**
 * Backend-local agent utilities.
 *
 * Keep this file under `api/` so the backend can be bundled standalone
 * without importing UI-layer source modules.
 */

/**
 * Truncate environment response to prevent context window overflow.
 * Keeps beginning and end of output for context.
 */
export const truncateEnvironmentResponse = (
  response: string,
  maxChars = 12000
): string => {
  if (!response || typeof response !== "string") {
    return response;
  }

  if (response.length <= maxChars) {
    return response;
  }

  // Keep 80% from beginning, 20% from end.
  const keepChars = Math.floor(maxChars * 0.8);
  const tailChars = maxChars - keepChars;
  const truncatedCount = response.length - maxChars;

  return `${response.slice(
    0,
    keepChars
  )}\n\n... [TRUNCATED ${truncatedCount} characters to prevent context overflow] ...\n\n${response.slice(
    -tailChars
  )}`;
};
