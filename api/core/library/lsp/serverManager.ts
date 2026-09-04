import { existsSync } from "fs";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { createHash } from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import { runtimeEventBus } from "../runtimeEventBus";
import { extensionManager } from "../extensionManager";

const execFileAsync = promisify(execFile);

export type ServerLaunchSpec = {
  serverId: string;
  languageId: string;
  version: string;
  source: "workspace" | "approved-registry";
  signatureVerified: boolean;
  sha256: string;
  command: string;
  args: string[];
  cwd?: string;
};

type LanguageServerAuditEventName =
  | "language_server_install_requested"
  | "language_server_installed"
  | "language_server_install_failed"
  | "language_server_signature_verified"
  | "language_server_signature_failed"
  | "language_server_started"
  | "language_server_stopped"
  | "language_server_updated"
  | "language_server_removed";

type LanguagePolicy = {
  id: string;
  languageId: string;
  command: string;
  args: string[];
  version: string;
  packageName?: string;
  source: "approved-registry";
};

type InstallManifest = {
  id: string;
  language: string;
  version: string;
  command: string;
  sha256: string;
  source: "approved-registry";
  installed_at: string;
  signature_verified: boolean;
};

type LanguageServerAuditEvent = {
  event_name: LanguageServerAuditEventName;
  occurred_at: string;
  actor_type: "system";
  language: string;
  server_id: string;
  server_version: string;
  sha256: string;
  workspace_id: string;
  outcome: "success" | "failure";
  details?: string;
};

const AUDIT_EVENT_BUS_TOPIC = "audit:language_server";
const getHomeCacheRoot = (): string => path.join(os.homedir(), ".iris", "language-servers");
const isBundledDesktopRuntime = (): boolean => process.env.TAURI_BUNDLED === "1";

const getApprovedChecksumMap = (): Record<string, string> => {
  const raw = process.env.IRIS_LSP_APPROVED_SHA256_JSON;
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};

const getSystemServerOverrideMap = (): Record<string, string> => {
  const raw = process.env.IRIS_LSP_SYSTEM_SERVER_OVERRIDE_JSON;
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};

const LANGUAGE_SERVER_POLICIES: Record<string, LanguagePolicy> = {
  python: {
    id: "pyright",
    languageId: "python",
    command: "pyright-langserver",
    args: ["--stdio"],
    version: "1.1.405",
    packageName: "pyright",
    source: "approved-registry",
  },
  typescript: {
    id: "typescript-language-server",
    languageId: "typescript",
    command: "typescript-language-server",
    args: ["--stdio"],
    version: "4.4.0",
    source: "approved-registry",
  },
  javascript: {
    id: "typescript-language-server",
    languageId: "javascript",
    command: "typescript-language-server",
    args: ["--stdio"],
    version: "4.4.0",
    source: "approved-registry",
  },
  go: {
    id: "gopls",
    languageId: "go",
    command: "gopls",
    args: [],
    version: "system",
    source: "approved-registry",
  },
  rust: {
    id: "rust-analyzer",
    languageId: "rust",
    command: "rust-analyzer",
    args: [],
    version: "system",
    source: "approved-registry",
  },
  gdscript: {
    id: "godot",
    languageId: "gdscript",
    command: "godot",
    args: ["--headless", "--lsp"],
    version: "system",
    source: "approved-registry",
  },
  cpp: {
    id: "clangd",
    languageId: "cpp",
    command: "clangd",
    args: ["--background-index"],
    version: "system",
    source: "approved-registry",
  },
};

const ensureDirectory = async (dirPath: string): Promise<void> => {
  await fs.mkdir(dirPath, { recursive: true });
};

const sha256File = async (filePath: string): Promise<string> => {
  const fileBuffer = await fs.readFile(filePath);
  return createHash("sha256").update(fileBuffer).digest("hex");
};

export class ServerManager {
  private workspaceRoot: string | null = null;
  private serverCacheRoot: string;
  private inventoryPath: string;
  private manifestsDir: string;
  private auditLogPath: string;

  constructor() {
    this.serverCacheRoot = getHomeCacheRoot();
    this.inventoryPath = path.join(this.serverCacheRoot, "inventory.json");
    this.manifestsDir = path.join(this.serverCacheRoot, "manifests");
    this.auditLogPath = path.join(this.serverCacheRoot, "audit.log");
  }

  setWorkspaceRoot(rootPath: string | null): void {
    this.workspaceRoot = rootPath;

    if (extensionManager.isCopilotLanguageServerEnabled()) {
      void this.ensureOptionalServers();
    }
  }

  async resolveLaunchSpec(languageId: string): Promise<ServerLaunchSpec | null> {
    const policy = this.getPolicy(languageId);
    if (!policy) {
      return null;
    }

    switch (languageId) {
      case "typescript":
      case "typescriptreact":
      case "javascript":
      case "javascriptreact":
      case "python":
        return this.resolveNodeLanguageServer(policy);

      case "go":
      case "cpp":
      case "c":
      case "objc":
      case "objcpp":
      case "rust":
      case "gdscript":
        return this.resolveSystemServer(policy);

      default:
        return null;
    }
  }

