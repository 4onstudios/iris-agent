type ToolArgs = Record<string, unknown>;

export type PendingToolCall = {
  name: string;
  args: ToolArgs;
  toolCallId?: string;
};

export type ExecutedToolResult = {
  name: string;
  args: ToolArgs;
  result: unknown;
  toolCallId?: string;
  lifecycleStepIndex?: number;
};

export type ToolExecutionStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "pending_confirmation"
  | "unknown";

const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "error",
  "success",
  "ok",
  "rejected",
]);

const IN_PROGRESS_STATUSES = new Set([
  "in_progress",
  "pending",
  "queued",
  "running",
  "started",
]);

const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
};

export const resolveToolExecutionStatus = (
  result: unknown,
): ToolExecutionStatus => {
  if (typeof result === "string") return "completed";

  if (result === null || result === undefined) return "unknown";
  if (typeof result !== "object") return "completed";

  const direct = result as {
    status?: unknown;
    success?: unknown;
    isError?: unknown;
    is_error?: unknown;
    error?: unknown;
    value?: {
      status?: unknown;
      success?: unknown;
      isError?: unknown;
      is_error?: unknown;
      error?: unknown;
    };
  };
  const nested = direct.value;

  const directStatus =
    typeof direct.status === "string" ? direct.status.toLowerCase() : null;
  const nestedStatus =
    typeof nested?.status === "string" ? nested.status.toLowerCase() : null;
  const rawStatus = directStatus ?? nestedStatus;
  const successFlag = direct.success ?? nested?.success;

  if (typeof successFlag === "boolean") {
    if (successFlag) return "completed";
    return "failed";
  }

  if (rawStatus === "pending_confirmation") return rawStatus;
  if (rawStatus && ["pending", "queued", "started"].includes(rawStatus))
    return "pending";
  if (rawStatus && ["in_progress", "running"].includes(rawStatus))
    return "in_progress";
  if (rawStatus && ["completed", "success", "ok"].includes(rawStatus))
    return "completed";
  if (rawStatus && ["failed", "error", "rejected"].includes(rawStatus))
    return "failed";

  const hasErrorFlag =
    direct.isError === true ||
    direct.is_error === true ||
    nested?.isError === true ||
    nested?.is_error === true;
  const hasErrorMessage = Boolean(direct.error || nested?.error);

  if (hasErrorFlag || hasErrorMessage) return "failed";

  return "completed";
};

const isTerminalResult = (result: unknown): boolean => {
  return TERMINAL_STATUSES.has(resolveToolExecutionStatus(result));
};

const isSettledForPendingReconciliation = (result: unknown): boolean => {
  const status = resolveToolExecutionStatus(result);
  return status === "pending_confirmation" || TERMINAL_STATUSES.has(status);
};

const getResultRank = (result: unknown): number => {
  const status = resolveToolExecutionStatus(result);
  if (status === "unknown") return 1;
  if (TERMINAL_STATUSES.has(status)) return 3;
  if (IN_PROGRESS_STATUSES.has(status)) return 0;
  return 2;
};

const buildDedupKey = (
  name: string,
  args: ToolArgs,
  toolCallId?: string,
  catalog?: ToolInvocationCatalog,
): string => {
  const signatureKey = buildSignatureKey(name, args || {});
  if (toolCallId) {
    return resolveIdentifiedKey(name, args || {}, toolCallId, catalog);
  }
  return signatureKey;
};

const buildSignatureKey = (name: string, args: ToolArgs): string =>
  `sig:${name}:${stableStringify(args)}`;

export const getToolCallSignature = (name: string, args: ToolArgs): string =>
  buildSignatureKey(name, args);

type ToolInvocationIdentity = {
  toolCallId: string;
  name: string;
  args: ToolArgs;
  signatureKey: string;
  hasArgumentDetails: boolean;
};

type ToolInvocationCatalog = Map<string, ToolInvocationIdentity[]>;

const hasArgumentDetails = (args: ToolArgs): boolean =>
  Object.keys(args || {}).length > 0;

const buildToolInvocationCatalog = (
  entries: Array<{ name: string; args: ToolArgs; toolCallId?: string }>,
): ToolInvocationCatalog => {
  const catalog = new Map<string, ToolInvocationIdentity[]>();
  for (const entry of entries) {
    if (!entry.toolCallId) continue;
    const signatureKey = buildSignatureKey(entry.name, entry.args || {});
    const existing = catalog.get(entry.toolCallId) || [];
    existing.push({
      toolCallId: entry.toolCallId,
      name: entry.name,
      args: entry.args || {},
      signatureKey,
      hasArgumentDetails: hasArgumentDetails(entry.args || {}),
    });
    catalog.set(entry.toolCallId, existing);
  }
  return catalog;
};

