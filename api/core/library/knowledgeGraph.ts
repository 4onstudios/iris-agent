/**
 * Knowledge Graph System for Token Optimization
 * Implements intelligent context caching and relationship tracking
 */

import { runtimeEventBus, RuntimeEvents } from "./runtimeEventBus";
import { createDefaultMatcher } from "./patternMatcher";
import { redact } from "./safetyMiddleware";

export type KnowledgeNodeType =
  | "file"
  | "function"
  | "class"
  | "import"
  | "context"
  | "method"
  | "interface"
  | "variable";

export type KnowledgeRelationship = {
  nodeId: string;
  type: string;
  metadata: Record<string, unknown>;
  timestamp: number;
  confidence?: number;
};

export type KnowledgeMethod = {
  name: string;
  isAsync: boolean;
};

export type KnowledgeNodeMetadata = Record<string, unknown> & {
  name?: string;
  language?: string;
  path?: string;
  filePath?: string;
  startLine?: number;
  endLine?: number;
  extends?: string | null;
  implements?: string[];
  methods?: KnowledgeMethod[];
  className?: string;
  methodName?: string;
  isAsync?: boolean;
};

type RedactionInfo = {
  count: number;
  types: string[];
};

type KnowledgeComponent = {
  type: KnowledgeNodeType;
  name: string;
  content: string;
  startLine: number;
  endLine?: number;
  dependencies?: string[];
  calls?: string[];
  uses?: string[];
  extends?: string | null;
  implements?: string[];
  methods?: KnowledgeMethod[];
};

type PatternAnalysis = {
  patterns: Record<string, unknown[]>;
  complexity: number;
  structures: string[];
};

export type KnowledgeContext = {
  nodes: KnowledgeNode[];
  tokenCount: number;
  contextText: string;
  retrieval?: {
    mode: "entity" | "question";
    question?: string;
    anchorNodeIds?: string[];
    hops?: number;
    matchedTerms?: string[];
  };
};

type CacheEntry = {
  context: KnowledgeContext;
  tokenCount: number;
  timestamp: number;
  node?: KnowledgeNode;
};

type ContextQuery = {
  type?: string;
  id: string;
  relatedFiles?: string[];
  maxTokens?: number;
};

type QuestionQuery = {
  question: string;
  anchorId?: string;
  relatedFiles?: string[];
  maxTokens?: number;
  maxDepth?: number;
};

type ScoredNode = {
  node: KnowledgeNode;
  score: number;
};

type RankedCandidate = {
  node: KnowledgeNode;
  score: number;
  depth: number;
};

type IndexedFile = {
  path: string;
  name?: string;
  content: string;
  language?: string | null;
};

type GraphStatistics = {
  nodeCount: number;
  cacheSize: number;
  cacheHits: number;
  cacheMisses: number;
  hitRate: string;
  totalTokensSaved: number;
  estimatedCostSaved: string;
};

type ExportGraphNode = {
  id: string;
  type: string;
  label: string;
  size: number;
  accessCount: number;
};

type ExportGraphEdge = {
  source: string;
  target: string;
  type: string;
};

type ExportGraph = {
  nodes: ExportGraphNode[];
  edges: ExportGraphEdge[];
};

/**
 * Knowledge Node - Represents a piece of code context
 */
export class KnowledgeNode {
  id: string;
  type: KnowledgeNodeType;
  content: string;
  originalContent: string | null;
  redacted: boolean;
  redactionInfo: RedactionInfo | null;
  metadata: KnowledgeNodeMetadata;
  relationships: Set<KnowledgeRelationship>;
  accessCount: number;
  lastAccessed: number;
  tokenCount: number;
  embedding: unknown;

  constructor(
    id: string,
    type: KnowledgeNodeType,
    content: string,
    metadata: KnowledgeNodeMetadata = {}
  ) {
    this.id = id;
    this.type = type; // 'file', 'function', 'class', 'import', 'context'

    // 🔒 SECURITY: Redact sensitive info before storing
    const { output: safeContent, redactions } = redact(content);
    this.content = safeContent;
    this.originalContent = null; // Never store original if redacted
    this.redacted = redactions.length > 0;
    this.redactionInfo =
      redactions.length > 0
        ? {
            count: redactions.length,
            types: [...new Set(redactions.map((r) => r.type))],
          }
        : null;

    this.metadata = metadata;
    this.relationships = new Set();
    this.accessCount = 0;
    this.lastAccessed = Date.now();
    this.tokenCount = this.estimateTokens(safeContent);
    this.embedding = null; // For semantic search (future)
  }