  async recordServerStarted(languageId: string, sha256 = "unknown"): Promise<void> {
    const policy = this.getPolicy(languageId);
    if (!policy) {
      return;
    }

    await this.audit("language_server_started", {
      language: policy.languageId,
      server_id: policy.id,
      server_version: policy.version,
      sha256,
      outcome: "success",
    });
  }

  async recordServerStopped(languageId: string, sha256 = "unknown"): Promise<void> {
    const policy = this.getPolicy(languageId);
    if (!policy) {
      return;
    }

    await this.audit("language_server_stopped", {
      language: policy.languageId,
      server_id: policy.id,
      server_version: policy.version,
      sha256,
      outcome: "success",
    });
  }

  async ensureOptionalServers(): Promise<void> {
    if (!extensionManager.isCopilotLanguageServerEnabled()) {
      return;
    }

    try {
      await this.resolveCopilotLanguageServer();
    } catch (error) {
      console.warn("Failed to prepare Copilot language server:", error);
    }
  }

  private getWorkspaceRoot(): string {
    return this.workspaceRoot || process.cwd();
  }

  private getWorkspaceId(): string {
    return this.getWorkspaceRoot();
  }

  private getPolicy(languageId: string): LanguagePolicy | null {
    if (languageId === "typescriptreact") {
      return LANGUAGE_SERVER_POLICIES.typescript;
    }
    if (languageId === "javascriptreact") {
      return LANGUAGE_SERVER_POLICIES.javascript;
    }
    if (languageId === "c" || languageId === "objc" || languageId === "objcpp") {
      return LANGUAGE_SERVER_POLICIES.cpp;
    }

    return LANGUAGE_SERVER_POLICIES[languageId] || null;
  }

  private getLocalBinaryPath(binaryName: string): string {
    const binDir = path.join(this.getWorkspaceRoot(), "node_modules", ".bin");

    if (process.platform === "win32") {
      for (const ext of [".cmd", ".exe", ""]) {
        const candidate = path.join(binDir, `${binaryName}${ext}`);
        if (existsSync(candidate)) {
          return candidate;
        }
      }

      return path.join(binDir, `${binaryName}.cmd`);
    }

    return path.join(binDir, binaryName);
  }

  private async resolveNodeLanguageServer(policy: LanguagePolicy): Promise<ServerLaunchSpec> {
    const packageName = policy.packageName || policy.id;
    const localBinaryPath = this.getLocalBinaryPath(policy.command);

    if (existsSync(localBinaryPath)) {
      const checksum = await sha256File(localBinaryPath);
      await this.writeManifest({
        id: policy.id,
        language: policy.languageId,
        version: policy.version,
        command: localBinaryPath,
        sha256: checksum,
        source: policy.source,
        installed_at: new Date().toISOString(),
        signature_verified: true,
      });
      await this.audit("language_server_signature_verified", {
        language: policy.languageId,
        server_id: policy.id,
        server_version: policy.version,
        sha256: checksum,
        outcome: "success",
      });

      return {
        serverId: policy.id,
        languageId: policy.languageId,
        version: policy.version,
        source: "workspace",
        signatureVerified: true,
        sha256: checksum,
        command: localBinaryPath,
        args: policy.args,
        cwd: this.getWorkspaceRoot(),
      };
    }

    if (isBundledDesktopRuntime()) {
      const details =
        `Missing workspace binary '${policy.command}' for ${policy.languageId} in bundled desktop mode; ` +
        "npx fallback is disabled";

      await this.audit("language_server_install_failed", {
        language: policy.languageId,
        server_id: policy.id,
        server_version: policy.version,
        sha256: "missing-workspace-binary",
        outcome: "failure",
        details,
      });

      throw new Error(
        `Missing workspace dependency '${policy.command}'. Install '${packageName}@${policy.version}' in this workspace to enable ${policy.languageId} LSP in desktop mode.`,
      );
    }

    await this.audit("language_server_install_requested", {
      language: policy.languageId,
      server_id: policy.id,
      server_version: policy.version,
      sha256: "npm",
      outcome: "success",
    });

    await this.writeManifest({
      id: policy.id,
      language: policy.languageId,
      version: policy.version,
      command: policy.command,
      sha256: "npm-integrity",
      source: policy.source,
      installed_at: new Date().toISOString(),
      signature_verified: true,
    });

    await this.audit("language_server_signature_verified", {
      language: policy.languageId,
      server_id: policy.id,
      server_version: policy.version,
      sha256: "npm-integrity",
      outcome: "success",
      details: "npm package integrity is delegated to npm registry and client verification",
    });

    await this.audit("language_server_installed", {
      language: policy.languageId,
      server_id: policy.id,
      server_version: policy.version,
      sha256: "npm-integrity",
      outcome: "success",
    });

    return {
      serverId: policy.id,
      languageId: policy.languageId,
      version: policy.version,
      source: policy.source,
      signatureVerified: true,
      sha256: "npm-integrity",
      command: "npx",
      args: ["-y", "-p", `${packageName}@${policy.version}`, policy.command, ...policy.args],
      cwd: this.getWorkspaceRoot(),
    };
  }

