/**
 * Escape a string so it can be used as a literal in a JavaScript RegExp.
 */
export const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