  estimateTokens(text: string) {
    // Rough estimation: ~4 chars per token
    return Math.ceil((text || "").length / 4);
  }

  addRelationship(
    nodeId: string,
    relationshipType: string,
    metadata: Record<string, unknown> = {},
    confidence = 1
  ) {
    this.relationships.add({
      nodeId,
      type: relationshipType,
      metadata,
      timestamp: Date.now(),
      confidence,
    });
  }

  hasRelationship(nodeId: string, relationshipType: string) {
    return Array.from(this.relationships).some(
      (rel) => rel.nodeId === nodeId && rel.type === relationshipType
    );
  }

  getRelationships(type: string | null = null) {
    const rels = Array.from(this.relationships);
    return type ? rels.filter((rel) => rel.type === type) : rels;
  }

  access() {
    this.accessCount++;
    this.lastAccessed = Date.now();
  }

  get score() {
    // Recency + frequency scoring
    const recencyScore = 1 / (Date.now() - this.lastAccessed + 1);
    const frequencyScore = this.accessCount;
    return recencyScore * 1000 + frequencyScore;
  }
}

/**
 * Knowledge Graph - Manages code context and relationships
 */
class KnowledgeGraph {
  nodes: Map<string, KnowledgeNode>;
  cache: Map<string, CacheEntry>;
  maxCacheSize: number;
  totalTokensSaved: number;
  cacheHits: number;
  cacheMisses: number;
  patternMatcher: ReturnType<typeof createDefaultMatcher>;

  constructor() {
    this.nodes = new Map();
    this.cache = new Map();
    this.maxCacheSize = 50; // Max nodes in cache
    this.totalTokensSaved = 0;
    this.cacheHits = 0;
    this.cacheMisses = 0;

    // Pattern matcher for advanced code analysis
    this.patternMatcher = createDefaultMatcher();

    // Event subscriptions
    this.initializeEventListeners();
  }

  initializeEventListeners() {
    runtimeEventBus.subscribe(RuntimeEvents.FILE_OPEN, (file) => {
      this.indexFile(file as IndexedFile);
    });

    runtimeEventBus.subscribe(RuntimeEvents.CODE_CHANGE, (data) => {
      this.updateContext(data as { filePath: string; content: string });
    });

    runtimeEventBus.subscribe(RuntimeEvents.CONTEXT_QUERY, (query) => {
      this.queryContext(query as ContextQuery);
    });
  }

  /**
   * Create or update a node
   */
  upsertNode(
    id: string,
    type: KnowledgeNodeType,
    content: string,
    metadata: KnowledgeNodeMetadata = {}
  ) {
    let node = this.nodes.get(id);

    if (node) {
      // Update existing node with redaction
      const { output: safeContent, redactions } = redact(content);
      node.content = safeContent;
      node.metadata = { ...node.metadata, ...metadata };
      node.tokenCount = node.estimateTokens(safeContent);
      node.redacted = redactions.length > 0;
      if (redactions.length > 0) {
        node.redactionInfo = {
          count: redactions.length,
          types: [...new Set(redactions.map((r) => r.type))],
        };

        // Log redaction event
        console.warn("[Knowledge Graph] Redacted sensitive data in node:", {
          nodeId: id,
          type,
          redactionCount: redactions.length,
          types: node.redactionInfo?.types ?? [],
        });
      }
    } else {
      // Create new node (redaction happens in constructor)
      node = new KnowledgeNode(id, type, content, metadata);
      this.nodes.set(id, node);

      if (node.redacted) {
        const redactionInfo = node.redactionInfo;
        console.warn("[Knowledge Graph] Created node with redacted content:", {
          nodeId: id,
          type,
          redactionCount: redactionInfo?.count ?? 0,
          types: redactionInfo?.types ?? [],
        });
      }
    }

    return node;
  }

