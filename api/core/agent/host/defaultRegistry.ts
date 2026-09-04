import { AgentRegistry } from "./AgentRegistry";
import type { AgentDescriptor, AgentRuntimeFactory } from "./AgentContract";

export const IRIS_DEFAULT_AGENT_DESCRIPTOR: AgentDescriptor = {
  id: "iris",
  name: "Iris",
  version: "1.0.0",
  source: "builtin",
  description: "Default built-in Iris coding agent runtime",
  capabilities: {
    tool_calling: true,
    streaming: true,
    approval_flow: true,
    workspace_search: true,
    filesystem: true,
    lsp: true,
    mcp: true,
  },
};

type ExternalAgentRegistration<TRuntime> = {
  id?: string;
  name?: string;
  description?: string;
  runtimeFactory: AgentRuntimeFactory<TRuntime>;
};

type CreateDefaultAgentRegistryOptions<TRuntime> = {
  irisFactory: AgentRuntimeFactory<TRuntime>;
  externalRegistration?: ExternalAgentRegistration<TRuntime>;
};

export const createDefaultAgentRegistry = <TRuntime>({
  irisFactory,
  externalRegistration,
}: CreateDefaultAgentRegistryOptions<TRuntime>): AgentRegistry<TRuntime> => {
  const registry = new AgentRegistry<TRuntime>();

  registry.registerBuiltin(IRIS_DEFAULT_AGENT_DESCRIPTOR, irisFactory, {
    asDefault: true,
  });

  if (externalRegistration) {
    const id = (externalRegistration.id || "external-agent").trim() || "external-agent";
    const name = (externalRegistration.name || "External Agent").trim() || "External Agent";

    registry.registerExternal(
      {
        id,
        name,
        version: "0.1.0",
        source: "external",
        description:
          externalRegistration.description ||
          "External agent registration hook.",
        capabilities: {
          tool_calling: true,
          streaming: true,
          approval_flow: true,
          workspace_search: true,
          filesystem: true,
          lsp: true,
          mcp: true,
        },
        tags: ["external"],
      },
      externalRegistration.runtimeFactory,
    );
  }

  return registry;
};
