import { z } from "zod";
import {
  knowledgeGraph,
  type KnowledgeNode,
  type KnowledgeRelationship,
} from "../../library/knowledgeGraph";

type QueryType =
  | "summary"
  | "relationships"
  | "components"
  | "related-files"
  | "stats"
  | "question";

type QueryKnowledgeGraphParams = {
  filePath?: string;
  queryType?: QueryType;
  question?: string;
  maxDepth?: number;
  maxTokens?: number;
};

type ComponentSummary = {
  type: string;
  name: string;
  line: number | undefined;
  tokenCount: number;
};

type RelationshipInfo = {
  nodeId: string;
  type: string;
  name: string;
  metadata?: Record<string, unknown>;
};

type FileSummary = {
  fileName: unknown;
  language: unknown;
  tokenCount: number;
  accessCount: number;
  lastAccessed: string;
  componentCount: number;
  components: ComponentSummary[];
  relationshipCount: number;
};

type RelationshipSummary = {
  imports: RelationshipInfo[];
  exports: RelationshipInfo[];
  calls: RelationshipInfo[];
  usedBy: Array<{
    nodeId: string;
    type: string;
    name: string;
  }>;
  contains: RelationshipInfo[];
};

type ComponentGroups = {
  functions: Array<Record<string, unknown>>;
  classes: Array<Record<string, unknown>>;
  imports: Array<Record<string, unknown>>;
  methods: Array<Record<string, unknown>>;
  other: Array<Record<string, unknown>>;
};