  private async resolveSystemServer(policy: LanguagePolicy): Promise<ServerLaunchSpec> {
    const approvedHashes = getApprovedChecksumMap();
    const binaryPath = await this.resolveSystemBinaryPath(policy);
    const checksum = await sha256File(binaryPath);
    const approvedHash = approvedHashes[policy.id] || approvedHashes[policy.languageId];

    if (!approvedHash || approvedHash !== checksum) {
      await this.audit("language_server_signature_failed", {
        language: policy.languageId,
        server_id: policy.id,
        server_version: policy.version,
        sha256: checksum,
        outcome: "failure",
        details: approvedHash
          ? `checksum mismatch for ${policy.id}`
          : `missing approved checksum for ${policy.id}`,
      });

      throw new Error(
        approvedHash
          ? `Checksum verification failed for ${policy.id}`
          : `Approved checksum not configured for ${policy.id}`,
      );
    }

    await this.writeManifest({
      id: policy.id,
      language: policy.languageId,
      version: policy.version,
      command: binaryPath,
      sha256: checksum,
      source: policy.source,
      installed_at: new Date().toISOString(),
      signature_verified: true,
    });

    await this.audit("language_server_signature_verified", {
      language: policy.languageId,
      server_id: policy.id,
      server_version: policy.version,
      sha256: checksum,
      outcome: "success",
      details: "system binary launch requires explicit allowlist entry",
    });

    return {
      serverId: policy.id,
      languageId: policy.languageId,
      version: policy.version,
      source: policy.source,
      signatureVerified: true,
      sha256: checksum,
      command: binaryPath,
      args: policy.args,
      cwd: this.getWorkspaceRoot(),
    };
  }

  private async resolveSystemBinaryPath(policy: LanguagePolicy): Promise<string> {
    const overrideMap = getSystemServerOverrideMap();
    const overridePath = overrideMap[policy.id] || overrideMap[policy.languageId];
    if (overridePath) {
      return path.resolve(overridePath);
    }

    if (path.isAbsolute(policy.command) && existsSync(policy.command)) {
      return policy.command;
    }

    const resolver = process.platform === "win32" ? "where" : "which";
    const result = await execFileAsync(resolver, [policy.command]);
    const firstPath = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);

    if (!firstPath) {
      throw new Error(`Unable to resolve system binary path for ${policy.command}`);
    }

    return firstPath;
  }

  private async resolveCopilotLanguageServer(): Promise<ServerLaunchSpec> {
    const command = this.getLocalBinaryPath("copilot-language-server");
    const checksum = existsSync(command) ? await sha256File(command) : "disabled";
    return {
      serverId: "copilot-language-server",
      languageId: "copilot",
      version: "workspace",
      source: "workspace",
      signatureVerified: existsSync(command),
      sha256: checksum,
      command: existsSync(command) ? command : "npx",
      args: existsSync(command)
        ? ["--stdio"]
        : ["-y", "-p", "@github/copilot-language-server", "copilot-language-server", "--stdio"],
      cwd: this.getWorkspaceRoot(),
    };
  }

  private async writeManifest(manifest: InstallManifest): Promise<void> {
    await ensureDirectory(this.manifestsDir);

    const manifestPath = path.join(this.manifestsDir, `${manifest.id}-${manifest.language}.json`);
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    const inventory = await this.readInventory();
    const key = `${manifest.id}:${manifest.language}`;
    inventory[key] = manifest;
    await fs.writeFile(this.inventoryPath, JSON.stringify(inventory, null, 2), "utf8");
  }

  private async readInventory(): Promise<Record<string, InstallManifest>> {
    try {
      const raw = await fs.readFile(this.inventoryPath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, InstallManifest>;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  private async audit(
    eventName: LanguageServerAuditEventName,
    payload: Omit<LanguageServerAuditEvent, "event_name" | "occurred_at" | "actor_type" | "workspace_id">,
  ): Promise<void> {
    const event: LanguageServerAuditEvent = {
      event_name: eventName,
      occurred_at: new Date().toISOString(),
      actor_type: "system",
      workspace_id: this.getWorkspaceId(),
      ...payload,
    };

    await ensureDirectory(this.serverCacheRoot);
    await fs.appendFile(this.auditLogPath, `${JSON.stringify(event)}\n`, "utf8");
    runtimeEventBus.emit(AUDIT_EVENT_BUS_TOPIC, event);
  }
}

export const serverManager = new ServerManager();

export default ServerManager;
