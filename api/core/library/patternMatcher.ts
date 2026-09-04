/**
 * Pattern Matcher - Advanced code pattern detection and matching
 * Inspired by spaCy's pattern matching for code analysis
 */

type PatternRuleValue = CodeToken[keyof CodeToken] | CodeToken[keyof CodeToken][];

type PatternRule = Partial<Record<keyof CodeToken | "OP", PatternRuleValue>>;

type CodeToken = {
  text: string;
  type: string;
  pos: string;
  line: number;
  index: number;
};

type PatternMatch = {
  pattern: string;
  tokens: CodeToken[];
  start: number;
  end: number;
};

export class Pattern {
  name: string;
  rules: PatternRule[];

  constructor(name: string, rules: PatternRule[]) {
    this.name = name;
    this.rules = rules; // Array of matching rules
  }

  match(tokens: CodeToken[]): PatternMatch[] | null {
    // Check if tokens match this pattern
    if (tokens.length < this.rules.length) return null;

    const matches = [];

    for (let i = 0; i <= tokens.length - this.rules.length; i++) {
      let isMatch = true;
      const matchedTokens = [];

      for (let j = 0; j < this.rules.length; j++) {
        const token = tokens[i + j];
        const rule = this.rules[j];

        if (!this.tokenMatchesRule(token, rule)) {
          isMatch = false;
          break;
        }

        matchedTokens.push(token);
      }

      if (isMatch) {
        matches.push({
          pattern: this.name,
          tokens: matchedTokens,
          start: i,
          end: i + this.rules.length,
        });
      }
    }

    return matches.length > 0 ? matches : null;
  }

  tokenMatchesRule(token: CodeToken, rule: PatternRule): boolean {
    // Check if token matches the rule criteria
    for (const [key, value] of Object.entries(rule) as [
      keyof PatternRule,
      PatternRuleValue
    ][]) {
      if (key === "OP") continue; // Optional operator, handle separately

      const tokenValue = token[key as keyof CodeToken];

      if (Array.isArray(value)) {
        if (!value.includes(tokenValue)) return false;
      } else {
        if (tokenValue !== value) return false;
      }
    }

    return true;
  }
}

export class CodeMatcher {
  patterns: Map<string, Pattern>;
  tokenCache: Map<string, CodeToken[]>;

  constructor() {
    this.patterns = new Map();
    this.tokenCache = new Map();
  }

  /**
   * Add a pattern to match
   */
  addPattern(name: string, rules: PatternRule[]) {
    const pattern = new Pattern(name, rules);
    this.patterns.set(name, pattern);
  }

  /**
   * Remove a pattern
   */
  removePattern(name: string) {
    this.patterns.delete(name);
  }

  /**
   * Match patterns in code
   */
  match(code: string, patternNames: string[] | null = null): PatternMatch[] {
    const tokens = this.tokenize(code);
    const allMatches: PatternMatch[] = [];

    const patternsToMatch: Pattern[] = patternNames
      ? patternNames.flatMap((name) => {
          const pattern = this.patterns.get(name);
          return pattern ? [pattern] : [];
        })
      : Array.from(this.patterns.values());

    patternsToMatch.forEach((pattern) => {
      const matches = pattern.match(tokens);
      if (matches) {
        allMatches.push(...matches);
      }
    });

    return allMatches;
  }

  /**
   * Tokenize code into analyzable tokens
   */
  tokenize(code: string): CodeToken[] {
    const cacheKey = code.substring(0, 100); // Cache based on first 100 chars
    const cachedTokens = this.tokenCache.get(cacheKey);
    if (cachedTokens) {
      return cachedTokens;
    }

    const tokens: CodeToken[] = [];
    const lines = code.split("\n");

    lines.forEach((line, lineNum) => {
      // Tokenize each line
      const lineTokens = this.tokenizeLine(line, lineNum);
      tokens.push(...lineTokens);
    });

    this.tokenCache.set(cacheKey, tokens);
    return tokens;
  }