const resolveUniqueDetailedInvocation = (
  name: string,
  toolCallId: string,
  catalog?: ToolInvocationCatalog,
): ToolInvocationIdentity | undefined => {
  if (!catalog) return undefined;

  const candidates = (catalog.get(toolCallId) || []).filter(
    (entry) => entry.name === name && entry.hasArgumentDetails,
  );
  const candidateSignatures = new Set(
    candidates.map((entry) => entry.signatureKey),
  );
  if (candidateSignatures.size !== 1) {
    return undefined;
  }

  return candidates[0];
};

const resolveIdentifiedKey = (
  name: string,
  args: ToolArgs,
  toolCallId: string,
  catalog?: ToolInvocationCatalog,
): string => {
  const signatureKey = buildSignatureKey(name, args || {});
  if (!catalog || hasArgumentDetails(args || {})) {
    return `id:${toolCallId}:${signatureKey}`;
  }

  const resolvedInvocation = resolveUniqueDetailedInvocation(
    name,
    toolCallId,
    catalog,
  );
  if (resolvedInvocation) {
    return `id:${toolCallId}:${resolvedInvocation.signatureKey}`;
  }

  return `id:${toolCallId}:${signatureKey}`;
};

const resolveIdentifiedArgs = (
  name: string,
  args: ToolArgs,
  toolCallId: string | undefined,
  catalog?: ToolInvocationCatalog,
): ToolArgs => {
  if (!toolCallId || hasArgumentDetails(args || {})) {
    return args || {};
  }

  const resolvedInvocation = resolveUniqueDetailedInvocation(
    name,
    toolCallId,
    catalog,
  );
  return resolvedInvocation?.args || (args || {});
};

const extractSignatureFromIdentifiedKey = (key: string): string => {
  const marker = ":sig:";
  const markerIndex = key.indexOf(marker);
  if (markerIndex === -1) {
    return key;
  }
  return `sig:${key.slice(markerIndex + marker.length)}`;
};

const hasSameLifecycleStep = (
  current: ExecutedToolResult,
  previous: ExecutedToolResult,
): boolean =>
  current.lifecycleStepIndex === undefined ||
  previous.lifecycleStepIndex === undefined ||
  current.lifecycleStepIndex === previous.lifecycleStepIndex;

const canReuseSameResultKey = (
  current: ExecutedToolResult,
  previous: ExecutedToolResult,
): boolean => {
  if (isTerminalResult(current.result) && isTerminalResult(previous.result)) {
    return hasSameLifecycleStep(current, previous);
  }

  return true;
};

export const countUniqueToolCalls = (
  pendingToolCalls: Array<{
    name: string;
    args: ToolArgs;
    toolCallId?: string;
  }>,
  executedToolResults: Array<{
    name: string;
    args: ToolArgs;
    toolCallId?: string;
  }>,
): number => {
  const identifiedCatalog = buildToolInvocationCatalog([
    ...pendingToolCalls,
    ...executedToolResults,
  ]);
  const seenIds = new Set<string>();
  const identifiedCounts = new Map<string, number>();
  const pendingAnonymousCounts = new Map<string, number>();
  const executedAnonymousCounts = new Map<
    string,
    { terminal: number; inProgress: number; unknown: number }
  >();

  for (const call of [...pendingToolCalls, ...executedToolResults]) {
    if (call.toolCallId) {
      const key = buildDedupKey(
        call.name,
        call.args || {},
        call.toolCallId,
        identifiedCatalog,
      );
      if (seenIds.has(key)) continue;
      seenIds.add(key);
      const signatureKey = extractSignatureFromIdentifiedKey(key);
      identifiedCounts.set(
        signatureKey,
        (identifiedCounts.get(signatureKey) || 0) + 1,
      );
    }
  }

  for (const call of pendingToolCalls) {
    if (call.toolCallId) continue;
    const signatureKey = buildSignatureKey(call.name, call.args || {});
    pendingAnonymousCounts.set(
      signatureKey,
      (pendingAnonymousCounts.get(signatureKey) || 0) + 1,
    );
  }

  for (const result of executedToolResults) {
    if (result.toolCallId) continue;
    const signatureKey = buildSignatureKey(result.name, result.args || {});
    const counts = executedAnonymousCounts.get(signatureKey) || {
      terminal: 0,
      inProgress: 0,
      unknown: 0,
    };
    const status = resolveToolExecutionStatus(
      "result" in result ? result.result : undefined,
    );
    if (TERMINAL_STATUSES.has(status)) {
      counts.terminal += 1;
    } else if (IN_PROGRESS_STATUSES.has(status)) {
      counts.inProgress += 1;
    } else {
      counts.unknown += 1;
    }
    executedAnonymousCounts.set(signatureKey, counts);
  }

  const signatures = new Set([
    ...identifiedCounts.keys(),
    ...pendingAnonymousCounts.keys(),
    ...executedAnonymousCounts.keys(),
  ]);
  return Array.from(signatures).reduce((total, signatureKey) => {
    const executedAnonymous = executedAnonymousCounts.get(signatureKey);
    // Identified calls and anonymous pending calls are distinct invocations
    // even when they share a signature, so they contribute additively.
    const invocations =
      (identifiedCounts.get(signatureKey) || 0) +
      (pendingAnonymousCounts.get(signatureKey) || 0);
    // Anonymous result snapshots are overlapping evidence of invocations
    // already counted above, so they only raise the floor.
    const anonymousResultEvidence = Math.max(
      executedAnonymous?.terminal || 0,
      executedAnonymous?.inProgress || 0,
      executedAnonymous?.unknown || 0,
    );
    return total + Math.max(invocations, anonymousResultEvidence);
  }, 0);
};

