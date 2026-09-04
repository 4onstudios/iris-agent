import type {
  AgentCapability,
  AgentDescriptor,
  AgentPermissionScope,
  AgentRuntime,
  AgentRuntimeFactory,
  AgentSource,
} from "./AgentContract";

export type AgentSelectionPolicy = {
  requiredCapabilities?: AgentCapability[];
  requiredPermissions?: AgentPermissionScope[];
};

const ensureNonEmpty = (value: string, field: string): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`Agent descriptor requires a non-empty ${field}`);
  }
  return trimmed;
};

const normalizeDescriptor = (
  descriptor: AgentDescriptor,
  expectedSource: AgentSource,
): AgentDescriptor => {
  const id = ensureNonEmpty(descriptor.id, "id");
  const name = ensureNonEmpty(descriptor.name, "name");
  const version = ensureNonEmpty(descriptor.version, "version");

  if (descriptor.source !== expectedSource) {
    throw new Error(
      `Agent '${id}' has source '${descriptor.source}' but must be '${expectedSource}' in this registration path`,
    );
  }

  return {
    ...descriptor,
    id,
    name,
    version,
  };
};

export class AgentRegistry<TRuntime = AgentRuntime> {
  private readonly descriptors = new Map<string, AgentDescriptor>();
  private readonly factories = new Map<string, AgentRuntimeFactory<TRuntime>>();
  private defaultAgentId: string | null = null;

  registerBuiltin(
    descriptor: AgentDescriptor,
    factory: AgentRuntimeFactory<TRuntime>,
    options: { asDefault?: boolean } = {},
  ): void {
    const normalized = normalizeDescriptor(descriptor, "builtin");
    this.register(normalized, factory);

    if (options.asDefault || this.defaultAgentId === null) {
      this.defaultAgentId = normalized.id;
    }
  }

  registerExternal(descriptor: AgentDescriptor, factory: AgentRuntimeFactory<TRuntime>): void {
    const normalized = normalizeDescriptor(descriptor, "external");
    this.register(normalized, factory);
  }

  private register(descriptor: AgentDescriptor, factory: AgentRuntimeFactory<TRuntime>): void {
    if (this.descriptors.has(descriptor.id)) {
      throw new Error(`Agent '${descriptor.id}' is already registered`);
    }

    this.descriptors.set(descriptor.id, descriptor);
    this.factories.set(descriptor.id, factory);
  }

  setDefaultAgent(agentId: string): void {
    const normalizedId = ensureNonEmpty(agentId, "agent id");
    if (!this.descriptors.has(normalizedId)) {
      throw new Error(`Cannot set default agent. Unknown agent '${normalizedId}'`);
    }

    this.defaultAgentId = normalizedId;
  }

  getDefaultAgentId(): string | null {
    return this.defaultAgentId;
  }

  getDefaultAgentDescriptor(): AgentDescriptor | null {
    if (!this.defaultAgentId) {
      return null;
    }

    return this.descriptors.get(this.defaultAgentId) || null;
  }

  getAgentDescriptor(agentId: string): AgentDescriptor | null {
    const normalizedId = ensureNonEmpty(agentId, "agent id");
    return this.descriptors.get(normalizedId) || null;
  }

  listAgents(): AgentDescriptor[] {
    return Array.from(this.descriptors.values());
  }

  private satisfiesPolicy(
    descriptor: AgentDescriptor | undefined,
    policy?: AgentSelectionPolicy,
  ): boolean {
    if (!descriptor || !policy) {
      return Boolean(descriptor);
    }

    const requiredCapabilities = policy.requiredCapabilities || [];
    const requiredPermissions = policy.requiredPermissions || [];

    if (requiredCapabilities.length > 0) {
      const capabilities = descriptor.capabilities || {};
      for (const capability of requiredCapabilities) {
        if (capabilities[capability] !== true) {
          return false;
        }
      }
    }

    if (requiredPermissions.length > 0) {
      const permissions = descriptor.permissions || {};
      for (const scope of requiredPermissions) {
        if (permissions[scope] === "deny") {
          return false;
        }
      }
    }

    return true;
  }

  resolveAgentId(preferredAgentId?: string): string {
    const preferred = preferredAgentId?.trim();
    if (preferred && this.descriptors.has(preferred)) {
      return preferred;
    }

    if (this.defaultAgentId) {
      return this.defaultAgentId;
    }

    throw new Error("No default agent is configured");
  }

  resolveAgentIdWithPolicy(
    preferredAgentId: string | undefined,
    policy: AgentSelectionPolicy,
  ): string {
    const preferred = preferredAgentId?.trim();
    const preferredDescriptor = preferred ? this.descriptors.get(preferred) : undefined;

    if (preferred && this.satisfiesPolicy(preferredDescriptor, policy)) {
      return preferred;
    }

    if (this.defaultAgentId) {
      const fallbackDescriptor = this.descriptors.get(this.defaultAgentId);
      if (this.satisfiesPolicy(fallbackDescriptor, policy)) {
        return this.defaultAgentId;
      }
    }

    throw new Error("No eligible agent is configured for the requested policy");
  }

  async createRuntime(
    preferredAgentId?: string,
    policy?: AgentSelectionPolicy,
  ): Promise<TRuntime> {
    const agentId = policy
      ? this.resolveAgentIdWithPolicy(preferredAgentId, policy)
      : this.resolveAgentId(preferredAgentId);
    const factory = this.factories.get(agentId);

    if (!factory) {
      throw new Error(`No runtime factory registered for agent '${agentId}'`);
    }

    return await Promise.resolve(factory());
  }
}