  /**
   * Tokenize a single line
   */
  tokenizeLine(line: string, lineNum: number): CodeToken[] {
    const tokens: CodeToken[] = [];

    // Simple tokenization - split by whitespace and operators
    const regex =
      /(\w+|\[|\]|[{}();,.]|=>|===|==|=|!==|!=|<=|>=|<|>|\+\+|--|\+|-|\*|\/|&&|\|\||!)/g;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(line)) !== null) {
      const token = match[0];
      const type = this.getTokenType(token);

      tokens.push({
        text: token,
        type: type,
        pos: this.getPartOfSpeech(token, type),
        line: lineNum,
        index: match.index,
      });
    }

    return tokens;
  }

  /**
   * Get token type
   */
  getTokenType(token: string) {
    // Keywords
    const keywords = new Set([
      "function",
      "class",
      "const",
      "let",
      "var",
      "if",
      "else",
      "for",
      "while",
      "return",
      "import",
      "export",
      "from",
      "default",
      "async",
      "await",
      "new",
      "this",
      "super",
      "extends",
      "implements",
      "interface",
      "type",
      "enum",
      "public",
      "private",
      "protected",
      "static",
    ]);

    if (keywords.has(token)) return "KEYWORD";
    if (/^[A-Z]/.test(token)) return "CLASS_NAME";
    if (/^\d+$/.test(token)) return "NUMBER";
    if (/^[a-z_]\w*$/.test(token)) return "IDENTIFIER";
    if (/^[{}[\]()]$/.test(token)) return "BRACKET";
    if (/^[;,.]$/.test(token)) return "PUNCTUATION";
    if (
      /^(=>|===|==|=|!==|!=|<=|>=|<|>|\+\+|--|\+|-|\*|\/|&&|\|\||!)$/.test(
        token
      )
    )
      return "OPERATOR";

    return "UNKNOWN";
  }

  /**
   * Get part of speech (simplified for code)
   */
  getPartOfSpeech(token: string, type: string) {
    if (type === "KEYWORD") {
      if (["function", "class", "const", "let", "var"].includes(token)) {
        return "DECL"; // Declaration
      }
      if (["if", "else", "for", "while", "return"].includes(token)) {
        return "CTRL"; // Control flow
      }
    }
    if (type === "IDENTIFIER") return "NOUN";
    if (type === "OPERATOR") return "VERB";

    return type;
  }

  /**
   * Clear token cache
   */
  clearCache() {
    this.tokenCache.clear();
  }
}

// Pre-defined patterns for common code structures
export const CommonPatterns: Record<string, PatternRule[]> = {
  // Function declaration: function name() {}
  FUNCTION_DECLARATION: [
    { type: "KEYWORD", text: "function" },
    { type: "IDENTIFIER" },
    { type: "BRACKET", text: "(" },
  ],

  // Class declaration: class Name
  CLASS_DECLARATION: [
    { type: "KEYWORD", text: "class" },
    { type: "CLASS_NAME" },
  ],

  // Class with inheritance: class Name extends Parent
  CLASS_INHERITANCE: [
    { type: "KEYWORD", text: "class" },
    { type: "CLASS_NAME" },
    { type: "KEYWORD", text: "extends" },
    { type: "CLASS_NAME" },
  ],

  // Variable declaration: const name =
  VARIABLE_DECLARATION: [
    { type: "KEYWORD", text: ["const", "let", "var"] },
    { type: "IDENTIFIER" },
    { type: "OPERATOR", text: "=" },
  ],

  // Import statement: import X from 'Y'
  IMPORT_STATEMENT: [
    { type: "KEYWORD", text: "import" },
    { type: "IDENTIFIER" },
    { type: "KEYWORD", text: "from" },
  ],

  // Method call: object.method()
  METHOD_CALL: [
    { type: "IDENTIFIER" },
    { type: "PUNCTUATION", text: "." },
    { type: "IDENTIFIER" },
    { type: "BRACKET", text: "(" },
  ],

  // Arrow function: () =>
  ARROW_FUNCTION: [
    { type: "BRACKET", text: "(" },
    { type: "BRACKET", text: ")" },
    { type: "OPERATOR", text: "=>" },
  ],

  // Async function: async function
  ASYNC_FUNCTION: [
    { type: "KEYWORD", text: "async" },
    { type: "KEYWORD", text: "function" },
  ],

  // Interface implementation: class X implements Y
  INTERFACE_IMPLEMENTATION: [
    { type: "KEYWORD", text: "class" },
    { type: "CLASS_NAME" },
    { type: "KEYWORD", text: "implements" },
  ],

  // Constructor: constructor()
  CONSTRUCTOR: [
    { type: "IDENTIFIER", text: "constructor" },
    { type: "BRACKET", text: "(" },
  ],
};

// Create a default matcher with common patterns
export function createDefaultMatcher() {
  const matcher = new CodeMatcher();

  Object.entries(CommonPatterns).forEach(([name, rules]) => {
    matcher.addPattern(name, rules);
  });

  return matcher;
}

export default CodeMatcher;