export const normalizeToolLifecycle = (
  pendingToolCalls: PendingToolCall[],
  executedToolResults: ExecutedToolResult[],
): {
  pendingToolCalls: PendingToolCall[];
  executedToolResults: ExecutedToolResult[];
} => {
  const identifiedCatalog = buildToolInvocationCatalog([
    ...pendingToolCalls,
    ...executedToolResults,
  ]);
  const executedByKey = new Map<string, ExecutedToolResult>();
  const anonymousResultKeysBySignature = new Map<string, string[]>();
  // Include identified pending calls when establishing cardinality: an
  // anonymous (missing-ID) executed result can settle an identified pending
  // call (see the pending-reconciliation pass below), so an identified
  // pending call also represents a known invocation slot for its signature.
  const pendingSignatureCounts = new Map<string, number>();
  for (const call of pendingToolCalls) {
    const signatureKey = buildSignatureKey(call.name, call.args || {});
    pendingSignatureCounts.set(
      signatureKey,
      (pendingSignatureCounts.get(signatureKey) || 0) + 1,
    );
  }

  for (const item of executedToolResults) {
    const resolvedArgs = resolveIdentifiedArgs(
      item.name,
      item.args || {},
      item.toolCallId,
      identifiedCatalog,
    );
    const normalizedItem =
      resolvedArgs === (item.args || {})
        ? item
        : { ...item, args: resolvedArgs };
    const signatureKey = buildSignatureKey(
      normalizedItem.name,
      normalizedItem.args || {},
    );
    const anonymousKeys =
      anonymousResultKeysBySignature.get(signatureKey) || [];
    const pendingCount = pendingSignatureCounts.get(signatureKey) || 0;
    // Prefer completing an outstanding lower-rank result (transitionKey) before
    // collapsing into an identical terminal snapshot (sameResultKey). Only
    // treat an identical payload as a duplicate once we already have at least
    // as many results as known pending invocations (identified or anonymous)
    // for this signature. A pendingCount of 0 means there is no established
    // invocation cardinality for anonymous calls (e.g. only executed results,
    // no pending calls at all), so these same-rank collapsing rules must not
    // apply — otherwise distinct anonymous results with the same signature
    // would be merged as if they were snapshots of a single invocation.
    const hasEstablishedCardinality =
      pendingCount > 0 && anonymousKeys.length >= pendingCount;
    const transitionKey = anonymousKeys.find((candidateKey) => {
      const previous = executedByKey.get(candidateKey);
      return (
        previous &&
        getResultRank(normalizedItem.result) > getResultRank(previous.result)
      );
    });
    const sameResultKey = hasEstablishedCardinality
      ? anonymousKeys.find((candidateKey) => {
          const previous = executedByKey.get(candidateKey);
          return (
            previous &&
            canReuseSameResultKey(normalizedItem, previous) &&
            stableStringify(previous.result) ===
              stableStringify(normalizedItem.result)
          );
        })
      : undefined;
    const sameRankProgressKey = hasEstablishedCardinality
      ? anonymousKeys.find((candidateKey) => {
          const previous = executedByKey.get(candidateKey);
          return (
            previous &&
            resolveToolExecutionStatus(previous.result) === "in_progress" &&
            resolveToolExecutionStatus(normalizedItem.result) === "in_progress"
          );
        })
      : undefined;
    const sameRankTerminalKey = hasEstablishedCardinality
      ? anonymousKeys.find((candidateKey) => {
          const previous = executedByKey.get(candidateKey);
          return (
            previous &&
            hasSameLifecycleStep(normalizedItem, previous) &&
            isTerminalResult(previous.result) &&
            isTerminalResult(normalizedItem.result) &&
            getResultRank(normalizedItem.result) ===
              getResultRank(previous.result)
          );
        })
      : undefined;
    const key = normalizedItem.toolCallId
      ? buildDedupKey(
          normalizedItem.name,
          normalizedItem.args || {},
          normalizedItem.toolCallId,
          identifiedCatalog,
        )
      : transitionKey ||
        sameResultKey ||
        sameRankProgressKey ||
        sameRankTerminalKey ||
        `${signatureKey}:${anonymousKeys.length}`;
    const previous = executedByKey.get(key);

    if (!previous) {
      executedByKey.set(key, normalizedItem);
      if (!normalizedItem.toolCallId) {
        const keys = anonymousResultKeysBySignature.get(signatureKey) || [];
        keys.push(key);
        anonymousResultKeysBySignature.set(signatureKey, keys);
      }
      continue;
    }

    const prevRank = getResultRank(previous.result);
    const nextRank = getResultRank(normalizedItem.result);
    const isInProgressUpdate =
      resolveToolExecutionStatus(previous.result) === "in_progress" &&
      resolveToolExecutionStatus(normalizedItem.result) === "in_progress";

    // Once two results share this key, they are already confirmed to be the
    // same invocation (via toolCallId, or via transitionKey/sameResultKey/
    // sameRankProgressKey/sameRankTerminalKey for anonymous calls). So an
    // equal-rank update should always replace the prior snapshot with the
    // latest one, even when the payloads differ (e.g. failed -> completed).
    if (nextRank >= prevRank || isInProgressUpdate) {
      executedByKey.set(key, normalizedItem);
    }
  }

  const normalizedExecuted = Array.from(executedByKey.values());
  const settledExecutedKeys = new Set(
    normalizedExecuted
      .filter((result) => isSettledForPendingReconciliation(result.result))
      .map((result) => {
        const key = buildDedupKey(
          result.name,
          result.args || {},
          result.toolCallId,
          identifiedCatalog,
        );
        return key;
      }),
  );

  const pendingByKey = new Map<string, PendingToolCall>();
  const settledAnonymousResultsBySignature = new Map<string, number>();
  for (const result of normalizedExecuted) {
    if (
      !result.toolCallId &&
      isSettledForPendingReconciliation(result.result)
    ) {
      const signatureKey = buildSignatureKey(result.name, result.args || {});
      settledAnonymousResultsBySignature.set(
        signatureKey,
        (settledAnonymousResultsBySignature.get(signatureKey) || 0) + 1,
      );
    }
  }

  for (const [index, item] of pendingToolCalls.entries()) {
    const key = buildDedupKey(
      item.name,
      item.args || {},
      item.toolCallId,
      identifiedCatalog,
    );

    if (item.toolCallId && settledExecutedKeys.has(key)) {
      continue;
    }

    const signatureKey = buildSignatureKey(item.name, item.args || {});
    const matchingResultWithoutId = normalizedExecuted.filter(
      (result) =>
        !result.toolCallId &&
        buildSignatureKey(result.name, result.args || {}) === signatureKey,
    );
    const sameSignaturePendingCalls = pendingToolCalls.filter(
      (pending) =>
        buildSignatureKey(pending.name, pending.args || {}) === signatureKey,
    );
    const hasSettledMatch = matchingResultWithoutId.some((result) =>
      isSettledForPendingReconciliation(result.result),
    );

    if (hasSettledMatch) {
      const remainingSettledResults =
        settledAnonymousResultsBySignature.get(signatureKey) || 0;
      if (remainingSettledResults > 0) {
        settledAnonymousResultsBySignature.set(
          signatureKey,
          remainingSettledResults - 1,
        );
        continue;
      }
    }

    const preserveAnonymousMultiplicity =
      !item.toolCallId && sameSignaturePendingCalls.length > 1;
    const pendingKey = preserveAnonymousMultiplicity
      ? `${signatureKey}:${index}`
      : item.toolCallId || sameSignaturePendingCalls.length === 1
        ? key
        : signatureKey;
    pendingByKey.set(pendingKey, item);
  }

  return {
    pendingToolCalls: Array.from(pendingByKey.values()),
    executedToolResults: normalizedExecuted,
  };
};
