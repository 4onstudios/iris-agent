import fs from "fs/promises";
import path from "path";
import { pathToFileURL } from "url";
import { z } from "zod";
import type {
  AgentCapabilityMap,
  AgentDescriptor,
  AgentPermissionPolicy,
  AgentRuntimeFactory,
} from "./AgentContract";

const manifestSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1).default("0.1.0"),
  description: z.string().optional(),
  modulePath: z.string().min(1),
  exportName: z.string().optional(),
  capabilities: z.record(z.string(), z.boolean()).optional(),
  permissions: z.record(z.string(), z.enum(["allow", "deny", "ask"])).optional(),
});

export type ExternalAgentManifest = z.infer<typeof manifestSchema>;

export type ExternalAgentRuntimeContext = {
  modelId: string;
  workspacePath: string;
  mcpServers: unknown[];
};

export type ExternalAgentRegistration<TRuntime> = {
  descriptor: AgentDescriptor;
  runtimeFactory: AgentRuntimeFactory<TRuntime>;
};

const toCapabilities = (value: ExternalAgentManifest["capabilities"]): AgentCapabilityMap | undefined => {
  if (!value) return undefined;
  return value as AgentCapabilityMap;
};

const toPermissions = (value: ExternalAgentManifest["permissions"]): AgentPermissionPolicy | undefined => {
  if (!value) return undefined;
  return value as AgentPermissionPolicy;
};

const resolveModuleFactory = (
  moduleNamespace: Record<string, unknown>,
  exportName?: string,
): ((context: ExternalAgentRuntimeContext) => Promise<unknown> | unknown) => {
  const candidates = exportName
    ? [exportName]
    : ["createAgentRuntime", "default", "createRuntime"];

  for (const candidate of candidates) {
    const resolved = moduleNamespace[candidate];
    if (typeof resolved === "function") {
      return resolved as (context: ExternalAgentRuntimeContext) => Promise<unknown> | unknown;
    }

    const defaultNamespace = moduleNamespace.default;
    if (defaultNamespace && typeof defaultNamespace === "object") {
      const nested = (defaultNamespace as Record<string, unknown>)[candidate];
      if (typeof nested === "function") {
        return nested as (context: ExternalAgentRuntimeContext) => Promise<unknown> | unknown;
      }
    }
  }

  throw new Error(
    `External agent module is missing a runtime factory export. Checked: ${candidates.join(", ")}`,
  );
};

export class ExternalAgentLifecycleManager<TRuntime> {
  private readonly manifestPath: string;
  private manifestCache: ExternalAgentManifest | null = null;
  private moduleCache: Record<string, unknown> | null = null;
  private lastHealthStatus:
    | { ok: true; checkedAt: number }
    | { ok: false; checkedAt: number; reason: string }
    | null = null;

  constructor(manifestPath: string) {
    this.manifestPath = manifestPath;
  }

  async loadManifest(): Promise<ExternalAgentManifest> {
    if (this.manifestCache) {
      return this.manifestCache;
    }

    const raw = await fs.readFile(this.manifestPath, "utf8");
    const parsed = manifestSchema.parse(JSON.parse(raw));
    this.manifestCache = parsed;
    return parsed;
  }

  private async loadModule(): Promise<Record<string, unknown>> {
    if (this.moduleCache) {
      return this.moduleCache;
    }

    const manifest = await this.loadManifest();
    const baseDir = path.dirname(this.manifestPath);
    const modulePath = path.isAbsolute(manifest.modulePath)
      ? manifest.modulePath
      : path.resolve(baseDir, manifest.modulePath);

    const moduleUrl = pathToFileURL(modulePath).href;
    const loaded = (await import(moduleUrl)) as Record<string, unknown>;
    this.moduleCache = loaded;
    return loaded;
  }

  async healthCheck(): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      const manifest = await this.loadManifest();
      const moduleNamespace = await this.loadModule();
      resolveModuleFactory(moduleNamespace, manifest.exportName);

      this.lastHealthStatus = { ok: true, checkedAt: Date.now() };
      return { ok: true };
    } catch (error) {
      const err = error as Error;
      const reason = err.message || "Unknown external agent health-check failure";
      this.lastHealthStatus = { ok: false, checkedAt: Date.now(), reason };
      return { ok: false, reason };
    }
  }

  getLastHealthStatus():
    | { ok: true; checkedAt: number }
    | { ok: false; checkedAt: number; reason: string }
    | null {
    return this.lastHealthStatus;
  }

  async createRegistration(
    context: ExternalAgentRuntimeContext,
  ): Promise<ExternalAgentRegistration<TRuntime>> {
    const health = await this.healthCheck();
    if (!health.ok) {
      const reason = "reason" in health ? health.reason : "unknown";
      throw new Error(`External agent failed health check: ${reason}`);
    }

    const manifest = await this.loadManifest();
    const moduleNamespace = await this.loadModule();
    const factory = resolveModuleFactory(moduleNamespace, manifest.exportName);

    const descriptor: AgentDescriptor = {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      source: "external",
      description: manifest.description,
      capabilities: toCapabilities(manifest.capabilities),
      permissions: toPermissions(manifest.permissions),
      tags: ["manifest", "external", "health-checked"],
    };

    return {
      descriptor,
      runtimeFactory: () => Promise.resolve(factory(context) as TRuntime),
    };
  }
}