  /**
   * Index a file and its components
   */
  indexFile(file: IndexedFile) {
    const { path, name, content, language } = file;
    const fileMetadata: KnowledgeNodeMetadata = {
      name,
      path,
    };

    if (typeof language === "string") {
      fileMetadata.language = language;
    }

    // Create file node
    const fileNode = this.upsertNode(path, "file", content, fileMetadata);

    // Parse and index components
    const components = this.parseComponents(content, language ?? undefined);

    components.forEach((comp) => {
      const compId = `${path}:${comp.type}:${comp.name}`;
      const compNode = this.upsertNode(compId, comp.type, comp.content, {
        filePath: path,
        startLine: comp.startLine,
        endLine: comp.endLine,
        name: comp.name,
        extends: comp.extends,
        implements: comp.implements,
        methods: comp.methods,
      });

      // Create basic relationships
      fileNode.addRelationship(compId, "contains");
      compNode.addRelationship(path, "belongsTo");

      // Track imports/dependencies
      if (comp.type === "import") {
        comp.dependencies?.forEach((dep) => {
          const resolvedImport = this.resolveImportPath(path, dep);

          compNode.addRelationship(
            resolvedImport || dep,
            "imports",
            {
              sourceFile: path,
              importPath: dep,
              resolved: Boolean(resolvedImport),
            },
            resolvedImport ? 0.95 : 0.4
          );

          fileNode.addRelationship(
            resolvedImport || dep,
            "imports",
            {
              sourceFile: path,
              importPath: dep,
              resolved: Boolean(resolvedImport),
            },
            resolvedImport ? 0.95 : 0.4
          );
        });
      }
    });

    // Build semantic relationships (calls, extends, implements, etc.)
    this.buildSemanticRelationships(path, components);

    runtimeEventBus.emit(RuntimeEvents.CONTEXT_UPDATE, {
      type: "file_indexed",
      path,
      nodeCount: components.length + 1,
    });
  }

  normalizePathLike(input: string) {
    const rawParts = input.replace(/\\/g, "/").split("/");
    const parts: string[] = [];

    rawParts.forEach((part) => {
      if (!part || part === ".") {
        return;
      }

      if (part === "..") {
        parts.pop();
        return;
      }

      parts.push(part);
    });

    const hasLeadingSlash = input.startsWith("/");
    return `${hasLeadingSlash ? "/" : ""}${parts.join("/")}`;
  }