type RelatedFilesSummary = {
  imports: string[];
  importedBy: string[];
  allDependencies: string[];
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

type QuestionSummary = {
  question: string;
  matchedTerms: string[];
  anchorNodes: Array<{
    id: string;
    type: string;
    name: unknown;
  }>;
  nodeCount: number;
  tokenCount: number;
  contextPreview: string;
};

type QueryKnowledgeGraphData =
  | FileSummary
  | RelationshipSummary
  | ComponentGroups
  | RelatedFilesSummary
  | GraphStatistics
  | QuestionSummary;

type QueryKnowledgeGraphResult =
  | {
      success: true;
      filePath: string;
      queryType: QueryType;
      data: QueryKnowledgeGraphData;
    }
  | {
      success: false;
      error: string;
    };

const getNodeDisplayName = (id: string, name?: string): string =>
  name ?? id.split(":").pop() ?? id;

/**
 * Query the knowledge graph for code insights
 * @param {Object} params
 * @param {string} params.filePath - The file path to query
 * @param {string} [params.queryType] - Type of query: 'summary', 'relationships', 'components', 'related-files'
 * @returns {Promise<Object>} Query results from knowledge graph
 */
export async function queryKnowledgeGraph({
  filePath,
  queryType = "summary",
  question,
  maxDepth = 2,
  maxTokens = 4000,
}: QueryKnowledgeGraphParams): Promise<QueryKnowledgeGraphResult> {
  try {
    if (queryType === "stats") {
      return {
        success: true,
        filePath: "<graph>",
        queryType,
        data: knowledgeGraph.getStatistics(),
      };
    }

    if (queryType === "question") {
      if (!question) {
        return {
          success: false,
          error: "Question is required when queryType is 'question'",
        };
      }

      const context = knowledgeGraph.queryByQuestion({
        question,
        anchorId: filePath,
        maxDepth,
        maxTokens,
      });

      const anchorNodeIds = context.retrieval?.anchorNodeIds || [];
      const anchorNodes = anchorNodeIds
        .map((id) => knowledgeGraph.nodes.get(id))
        .filter((node): node is KnowledgeNode => Boolean(node))
        .map((node) => ({
          id: node.id,
          type: node.type,
            name: getNodeDisplayName(node.id, node.metadata.name),
        }));

      return {
        success: true,
        filePath: filePath || "<question>",
        queryType,
        data: {
          question,
          matchedTerms: context.retrieval?.matchedTerms || [],
          anchorNodes,
          nodeCount: context.nodes.length,
          tokenCount: context.tokenCount,
          contextPreview: context.contextText.slice(0, 2000),
        },
      };
    }

    if (!filePath) {
      return {
        success: false,
        error: "File path is required for this query type",
      };
    }

    const node = knowledgeGraph.nodes.get(filePath);

    if (!node) {
      return {
        success: false,
        error: `File not found in knowledge graph: ${filePath}. Make sure to read the file first.`,
      };
    }

    let result: QueryKnowledgeGraphData;

    switch (queryType) {
      case "summary":
        result = getFileSummary(filePath, node);
        break;

      case "relationships":
        result = getRelationships(filePath, node);
        break;

      case "components":
        result = getComponents(filePath);
        break;

      case "related-files":
        result = getRelatedFiles(filePath, node);
        break;

      default:
        result = getFileSummary(filePath, node);
    }

    return {
      success: true,
      filePath,
      queryType,
      data: result,
    };
  } catch (error) {
    const err = error as Error;
    return {
      success: false,
      error: err.message,
    };
  }
}

/**
 * Get file summary with basic info
 */
function getFileSummary(filePath: string, node: KnowledgeNode): FileSummary {
  const components: ComponentSummary[] = [];
  knowledgeGraph.nodes.forEach((n) => {
    if (n.metadata.filePath === filePath && n.id !== filePath) {
      components.push({
        type: n.type,
        name: String(getNodeDisplayName(n.id, n.metadata.name)),
        line: n.metadata.startLine,
        tokenCount: n.tokenCount,
      });
    }
  });

  return {
    fileName: node.metadata.name,
    language: node.metadata.language,
    tokenCount: node.tokenCount,
    accessCount: node.accessCount,
    lastAccessed: new Date(node.lastAccessed).toLocaleString(),
    componentCount: components.length,
    components,
    relationshipCount: node.relationships.size,
  };
}

/**
 * Get all relationships for a file
 */
function getRelationships(
  filePath: string,
  node: KnowledgeNode
): RelationshipSummary {
  const relationships: RelationshipSummary = {
    imports: [],
    exports: [],
    calls: [],
    usedBy: [],
    contains: [],
  };

  // Direct relationships
  node.relationships.forEach(({ nodeId, type, metadata }: KnowledgeRelationship) => {
    const relNode = knowledgeGraph.nodes.get(nodeId);
    const relInfo: RelationshipInfo = {
      nodeId,
      type,
      name: String(getNodeDisplayName(nodeId, relNode?.metadata?.name)),
      metadata,
    };

    if (type === "imports") {
      relationships.imports.push(relInfo);
    } else if (type === "contains") {
      relationships.contains.push(relInfo);
    } else if (type === "calls") {
      relationships.calls.push(relInfo);
    }
  });

  // Reverse relationships (files that import this)
  knowledgeGraph.nodes.forEach((n) => {
    n.relationships.forEach(({ nodeId, type }) => {
      if (nodeId === filePath) {
        relationships.usedBy.push({
          nodeId: n.id,
          type,
          name: String(getNodeDisplayName(n.id, n.metadata.name)),
        });
      }
    });
  });

  return relationships;
}

/**
 * Get all components in a file
 */
function getComponents(filePath: string): ComponentGroups {
  const components: ComponentGroups = {
    functions: [],
    classes: [],
    imports: [],
    methods: [],
    other: [],
  };

  knowledgeGraph.nodes.forEach((node) => {
    if (node.metadata.filePath === filePath && node.id !== filePath) {
      const component = {
        name: getNodeDisplayName(node.id, node.metadata.name),
        type: node.type,
        line: node.metadata.startLine,
        tokenCount: node.tokenCount,
        metadata: node.metadata,
        relationships: Array.from(node.relationships).map((rel) => ({
          type: rel.type,
          target: rel.nodeId.split(":").pop() || rel.nodeId,
        })),
      };

      switch (node.type) {
        case "function":
          components.functions.push(component);
          break;
        case "class":
          components.classes.push(component);
          break;
        case "import":
          components.imports.push(component);
          break;
        case "method":
          components.methods.push(component);
          break;
        default:
          components.other.push(component);
      }
    }
  });

  return components;
}

/**
 * Get files related to this file
 */
function getRelatedFiles(
  filePath: string,
  node: KnowledgeNode
): RelatedFilesSummary {
  const related = {
    imports: [] as string[],
    importedBy: [] as string[],
    dependencies: new Set<string>(),
  };

  // Files this file imports
  node.relationships.forEach(({ nodeId, type }) => {
    if (type === "imports") {
      const importNode = knowledgeGraph.nodes.get(nodeId);
      const importedPath = importNode
        ? importNode.type === "file"
          ? importNode.id
          : (importNode.metadata.filePath as string | undefined)
        : undefined;

      if (importedPath) {
        related.imports.push(importedPath);
        related.dependencies.add(importedPath);
      }
    }
  });

  // Files that import this file
  knowledgeGraph.nodes.forEach((n) => {
    if (n.type === "file" && n.id !== filePath) {
      n.relationships.forEach(({ nodeId }) => {
        // Check if this node imports anything from our file
        const targetNode = knowledgeGraph.nodes.get(nodeId);
        const targetFilePath = targetNode
          ? targetNode.type === "file"
            ? targetNode.id
            : (targetNode.metadata.filePath as string | undefined)
          : undefined;

        if (targetFilePath === filePath) {
          related.importedBy.push(n.id);
          related.dependencies.add(n.id);
        }
      });
    }
  });

  return {
    imports: related.imports,
    importedBy: related.importedBy,
    allDependencies: Array.from(related.dependencies),
  };
}

/**
 * Tool metadata for agent system
 */
export const queryKnowledgeGraphTool = {
  description:
    "Query the knowledge graph for code insights, relationships, and component analysis. The file must be read first before querying.",
  parameters: z.object({
    filePath: z
      .string()
      .optional()
      .describe("The path to the file to query in the knowledge graph"),
    queryType: z
      .enum([
        "summary",
        "relationships",
        "components",
        "related-files",
        "stats",
        "question",
      ])
      .default("summary")
      .describe(
        "Type of query: 'summary' (basic file info), 'relationships' (imports/exports/calls), 'components' (functions/classes), 'related-files' (dependencies), 'stats' (graph statistics), 'question' (question-aware multi-hop retrieval)"
      ),
    question: z
      .string()
      .optional()
      .describe(
        "Natural language question to resolve against graph entities and relationships. Required when queryType is 'question'."
      ),
    maxDepth: z
      .number()
      .int()
      .min(1)
      .max(4)
      .default(2)
      .describe("Maximum graph traversal depth for question queries"),
    maxTokens: z
      .number()
      .int()
      .min(200)
      .max(12000)
      .default(4000)
      .describe("Token budget for the assembled context"),
  }),
  execute: queryKnowledgeGraph,
};

export default queryKnowledgeGraphTool;
