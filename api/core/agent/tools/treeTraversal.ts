/**
 * Tree Traversal Utilities for Directory Operations
 * Based on standard tree traversal algorithms
 */

export type TraversableNode<T extends TraversableNode<T> = TraversableNode<any>> = {
  children?: T[];
};

export type TraversalType = "bfs" | "pre" | "post";

/**
 * Generator-based Pre-Order traversal (DFS)
 * Useful for processing directories before their contents
 * Order: current -> left -> right (parent -> children)
 */
export function* walkPreOrder<T extends TraversableNode<T>>(
  node: T | null | undefined,
): Generator<T, void, undefined> {
  if (!node) return;

  const stack: T[] = [node];
  while (stack.length) {
    const item = stack.pop();
    if (!item) {
      continue;
    }

    yield item;

    // Push children in reverse order (right first) so left is processed first
    if (item.children) {
      for (let i = item.children.length - 1; i >= 0; i--) {
        stack.push(item.children[i]);
      }
    }
  }
}

/**
 * Generator-based Post-Order traversal (DFS)
 * Useful for processing directory contents before the directory itself
 * Order: left -> right -> current (children -> parent)
 * Good for operations like delete (delete files before directory)
 */
export function* walkPostOrder<T extends TraversableNode<T>>(
  node: T | null | undefined,
): Generator<T, void, undefined> {
  if (!node) return;

  const tempStack: T[] = [node];
  const resultStack: T[] = [];

  while (tempStack.length) {
    const item = tempStack.pop();
    if (!item) {
      continue;
    }

    resultStack.push(item);

    // Push children in normal order
    if (item.children) {
      for (const child of item.children) {
        tempStack.push(child);
      }
    }
  }

  // Yield in reverse order
  while (resultStack.length) {
    const item = resultStack.pop();
    if (item) {
      yield item;
    }
  }
}

/**
 * Generator-based Breadth-First Search (BFS)
 * Processes directories level by level
 * Good for finding files at specific depth or displaying hierarchy
 */
export function* walkBFS<T extends TraversableNode<T>>(
  node: T | null | undefined,
): Generator<T, void, undefined> {
  if (!node) return;

  const queue: T[] = [node];
  while (queue.length) {
    const item = queue.shift();
    if (!item) {
      continue;
    }

    yield item;

    if (item.children) {
      for (const child of item.children) {
        queue.push(child);
      }
    }
  }
}

/**
 * BFS with level information
 * Returns [node, level] tuples
 */
export function* walkBFSWithLevel<T extends TraversableNode<T>>(
  node: T | null | undefined,
): Generator<[T, number], void, undefined> {
  if (!node) return;

  const queue: Array<[T, number]> = [[node, 0]];
  while (queue.length) {
    const [item, level] = queue.shift();
    if (!item) {
      continue;
    }

    yield [item, level];

    if (item.children) {
      for (const child of item.children) {
        queue.push([child, level + 1]);
      }
    }
  }
}

/**
 * Get all nodes at a specific level
 */
export function getNodesAtLevel<T extends TraversableNode<T>>(
  root: T | null | undefined,
  targetLevel: number,
): T[] {
  const nodes: T[] = [];
  for (const [node, level] of walkBFSWithLevel(root)) {
    if (level === targetLevel) {
      nodes.push(node);
    } else if (level > targetLevel) {
      break; // BFS guarantees we won't find more at target level
    }
  }
  return nodes;
}

/**
 * Find node by predicate using BFS (finds closest match)
 */
export function findNode<T extends TraversableNode<T>>(
  root: T | null | undefined,
  // eslint-disable-next-line no-unused-vars
  predicate: (node: T) => boolean,
): T | null {
  for (const node of walkBFS(root)) {
    if (predicate(node)) {
      return node;
    }
  }
  return null;
}

/**
 * Find all nodes matching predicate
 */
export function findAllNodes<T extends TraversableNode<T>>(
  root: T | null | undefined,
  // eslint-disable-next-line no-unused-vars
  predicate: (node: T) => boolean,
): T[] {
  const results: T[] = [];
  for (const node of walkBFS(root)) {
    if (predicate(node)) {
      results.push(node);
    }
  }
  return results;
}

/**
 * Count total nodes in tree
 */
export function countNodes<T extends TraversableNode<T>>(
  root: T | null | undefined,
): number {
  let count = 0;
  for (const node of walkBFS(root)) {
    void node;
    count++;
  }
  return count;
}

/**
 * Get maximum depth of tree
 */
export function getMaxDepth<T extends TraversableNode<T>>(
  root: T | null | undefined,
): number {
  let maxDepth = 0;
  for (const [, level] of walkBFSWithLevel(root)) {
    maxDepth = Math.max(maxDepth, level);
  }
  return maxDepth;
}

/**
 * Flatten tree to array using specified traversal
 */
export function flattenTree<T extends TraversableNode<T>>(
  root: T | null | undefined,
  traversalType: TraversalType = "bfs",
): T[] {
  const walker =
    traversalType === "pre"
      ? walkPreOrder
      : traversalType === "post"
      ? walkPostOrder
      : walkBFS;

  return Array.from(walker(root));
}

/**
 * Example usage for directory trees
 */
export function exampleUsage() {
  type ExampleNode = {
    name: string;
    type: "directory" | "file";
    children?: ExampleNode[];
  };

  // Example tree structure (like directory tree from getWorkspaceInfo)
  const tree: ExampleNode = {
    name: "project",
    type: "directory",
    children: [
      {
        name: "src",
        type: "directory",
        children: [
          { name: "index.js", type: "file" },
          { name: "utils.js", type: "file" },
        ],
      },
      {
        name: "package.json",
        type: "file",
      },
    ],
  };

  console.log("=== BFS Traversal (Level by Level) ===");
  for (const node of walkBFS(tree)) {
    console.log(node.name);
  }

  console.log("\n=== Pre-Order Traversal (Parent First) ===");
  for (const node of walkPreOrder(tree)) {
    console.log(node.name);
  }

  console.log("\n=== Post-Order Traversal (Children First) ===");
  for (const node of walkPostOrder(tree)) {
    console.log(node.name);
  }

  console.log("\n=== Find all files ===");
  const files = findAllNodes(tree, (node) => node.type === "file");
  console.log(files.map((f) => f.name));

  console.log("\n=== Get depth ===");
  console.log("Max depth:", getMaxDepth(tree));
}