  resolveImportPath(sourceFilePath: string, importPath: string) {
    if (!importPath || !importPath.startsWith(".")) {
      return null;
    }

    const sourceDir = sourceFilePath.includes("/")
      ? sourceFilePath.slice(0, sourceFilePath.lastIndexOf("/"))
      : "";
    const base = this.normalizePathLike(`${sourceDir}/${importPath}`);

    const candidates = [
      base,
      `${base}.ts`,
      `${base}.tsx`,
      `${base}.js`,
      `${base}.jsx`,
      `${base}/index.ts`,
      `${base}/index.tsx`,
      `${base}/index.js`,
      `${base}/index.jsx`,
    ];

    for (const candidate of candidates) {
      if (this.nodes.has(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  /**
   * Parse code components (functions, classes, imports)
   */
  parseComponents(content: string, language?: string | null) {
    const components: KnowledgeComponent[] = [];

    if (language === "javascript" || language === "jsx") {
      // Parse imports
      const importRegex = /import\s+.*?\s+from\s+['"](.+?)['"]/g;
      let match: RegExpExecArray | null;
      while ((match = importRegex.exec(content)) !== null) {
        components.push({
          type: "import",
          name: match[1],
          content: match[0],
          dependencies: [match[1]],
          startLine: content.substring(0, match.index).split("\n").length,
        });
      }

      // Parse functions
      const functionRegex =
        /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\([^)]*\)\s*\{/g;
      while ((match = functionRegex.exec(content)) !== null) {
        const startLine = content.substring(0, match.index).split("\n").length;
        const funcContent = this.extractBlock(content, match.index);
        components.push({
          type: "function",
          name: match[1],
          content: funcContent,
          startLine,
          // Enhanced: Extract function calls
          calls: this.extractFunctionCalls(funcContent),
          // Enhanced: Extract variable usage
          uses: this.extractVariableUsage(funcContent),
        });
      }

      // Parse arrow functions
      const arrowRegex = /const\s+(\w+)\s*=\s*\([^)]*\)\s*=>/g;
      while ((match = arrowRegex.exec(content)) !== null) {
        const startLine = content.substring(0, match.index).split("\n").length;
        const funcContent = this.extractStatement(content, match.index);
        components.push({
          type: "function",
          name: match[1],
          content: funcContent,
          startLine,
          // Enhanced: Extract function calls
          calls: this.extractFunctionCalls(funcContent),
          // Enhanced: Extract variable usage
          uses: this.extractVariableUsage(funcContent),
        });
      }

      // Parse classes
      const classRegex =
        /class\s+(\w+)\s*(?:extends\s+(\w+))?\s*(?:implements\s+([\w,\s]+))?\s*\{/g;
      while ((match = classRegex.exec(content)) !== null) {
        const startLine = content.substring(0, match.index).split("\n").length;
        const classContent = this.extractBlock(content, match.index);
        components.push({
          type: "class",
          name: match[1],
          content: classContent,
          startLine,
          // Enhanced: Track inheritance
          extends: match[2] || null,
          // Enhanced: Track interfaces
          implements: match[3] ? match[3].split(",").map((i) => i.trim()) : [],
          // Enhanced: Extract methods
          methods: this.extractClassMethods(classContent),
        });
      }
    }

    return components;
  }

  /**
   * Enhanced: Extract function calls from code
   */
  extractFunctionCalls(code: string) {
    const calls = new Set<string>();

    // Match function calls: functionName(...) or object.method(...)
    const callPatterns = [
      /(\w+)\s*\(/g, // Simple calls: foo()
      /(\w+)\.(\w+)\s*\(/g, // Method calls: obj.method()
      /(\w+)\.(\w+)\.(\w+)\s*\(/g, // Chained calls: obj.prop.method()
    ];

    callPatterns.forEach((pattern) => {
      let match;
      const regex = new RegExp(pattern);
      while ((match = regex.exec(code)) !== null) {
        const callName = match[0].replace(/\s*\($/, "");
        if (!this.isKeyword(callName)) {
          calls.add(callName);
        }
      }
    });

    return Array.from(calls);
  }

  /**
   * Enhanced: Extract variable usage from code
   */
  extractVariableUsage(code: string) {
    const variables = new Set<string>();

    // Match variable declarations
    const varPatterns = [/(?:const|let|var)\s+(\w+)/g, /(\w+)\s*=\s*/g];

    varPatterns.forEach((pattern) => {
      let match;
      while ((match = pattern.exec(code)) !== null) {
        if (!this.isKeyword(match[1])) {
          variables.add(match[1]);
        }
      }
    });

    return Array.from(variables);
  }

  /**
   * Enhanced: Extract methods from class
   */
  extractClassMethods(classCode: string) {
    const methods: KnowledgeMethod[] = [];

    // Match method definitions in class
    const methodRegex = /(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{/g;
    let match;

    while ((match = methodRegex.exec(classCode)) !== null) {
      const methodName = match[1];
      if (methodName !== "constructor" && !this.isKeyword(methodName)) {
        methods.push({
          name: methodName,
          isAsync: match[0].includes("async"),
        });
      }
    }

    return methods;
  }

  /**
   * Check if a word is a JavaScript keyword
   */
  isKeyword(word: string) {
    const keywords = new Set([
      "if",
      "else",
      "for",
      "while",
      "do",
      "switch",
      "case",
      "break",
      "continue",
      "return",
      "function",
      "class",
      "const",
      "let",
      "var",
      "new",
      "this",
      "super",
      "import",
      "export",
      "from",
      "default",
      "async",
      "await",
      "try",
      "catch",
      "finally",
      "throw",
    ]);
    return keywords.has(word);
  }

  /**
   * Enhanced: Build semantic relationships between components
   */
  buildSemanticRelationships(path: string, components: KnowledgeComponent[]) {
    const fileNode = this.nodes.get(path);
    if (!fileNode) return;

    components.forEach((comp) => {
      const compId = `${path}:${comp.type}:${comp.name}`;
      const compNode = this.nodes.get(compId);
      if (!compNode) return;

      // Track function calls
      if (comp.calls) {
        comp.calls.forEach((calledFunc) => {
          // Find the called function node
          const calledNodeId = this.findNodeByName(calledFunc, "function");
          if (calledNodeId) {
            compNode.addRelationship(calledNodeId, "calls", {
              functionName: calledFunc,
            });
          }
        });
      }

      // Track class inheritance
      if (comp.extends) {
        const parentClassId = this.findNodeByName(comp.extends, "class");
        if (parentClassId) {
          compNode.addRelationship(parentClassId, "extends", {
            parentClass: comp.extends,
          });
        }
      }

      // Track interface implementation
      if (comp.implements && comp.implements.length > 0) {
        comp.implements.forEach((interfaceName) => {
          const interfaceId = this.findNodeByName(interfaceName, "interface");
          if (interfaceId) {
            compNode.addRelationship(interfaceId, "implements", {
              interface: interfaceName,
            });
          }
        });
      }

      // Track variable dependencies
      if (comp.uses) {
        comp.uses.forEach((varName) => {
          // Check if variable is defined elsewhere
          const varNodeId = this.findNodeByName(varName, "variable");
          if (varNodeId) {
            compNode.addRelationship(varNodeId, "uses", {
              variable: varName,
            });
          }
        });
      }

      // Track method definitions in classes
      if (comp.methods && comp.methods.length > 0) {
        comp.methods.forEach((method) => {
          const methodId = `${compId}:method:${method.name}`;
          const methodNode = this.upsertNode(methodId, "method", "", {
            className: comp.name,
            methodName: method.name,
            isAsync: method.isAsync,
          });

          compNode.addRelationship(methodId, "defines", {
            methodName: method.name,
          });
          methodNode.addRelationship(compId, "definedBy", {
            className: comp.name,
          });
        });
      }
    });
  }

  /**
   * Find a node by name and type
   */
  findNodeByName(name: string, type: KnowledgeNodeType) {
    for (const [nodeId, node] of this.nodes.entries()) {
      if (
        node.type === type &&
        (node.metadata.name === name || nodeId.endsWith(`:${type}:${name}`))
      ) {
        return nodeId;
      }
    }
    return null;
  }

  /**
   * Extract code block from position
   */
  extractBlock(content: string, startIndex: number) {
    let depth = 0;
    let started = false;
    let endIndex = startIndex;

    for (let i = startIndex; i < content.length; i++) {
      if (content[i] === "{") {
        depth++;
        started = true;
      } else if (content[i] === "}") {
        depth--;
        if (started && depth === 0) {
          endIndex = i + 1;
          break;
        }
      }
    }

    return content.substring(startIndex, endIndex);
  }

  /**
   * Extract statement (for arrow functions, etc.)
   */
  extractStatement(content: string, startIndex: number) {
    const endIndex = content.indexOf(";", startIndex);
    return content.substring(startIndex, endIndex + 1);
  }

  /**
   * Enhanced: Use pattern matching to analyze code structure
   */
  analyzeWithPatterns(code: string) {
    const matches = this.patternMatcher.match(code);

    const analysis = {
      patterns: {} as Record<string, unknown[]>,
      complexity: 0,
      structures: [] as string[],
    };

    matches.forEach((match) => {
      if (!analysis.patterns[match.pattern]) {
        analysis.patterns[match.pattern] = [];
      }
      analysis.patterns[match.pattern].push(match);
      analysis.structures.push(match.pattern);
    });

    // Calculate complexity based on patterns found
    analysis.complexity = this.calculateComplexity(analysis.patterns);

    return analysis;
  }

  /**
   * Calculate code complexity score
   */
  calculateComplexity(patterns: PatternAnalysis["patterns"]) {
    let score = 0;

    // Weight different patterns
    const weights = {
      FUNCTION_DECLARATION: 2,
      CLASS_DECLARATION: 3,
      CLASS_INHERITANCE: 4,
      ASYNC_FUNCTION: 3,
      METHOD_CALL: 1,
      ARROW_FUNCTION: 2,
    };

    Object.entries(patterns).forEach(([patternName, matches]) => {
      const weight = weights[patternName as keyof typeof weights] || 1;
      score += matches.length * weight;
    });

    return score;
  }

  /**
   * Query context with caching
   */
  queryContext(query: ContextQuery) {
    const { type, id, relatedFiles, maxTokens = 4000 } = query;

    if (type === "question") {
      return this.queryByQuestion({
        question: id,
        relatedFiles,
        maxTokens,
      });
    }

    const cacheKey = JSON.stringify(query);

    // Check cache
    if (this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey);
      if (!cached) {
        return this.buildContext(type, id, relatedFiles, maxTokens);
      }

      cached.node?.access();

      this.cacheHits++;
      this.totalTokensSaved += cached.tokenCount;

      runtimeEventBus.emit(RuntimeEvents.CACHE_HIT, {
        query,
        tokensSaved: cached.tokenCount,
        totalSaved: this.totalTokensSaved,
      });

      return cached.context;
    }

    this.cacheMisses++;

    // Build context
    const context = this.buildContext(type, id, relatedFiles, maxTokens);

    // Cache result
    this.updateCache(cacheKey, context);

    runtimeEventBus.emit(RuntimeEvents.CACHE_MISS, { query });
    runtimeEventBus.emit(RuntimeEvents.TOKEN_USAGE, {
      tokens: context.tokenCount,
      cached: false,
    });

    return context;
  }

  /**
   * Build context from knowledge graph
   */
  buildContext(
    type: string | undefined,
    id: string,
    relatedFiles: string[] = [],
    maxTokens = 4000
  ): KnowledgeContext {
    const relevantNodes: KnowledgeNode[] = [];
    let tokenCount = 0;

    void type;

    // Get primary node
    const primaryNode = this.nodes.get(id);
    if (primaryNode) {
      relevantNodes.push(primaryNode);
      tokenCount += primaryNode.tokenCount;
      primaryNode.access();
    }

    // Get related nodes by relationships
    if (primaryNode) {
      primaryNode.relationships.forEach(({ nodeId }) => {
        const relNode = this.nodes.get(nodeId);
        if (relNode && tokenCount + relNode.tokenCount <= maxTokens) {
          relevantNodes.push(relNode);
          tokenCount += relNode.tokenCount;
          relNode.access();
        }
      });
    }

    // Get nodes from related files
    relatedFiles.forEach((filePath) => {
      const fileNode = this.nodes.get(filePath);
      if (fileNode && tokenCount + fileNode.tokenCount <= maxTokens) {
        relevantNodes.push(fileNode);
        tokenCount += fileNode.tokenCount;
        fileNode.access();
      }
    });

    // Sort by relevance score
    relevantNodes.sort((a, b) => b.score - a.score);

    return {
      nodes: relevantNodes,
      tokenCount,
      contextText: relevantNodes.map((n) => n.content).join("\n\n"),
      retrieval: {
        mode: "entity",
      },
    };
  }

  extractQuestionTerms(question: string) {
    const stopWords = new Set([
      "a",
      "an",
      "and",
      "are",
      "as",
      "at",
      "be",
      "by",
      "for",
      "from",
      "how",
      "i",
      "in",
      "is",
      "it",
      "of",
      "on",
      "or",
      "that",
      "the",
      "this",
      "to",
      "what",
      "where",
      "which",
      "who",
      "why",
      "with",
      "you",
    ]);

    const normalized = (question || "").toLowerCase();
    const rawTerms = normalized.match(/[a-z0-9_./-]+/g) || [];

    return Array.from(
      new Set(rawTerms.filter((term) => term.length > 1 && !stopWords.has(term)))
    );
  }

  scoreNodeForQuestion(
    node: KnowledgeNode,
    terms: string[],
    relatedFiles: string[]
  ) {
    if (terms.length === 0) {
      return 0;
    }

    const metaName = String(node.metadata.name || "").toLowerCase();
    const nodeId = node.id.toLowerCase();
    const pathHint = String(
      node.metadata.filePath || node.metadata.path || ""
    ).toLowerCase();

    let score = 0;

    terms.forEach((term) => {
      if (metaName === term) {
        score += 8;
      } else if (metaName.includes(term)) {
        score += 4;
      }

      if (nodeId.includes(term)) {
        score += 2;
      }

      if (pathHint.includes(term)) {
        score += 2;
      }

      if (node.content.toLowerCase().includes(term)) {
        score += 1;
      }
    });

    const typeBoost: Record<KnowledgeNodeType, number> = {
      file: 0.9,
      function: 1.3,
      class: 1.2,
      import: 0.7,
      context: 0.8,
      method: 1.1,
      interface: 1,
      variable: 0.9,
    };

    score *= typeBoost[node.type] || 1;

    if (
      relatedFiles.length > 0 &&
      relatedFiles.some((filePath) => node.id === filePath || pathHint.includes(filePath))
    ) {
      score += 3;
    }

    return score;
  }

  findAnchorNodes(question: string, relatedFiles: string[] = [], limit = 8) {
    const terms = this.extractQuestionTerms(question);
    const scored: ScoredNode[] = [];

    this.nodes.forEach((node) => {
      const score = this.scoreNodeForQuestion(node, terms, relatedFiles);
      if (score > 0) {
        scored.push({ node, score });
      }
    });

    scored.sort((a, b) => b.score - a.score);
    return {
      terms,
      anchors: scored.slice(0, limit),
    };
  }

  getRelationshipWeight(type: string) {
    const weights: Record<string, number> = {
      contains: 1.2,
      belongsTo: 1,
      imports: 1.1,
      calls: 1.3,
      extends: 1.2,
      implements: 1.1,
      uses: 0.9,
      defines: 1.1,
      definedBy: 1,
    };

    return weights[type] || 0.8;
  }

  collectNeighbors(nodeId: string) {
    const neighbors: Array<{ nodeId: string; edgeWeight: number }> = [];
    const currentNode = this.nodes.get(nodeId);

    if (currentNode) {
      currentNode.relationships.forEach((rel) => {
        neighbors.push({
          nodeId: rel.nodeId,
          edgeWeight: this.getRelationshipWeight(rel.type) * (rel.confidence || 1),
        });
      });
    }

    this.nodes.forEach((node) => {
      node.relationships.forEach((rel) => {
        if (rel.nodeId === nodeId) {
          neighbors.push({
            nodeId: node.id,
            edgeWeight: this.getRelationshipWeight(rel.type) * (rel.confidence || 1),
          });
        }
      });
    });

    return neighbors;
  }

  queryByQuestion(query: QuestionQuery): KnowledgeContext {
    const {
      question,
      anchorId,
      relatedFiles = [],
      maxTokens = 4000,
      maxDepth = 2,
    } = query;

    const { terms, anchors } = this.findAnchorNodes(question, relatedFiles);
    const candidates = new Map<string, RankedCandidate>();
    const queue: Array<{ nodeId: string; score: number; depth: number }> = [];
    const visited = new Set<string>();

    if (anchorId && this.nodes.has(anchorId)) {
      queue.push({ nodeId: anchorId, score: 10, depth: 0 });
    }

    anchors.forEach(({ node, score }) => {
      queue.push({ nodeId: node.id, score, depth: 0 });
    });

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) {
        continue;
      }

      const dedupeKey = `${current.nodeId}:${current.depth}`;
      if (visited.has(dedupeKey)) {
        continue;
      }
      visited.add(dedupeKey);

      const node = this.nodes.get(current.nodeId);
      if (!node) {
        continue;
      }

      const pathScore = current.score / (current.depth + 1);
      const recencyBonus = node.accessCount > 0 ? 0.2 : 0;
      const totalScore = pathScore + recencyBonus;
      const existing = candidates.get(node.id);

      if (!existing || totalScore > existing.score) {
        candidates.set(node.id, {
          node,
          score: totalScore,
          depth: current.depth,
        });
      }

      if (current.depth >= maxDepth) {
        continue;
      }

      this.collectNeighbors(node.id).forEach((neighbor) => {
        if (!this.nodes.has(neighbor.nodeId)) {
          return;
        }

        queue.push({
          nodeId: neighbor.nodeId,
          score: current.score * neighbor.edgeWeight,
          depth: current.depth + 1,
        });
      });
    }

    const ranked = Array.from(candidates.values()).sort((a, b) => b.score - a.score);

    const selectedNodes: KnowledgeNode[] = [];
    let tokenCount = 0;

    ranked.forEach(({ node }) => {
      if (tokenCount + node.tokenCount > maxTokens) {
        return;
      }

      selectedNodes.push(node);
      tokenCount += node.tokenCount;
      node.access();
    });

    return {
      nodes: selectedNodes,
      tokenCount,
      contextText: selectedNodes.map((node) => node.content).join("\n\n"),
      retrieval: {
        mode: "question",
        question,
        anchorNodeIds: anchors.map(({ node }) => node.id).slice(0, 5),
        hops: maxDepth,
        matchedTerms: terms,
      },
    };
  }

  /**
   * Update cache with LRU eviction
   */
  updateCache(key: string, context: KnowledgeContext) {
    if (this.cache.size >= this.maxCacheSize) {
      // Evict least recently used
      let lruKey: string | null = null;
      let lruScore = Infinity;

      this.cache.forEach((value, k) => {
        const nodeScore = value.node?.score ?? Infinity;
        if (nodeScore < lruScore) {
          lruScore = nodeScore;
          lruKey = k;
        }
      });

      if (lruKey) {
        this.cache.delete(lruKey);
      }
    }

    this.cache.set(key, {
      context,
      tokenCount: context.tokenCount,
      timestamp: Date.now(),
      node: context.nodes[0],
    });
  }

  /**
   * Update context when code changes
   */
  updateContext(data: { filePath: string; content: string }) {
    const { filePath, content } = data;

    // Re-index the file
    this.indexFile({
      path: filePath,
      name: filePath.split("/").pop(),
      content,
      language: this.detectLanguage(filePath),
    });

    // Invalidate related cache entries
    this.invalidateCache(filePath);
  }

  /**
   * Invalidate cache entries related to a file
   */
  invalidateCache(filePath: string) {
    const keysToDelete: string[] = [];

    this.cache.forEach((value, key) => {
      if (key.includes(filePath)) {
        keysToDelete.push(key);
      }
    });

    keysToDelete.forEach((key) => this.cache.delete(key));
  }

  /**
   * Detect language from file extension
   */
  detectLanguage(filePath: string) {
    const ext = filePath.split(".").pop()?.toLowerCase();
    const langMap: Record<string, string> = {
      js: "javascript",
      jsx: "jsx",
      ts: "typescript",
      tsx: "tsx",
      py: "python",
      java: "java",
      go: "go",
    };
    if (!ext) {
      return "text";
    }
    return langMap[ext] || "text";
  }

  /**
    * Get statistics for telemetry
   */
  getStatistics(): GraphStatistics {
    const totalRequests = this.cacheHits + this.cacheMisses;
    const hitRate = totalRequests > 0 ? this.cacheHits / totalRequests : 0;

    return {
      nodeCount: this.nodes.size,
      cacheSize: this.cache.size,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      hitRate: (hitRate * 100).toFixed(2) + "%",
      totalTokensSaved: this.totalTokensSaved,
      estimatedCostSaved: (this.totalTokensSaved * 0.00002).toFixed(4), // $0.00002 per token
    };
  }

  /**
   * Export graph for visualization
   */
  exportGraph(): ExportGraph {
    const nodes: ExportGraphNode[] = [];
    const edges: ExportGraphEdge[] = [];

    this.nodes.forEach((node) => {
      nodes.push({
        id: node.id,
        type: node.type,
        label: node.metadata.name || node.id,
        size: node.tokenCount,
        accessCount: node.accessCount,
      });

      node.relationships.forEach(({ nodeId, type }) => {
        edges.push({
          source: node.id,
          target: nodeId,
          type,
        });
      });
    });

    return { nodes, edges };
  }

  /**
   * Clear all data
   */
  clear() {
    this.nodes.clear();
    this.cache.clear();
    this.totalTokensSaved = 0;
    this.cacheHits = 0;
    this.cacheMisses = 0;
  }
}

// Singleton instance
export const knowledgeGraph = new KnowledgeGraph();

export default KnowledgeGraph;
