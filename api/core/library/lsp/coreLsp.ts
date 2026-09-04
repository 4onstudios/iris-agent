/**
 * Core LSP manager for language intelligence.
 * Connects to language servers via JSON-RPC 2.0 and delegates server startup
 * to the shared server manager.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { EventEmitter } from "events";
import fs from "fs/promises";
import path from "path";
import { pathToFileURL } from "url";
import { serverManager } from "./serverManager";
import type {
  JsonRpcId,
  LspMessage,
  LspPosition,
  LspSemanticLegend,
  LspSemanticTokensResult,
  PendingRequestHandlers,
} from "./protocol";

class LSPClient extends EventEmitter {
  process: ChildProcessWithoutNullStreams;
  languageId: string;
  rootPath: string | null;
  messageId: number;
  pendingRequests: Map<JsonRpcId, PendingRequestHandlers>;
  buffer: Buffer;
  initialized: boolean;
  semanticLegend: LspSemanticLegend | null;
  textDocumentSyncKind: 0 | 1 | 2;

  constructor(
    serverProcess: ChildProcessWithoutNullStreams,
    languageId: string,
    rootPath: string | null = null,
  ) {
    super();
    this.process = serverProcess;
    this.languageId = languageId;
    this.rootPath = rootPath;
    this.messageId = 0;
    this.pendingRequests = new Map();
    this.buffer = Buffer.alloc(0);
    this.initialized = false;
    this.semanticLegend = null;
    this.textDocumentSyncKind = 1;

    this.setupProcessHandlers();
  }

  setupProcessHandlers() {
    this.process.stdout.on("data", (data) => {
      this.buffer = Buffer.concat([this.buffer, data as Buffer]);
      this.processBuffer();
    });

    this.process.stderr.on("data", (data) => {
      console.error(`LSP ${this.languageId} stderr:`, data.toString());
    });

    this.process.on("exit", (code) => {
      console.log(`LSP ${this.languageId} exited with code ${code}`);
      this.rejectAllPendingRequests(new Error(`LSP ${this.languageId} exited`));
      this.emit("exit", code);
    });

    this.process.on("error", (error) => {
      console.error(`LSP ${this.languageId} process error:`, error);
      this.rejectAllPendingRequests(error);
      // Only emit the reserved EventEmitter "error" event when a listener exists,
      // otherwise Node treats it as an unhandled exception and crashes the process.
      if (this.listenerCount("error") > 0) {
        this.emit("error", error);
      }
    });
  }

  private rejectAllPendingRequests(error: Error) {
    for (const [id, handlers] of this.pendingRequests.entries()) {
      this.pendingRequests.delete(id);
      handlers.reject(error);
    }
  }

  processBuffer() {
    const headerDelimiter = Buffer.from("\r\n\r\n");

    for (;;) {
      const headerEnd = this.buffer.indexOf(headerDelimiter);
      if (headerEnd === -1) break;

      const headers = this.buffer.subarray(0, headerEnd).toString("utf8");
      const contentLengthMatch = headers.match(/Content-Length:\s*(\d+)/i);

      if (!contentLengthMatch) {
        console.error("No Content-Length header found");
        this.buffer = this.buffer.subarray(headerEnd + headerDelimiter.length);
        continue;
      }

      const contentLength = Number.parseInt(contentLengthMatch[1] || "0", 10);
      const messageStart = headerEnd + headerDelimiter.length;

      if (this.buffer.length < messageStart + contentLength) {
        break;
      }

      const messageBytes = this.buffer.subarray(messageStart, messageStart + contentLength);
      const messageStr = messageBytes.toString("utf8");
      this.buffer = this.buffer.subarray(messageStart + contentLength);

      try {
        const message = JSON.parse(messageStr);
        this.handleMessage(message);
      } catch (error) {
        console.error("Failed to parse LSP message:", error);
      }
    }
  }

  handleMessage(message: LspMessage) {
    if (message.id !== undefined && this.pendingRequests.has(message.id)) {
      const handlers = this.pendingRequests.get(message.id);
      if (!handlers) {
        return;
      }

      const { resolve, reject } = handlers;
      this.pendingRequests.delete(message.id);

      if (message.error) {
        reject(new Error(message.error.message || "LSP request failed"));
      } else {
        resolve(message.result);
      }
    } else if (message.method && message.id !== undefined) {
      this.handleServerRequest(message);
    } else if (message.method) {
      this.emit("notification", message);
    }
  }

  private writeMessage(payload: Record<string, unknown>) {
    const messageStr = JSON.stringify(payload);
    const messageBuffer = Buffer.from(messageStr, "utf8");
    const headers = Buffer.from(
      `Content-Length: ${messageBuffer.byteLength}\r\n\r\n`,
      "utf8",
    );

    this.process.stdin.write(Buffer.concat([headers, messageBuffer]));
  }

  private sendResponse(id: JsonRpcId, result: unknown) {
    this.writeMessage({
      jsonrpc: "2.0",
      id,
      result,
    });
  }

  private sendErrorResponse(id: JsonRpcId, code: number, message: string) {
    this.writeMessage({
      jsonrpc: "2.0",
      id,
      error: {
        code,
        message,
      },
    });
  }

  private handleServerRequest(message: LspMessage) {
    const method = message.method;
    const id = message.id;
    if (id === undefined || !method) {
      return;
    }

    // Keep compatibility with common server requests even if the editor does not
    // consume their results yet.
    if (method === "workspace/applyEdit") {
      this.sendResponse(id, { applied: false });
      return;
    }

    if (method === "window/workDoneProgress/create") {
      this.sendResponse(id, null);
      return;
    }

    if (method === "workspace/configuration") {
      const items = Array.isArray((message as { params?: { items?: unknown[] } }).params?.items)
        ? ((message as { params?: { items?: unknown[] } }).params?.items as unknown[])
        : [];
      this.sendResponse(id, items.map(() => ({})));
      return;
    }

    if (method === "client/registerCapability" || method === "client/unregisterCapability") {
      this.sendResponse(id, null);
      return;
    }

    if (method === "window/showMessageRequest") {
      const actions = Array.isArray((message as { params?: { actions?: Array<{ title?: string }> } }).params?.actions)
        ? ((message as { params?: { actions?: Array<{ title?: string }> } }).params?.actions as Array<{ title?: string }>)
        : [];
      this.sendResponse(id, actions.find((action) => typeof action.title === "string") || null);
      return;
    }

    if (method === "workspace/workspaceFolders") {
      const rootUri = this.rootPath ? pathToFileURL(this.rootPath).toString() : undefined;
      this.sendResponse(id, rootUri ? [{ uri: rootUri, name: "workspace" }] : []);
      return;
    }

    if (method === "window/showDocument") {
      this.sendResponse(id, { success: false });
      return;
    }

    if (
      method === "workspace/diagnostic/refresh" ||
      method === "workspace/codeLens/refresh" ||
      method === "workspace/inlayHint/refresh" ||
      method === "workspace/inlineValue/refresh" ||
      method === "workspace/semanticTokens/refresh"
    ) {
      this.sendResponse(id, null);
      return;
    }

    this.sendErrorResponse(id, -32601, `Method not found: ${method}`);
  }

  sendRequest(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++this.messageId;
      this.writeMessage({
        jsonrpc: "2.0",
        id,
        method,
        params,
      });

      this.pendingRequests.set(id, { resolve, reject });

      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error("LSP request timeout"));
        }
      }, 30000);
    });
  }

  sendNotification(method: string, params: unknown) {
    this.writeMessage({
      jsonrpc: "2.0",
      method,
      params,
    });
  }

  async initialize(rootUri: string, capabilities: Record<string, unknown> = {}) {
    const result = await this.sendRequest("initialize", {
      processId: process.pid,
      rootUri,
      capabilities: {
          window: { workDoneProgress: true },
        textDocument: {
          hover: { contentFormat: ["plaintext", "markdown"] },
          completion: { completionItem: { snippetSupport: true } },
          definition: { linkSupport: true },
          references: {},
          documentSymbol: {},
          codeAction: {
            codeActionLiteralSupport: {
              codeActionKind: {
                valueSet: ["quickfix", "refactor", "source"],
              },
            },
          },
          rename: { prepareSupport: true },
          formatting: {},
          rangeFormatting: {},
          onTypeFormatting: {},
          declaration: { linkSupport: true },
          typeDefinition: { linkSupport: true },
          implementation: { linkSupport: true },
          documentHighlight: {},
          moniker: {},
          foldingRange: {},
          selectionRange: {},
          documentLink: {},
          linkedEditingRange: {},
          colorProvider: {},
          callHierarchy: { dynamicRegistration: false },
          typeHierarchy: { dynamicRegistration: false },
          inlayHint: { dynamicRegistration: false },
          inlineValue: { dynamicRegistration: false },
          signatureHelp: {
            signatureInformation: {
              documentationFormat: ["plaintext", "markdown"],
            },
          },
          semanticTokens: {
            dynamicRegistration: false,
            requests: { full: true, range: true, delta: true },
            tokenTypes: [
              "namespace",
              "type",
              "class",
              "enum",
              "interface",
              "struct",
              "typeParameter",
              "parameter",
              "variable",
              "property",
              "enumMember",
              "event",
              "function",
              "method",
              "macro",
              "keyword",
              "modifier",
              "comment",
              "string",
              "number",
              "regexp",
              "operator",
              "decorator",
            ],
            tokenModifiers: [
              "declaration",
              "definition",
              "readonly",
              "static",
              "deprecated",
              "abstract",
              "async",
              "modification",
              "documentation",
              "defaultLibrary",
              "local",
            ],
            formats: ["relative"],
            overlappingTokenSupport: false,
            multilineTokenSupport: false,
          },
          ...capabilities,
        },
        workspace: {
          configuration: true,
          symbol: {},
          executeCommand: {},
          didChangeConfiguration: { dynamicRegistration: true },
          didChangeWatchedFiles: { dynamicRegistration: true },
          fileOperations: {
            willCreate: true,
            didCreate: true,
            willRename: true,
            didRename: true,
            willDelete: true,
            didDelete: true,
          },
        },
      },
    });

    const capabilitiesResult = result as {
      capabilities?: {
        semanticTokensProvider?: { legend?: LspSemanticLegend };
        textDocumentSync?:
          | number
          | {
              change?: number;
            };
      };
    };

    const semanticProvider = capabilitiesResult?.capabilities?.semanticTokensProvider;

    if (semanticProvider?.legend?.tokenTypes && semanticProvider?.legend?.tokenModifiers) {
      this.semanticLegend = {
        tokenTypes: semanticProvider.legend.tokenTypes,
        tokenModifiers: semanticProvider.legend.tokenModifiers,
      };
    }

    const textDocumentSync = capabilitiesResult?.capabilities?.textDocumentSync;
    if (typeof textDocumentSync === "number") {
      this.textDocumentSyncKind = textDocumentSync === 2 ? 2 : 1;
    } else if (typeof textDocumentSync?.change === "number") {
      this.textDocumentSyncKind = textDocumentSync.change === 2 ? 2 : 1;
    }

    this.sendNotification("initialized", {});
    this.initialized = true;

    return result;
  }

  async openDocument(uri: string, languageId: string, version: number, text: string) {
    this.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId, version, text },
    });
  }

  async closeDocument(uri: string) {
    this.sendNotification("textDocument/didClose", {
      textDocument: { uri },
    });
  }

  async changeDocument(
    uri: string,
    version: number,
    text: string,
    range?: {
      start: LspPosition;
      end: LspPosition;
    },
  ) {
    const contentChanges =
      this.textDocumentSyncKind === 2 && range
        ? [{ range, text }]
        : [{ text }];

    this.sendNotification("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges,
    });
  }

  async saveDocument(uri: string, text?: string) {
    this.sendNotification("textDocument/didSave", {
      textDocument: { uri },
      ...(typeof text === "string" ? { text } : {}),
    });
  }

  willSaveDocument(uri: string, reason = 1) {
    this.sendNotification("textDocument/willSave", {
      textDocument: { uri },
      reason,
    });
  }

  async didChangeWorkspaceFolders(
    added: Array<{ uri: string; name: string }>,
    removed: Array<{ uri: string; name: string }>,
  ) {
    this.sendNotification("workspace/didChangeWorkspaceFolders", {
      event: { added, removed },
    });
  }

  async didChangeConfiguration(settings: Record<string, unknown>) {
    this.sendNotification("workspace/didChangeConfiguration", {
      settings,
    });
  }

  async didChangeWatchedFiles(changes: Array<{ uri: string; type: 1 | 2 | 3 }>) {
    this.sendNotification("workspace/didChangeWatchedFiles", {
      changes,
    });
  }

  async willCreateFiles(files: Array<{ uri: string }>) {
    return this.sendRequest("workspace/willCreateFiles", {
      files,
    });
  }

  async didCreateFiles(files: Array<{ uri: string }>) {
    this.sendNotification("workspace/didCreateFiles", {
      files,
    });
  }

  async willRenameFiles(files: Array<{ oldUri: string; newUri: string }>) {
    return this.sendRequest("workspace/willRenameFiles", {
      files,
    });
  }

  async didRenameFiles(files: Array<{ oldUri: string; newUri: string }>) {
    this.sendNotification("workspace/didRenameFiles", {
      files,
    });
  }

  async willDeleteFiles(files: Array<{ uri: string }>) {
    return this.sendRequest("workspace/willDeleteFiles", {
      files,
    });
  }

  async didDeleteFiles(files: Array<{ uri: string }>) {
    this.sendNotification("workspace/didDeleteFiles", {
      files,
    });
  }

  async getHover(uri: string, position: LspPosition) {
    return this.sendRequest("textDocument/hover", {
      textDocument: { uri },
      position,
    });
  }

  async getDefinition(uri: string, position: LspPosition) {
    return this.sendRequest("textDocument/definition", {
      textDocument: { uri },
      position,
    });
  }

  async getDeclaration(uri: string, position: LspPosition) {
    return this.sendRequest("textDocument/declaration", {
      textDocument: { uri },
      position,
    });
  }

  async getTypeDefinition(uri: string, position: LspPosition) {
    return this.sendRequest("textDocument/typeDefinition", {
      textDocument: { uri },
      position,
    });
  }

  async getImplementation(uri: string, position: LspPosition) {
    return this.sendRequest("textDocument/implementation", {
      textDocument: { uri },
      position,
    });
  }

  async getReferences(uri: string, position: LspPosition, includeDeclaration = true) {
    return this.sendRequest("textDocument/references", {
      textDocument: { uri },
      position,
      context: { includeDeclaration },
    });
  }

  async getDocumentHighlight(uri: string, position: LspPosition) {
    return this.sendRequest("textDocument/documentHighlight", {
      textDocument: { uri },
      position,
    });
  }

  async getMoniker(uri: string, position: LspPosition) {
    return this.sendRequest("textDocument/moniker", {
      textDocument: { uri },
      position,
    });
  }

  async getCompletion(uri: string, position: LspPosition) {
    return this.sendRequest("textDocument/completion", {
      textDocument: { uri },
      position,
    });
  }

  async resolveCompletionItem(item: Record<string, unknown>) {
    return this.sendRequest("completionItem/resolve", item);
  }

  async getDocumentSymbols(uri: string) {
    return this.sendRequest("textDocument/documentSymbol", {
      textDocument: { uri },
    });
  }

  async getFoldingRange(uri: string) {
    return this.sendRequest("textDocument/foldingRange", {
      textDocument: { uri },
    });
  }

  async getSelectionRange(uri: string, positions: LspPosition[]) {
    return this.sendRequest("textDocument/selectionRange", {
      textDocument: { uri },
      positions,
    });
  }

  async getDocumentLinks(uri: string) {
    return this.sendRequest("textDocument/documentLink", {
      textDocument: { uri },
    });
  }

  async resolveDocumentLink(link: Record<string, unknown>) {
    return this.sendRequest("documentLink/resolve", link);
  }

  async getCodeLens(uri: string) {
    return this.sendRequest("textDocument/codeLens", {
      textDocument: { uri },
    });
  }

  async resolveCodeLens(codeLens: Record<string, unknown>) {
    return this.sendRequest("codeLens/resolve", codeLens);
  }

  async getLinkedEditingRange(uri: string, position: LspPosition) {
    return this.sendRequest("textDocument/linkedEditingRange", {
      textDocument: { uri },
      position,
    });
  }

  async getDocumentColors(uri: string) {
    return this.sendRequest("textDocument/documentColor", {
      textDocument: { uri },
    });
  }

  async getColorPresentations(
    uri: string,
    color: unknown,
    range: { start: LspPosition; end: LspPosition },
  ) {
    return this.sendRequest("textDocument/colorPresentation", {
      textDocument: { uri },
      color,
      range,
    });
  }

  async prepareCallHierarchy(uri: string, position: LspPosition) {
    return this.sendRequest("textDocument/prepareCallHierarchy", {
      textDocument: { uri },
      position,
    });
  }

  async prepareTypeHierarchy(uri: string, position: LspPosition) {
    return this.sendRequest("textDocument/prepareTypeHierarchy", {
      textDocument: { uri },
      position,
    });
  }

  async getIncomingCalls(item: Record<string, unknown>) {
    return this.sendRequest("callHierarchy/incomingCalls", {
      item,
    });
  }

  async getOutgoingCalls(item: Record<string, unknown>) {
    return this.sendRequest("callHierarchy/outgoingCalls", {
      item,
    });
  }

  async getTypeHierarchySupertypes(item: Record<string, unknown>) {
    return this.sendRequest("typeHierarchy/supertypes", {
      item,
    });
  }

  async getTypeHierarchySubtypes(item: Record<string, unknown>) {
    return this.sendRequest("typeHierarchy/subtypes", {
      item,
    });
  }

  async getInlayHints(
    uri: string,
    range: { start: LspPosition; end: LspPosition },
  ) {
    return this.sendRequest("textDocument/inlayHint", {
      textDocument: { uri },
      range,
    });
  }

  async getInlineValues(
    uri: string,
    range: { start: LspPosition; end: LspPosition },
    context: { frameId?: number; stoppedLocation?: { start: LspPosition; end: LspPosition } } = {},
  ) {
    return this.sendRequest("textDocument/inlineValue", {
      textDocument: { uri },
      range,
      context,
    });
  }

  async getInlineCompletion(
    uri: string,
    position: LspPosition,
    context: Record<string, unknown> = {},
  ) {
    return this.sendRequest("textDocument/inlineCompletion", {
      textDocument: { uri },
      position,
      context,
    });
  }

  async resolveInlineCompletionItem(item: Record<string, unknown>) {
    return this.sendRequest("inlineCompletionItem/resolve", item);
  }

  async getSemanticTokens(uri: string) {
    return this.sendRequest("textDocument/semanticTokens/full", {
      textDocument: { uri },
    });
  }

  async getSemanticTokensRange(
    uri: string,
    range: { start: LspPosition; end: LspPosition },
  ) {
    return this.sendRequest("textDocument/semanticTokens/range", {
      textDocument: { uri },
      range,
    });
  }

  async getSemanticTokensDelta(uri: string, previousResultId: string) {
    return this.sendRequest("textDocument/semanticTokens/full/delta", {
      textDocument: { uri },
      previousResultId,
    });
  }

  async getCodeActions(
    uri: string,
    range: { start: LspPosition; end: LspPosition },
    context: { diagnostics?: unknown[]; only?: string[]; triggerKind?: number } = {},
  ) {
    return this.sendRequest("textDocument/codeAction", {
      textDocument: { uri },
      range,
      context,
    });
  }

  async resolveCodeAction(action: Record<string, unknown>) {
    return this.sendRequest("codeAction/resolve", action);
  }

  async rename(uri: string, position: LspPosition, newName: string) {
    return this.sendRequest("textDocument/rename", {
      textDocument: { uri },
      position,
      newName,
    });
  }

  async prepareRename(uri: string, position: LspPosition) {
    return this.sendRequest("textDocument/prepareRename", {
      textDocument: { uri },
      position,
    });
  }

  async formatting(
    uri: string,
    options: {
      tabSize: number;
      insertSpaces: boolean;
      trimTrailingWhitespace?: boolean;
      insertFinalNewline?: boolean;
      trimFinalNewlines?: boolean;
    },
  ) {
    return this.sendRequest("textDocument/formatting", {
      textDocument: { uri },
      options,
    });
  }

  async rangeFormatting(
    uri: string,
    range: { start: LspPosition; end: LspPosition },
    options: {
      tabSize: number;
      insertSpaces: boolean;
      trimTrailingWhitespace?: boolean;
      insertFinalNewline?: boolean;
      trimFinalNewlines?: boolean;
    },
  ) {
    return this.sendRequest("textDocument/rangeFormatting", {
      textDocument: { uri },
      range,
      options,
    });
  }

  async onTypeFormatting(
    uri: string,
    position: LspPosition,
    ch: string,
    options: {
      tabSize: number;
      insertSpaces: boolean;
      trimTrailingWhitespace?: boolean;
      insertFinalNewline?: boolean;
      trimFinalNewlines?: boolean;
    },
  ) {
    return this.sendRequest("textDocument/onTypeFormatting", {
      textDocument: { uri },
      position,
      ch,
      options,
    });
  }

  async workspaceSymbol(query: string) {
    return this.sendRequest("workspace/symbol", {
      query,
    });
  }

  async resolveWorkspaceSymbol(symbol: Record<string, unknown>) {
    return this.sendRequest("workspaceSymbol/resolve", symbol);
  }

  async resolveInlayHint(hint: Record<string, unknown>) {
    return this.sendRequest("inlayHint/resolve", hint);
  }

  async willSaveWaitUntil(uri: string, reason = 1) {
    return this.sendRequest("textDocument/willSaveWaitUntil", {
      textDocument: { uri },
      reason,
    });
  }

  async executeCommand(command: string, argumentsList: unknown[] = []) {
    return this.sendRequest("workspace/executeCommand", {
      command,
      arguments: argumentsList,
    });
  }

  async signatureHelp(uri: string, position: LspPosition) {
    return this.sendRequest("textDocument/signatureHelp", {
      textDocument: { uri },
      position,
    });
  }

  async shutdown() {
    await this.sendRequest("shutdown", {});
    this.sendNotification("exit", {});
  }

  kill() {
    this.process.kill();
  }
}

type LspDiagnostic = {
  range?: {
    start?: LspPosition;
    end?: LspPosition;
  };
  severity?: number;
  code?: string | number;
  source?: string;
  message?: string;
};

type LspDiagnosticsPayload = {
  uri?: string;
  diagnostics?: LspDiagnostic[];
};

type LspDocumentDiagnosticReport = {
  kind?: string;
  resultId?: string;
  items?: LspDiagnostic[];
};

type LspWorkspaceDiagnosticReportResult = {
  items?: Array<{
    uri?: string;
    version?: number | null;
    kind?: string;
    resultId?: string;
    items?: LspDiagnostic[];
  }>;
};

class CoreLsp extends EventEmitter {
  private servers: Map<string, LSPClient>;
  // In-flight spawns, keyed by languageId. Prevents concurrent callers (e.g. the
  // semantic-tokens route firing while a file is opened) from each starting a
  // separate language server during cold start.
  private pendingSpawns: Map<string, Promise<LSPClient | null>>;
  // Languages whose server failed to start (missing binary, bad config). Cleared
  // on workspace-root change so a newly installed server is picked up.
  private unavailableLanguages: Set<string>;
  // Incremented on every workspace-root change. A spawn captures the generation
  // it started under; if that no longer matches when it completes, the spawn
  // belongs to a stale root and its client must be discarded rather than
  // registered — clearing `pendingSpawns` alone cannot cancel work already
  // in flight.
  private spawnGeneration: number;
  private rootPath: string | null;
  private documentVersions: Map<string, number>;
  private openDocumentLanguages: Map<string, string>;
  private lastDocumentText: Map<string, string>;
  private diagnosticsByUri: Map<string, LspDiagnostic[]>;
  private documentDiagnosticResultIds: Map<string, string>;
  private workspaceDiagnosticResultIds: Map<string, string>;
  private semanticTokenSnapshots: Map<string, { data: number[]; resultId: string; languageId: string }>;

  constructor() {
    super();
    this.servers = new Map();
    this.pendingSpawns = new Map();
    this.unavailableLanguages = new Set();
    this.spawnGeneration = 0;
    this.rootPath = null;
    this.documentVersions = new Map();
    this.openDocumentLanguages = new Map();
    this.lastDocumentText = new Map();
    this.diagnosticsByUri = new Map();
    this.documentDiagnosticResultIds = new Map();
    this.workspaceDiagnosticResultIds = new Map();
    this.semanticTokenSnapshots = new Map();
  }

  connect(rootPath: string | null) {
    const nextRootPath = rootPath ? path.resolve(rootPath) : null;
    const currentRootPath = this.rootPath ? path.resolve(this.rootPath) : null;

    if (currentRootPath && currentRootPath !== nextRootPath) {
      this.resetServersForRootChange();
    }

    this.rootPath = nextRootPath;
    serverManager.setWorkspaceRoot(nextRootPath);
  }

  setRootPath(rootPath: string | null) {
    this.connect(rootPath);
  }

  private resetServersForRootChange() {
    // Invalidate any spawn already in flight for the previous root. Clearing
    // `pendingSpawns` only drops our handle on those promises; they keep
    // running and would otherwise register a server against the old root.
    this.spawnGeneration += 1;

    this.servers.forEach((client) => {
      try {
        client.kill();
      } catch {
        // Ignore process cleanup failures while switching workspaces.
      }
    });

    this.servers.clear();
    this.pendingSpawns.clear();
    this.unavailableLanguages.clear();
    this.documentVersions.clear();
    this.openDocumentLanguages.clear();
    this.lastDocumentText.clear();
    this.diagnosticsByUri.clear();
    this.documentDiagnosticResultIds.clear();
    this.workspaceDiagnosticResultIds.clear();
    this.semanticTokenSnapshots.clear();
  }

  getLanguageId(filePath: string): string | null {
    const ext = path.extname(filePath).toLowerCase();
    const languageMap: Record<string, string> = {
      ".js": "javascript",
      ".jsx": "javascriptreact",
      ".ts": "typescript",
      ".tsx": "typescriptreact",
      ".py": "python",
      ".java": "java",
      ".cpp": "cpp",
      ".c": "c",
      ".go": "go",
      ".rs": "rust",
      ".gd": "gdscript",
      ".gdshader": "gdscript",
      ".rb": "ruby",
      ".php": "php",
    };
    return languageMap[ext] || null;
  }

  async spawnServer(languageId: string): Promise<LSPClient | null> {
    if (this.servers.has(languageId)) {
      return this.servers.get(languageId) ?? null;
    }

    // A previous spawn already failed for this language (e.g. the language
    // server binary is not installed in this workspace). Retrying cannot
    // succeed until the workspace root changes, and without this guard every
    // request re-attempts the spawn and floods stderr.
    if (this.unavailableLanguages.has(languageId)) {
      return null;
    }

    const pending = this.pendingSpawns.get(languageId);
    if (pending) {
      return pending;
    }

    const generation = this.spawnGeneration;
    const spawnPromise = this.spawnServerUncached(languageId, generation)
      .then((client) => {
        // The workspace root changed while this spawn was in flight, so the
        // result belongs to a root we no longer track. Tear it down instead of
        // recording it against the current workspace.
        if (generation !== this.spawnGeneration) {
          if (client) {
            try {
              client.kill();
            } catch {
              // Ignore cleanup failures for an already-discarded client.
            }
          }
          return null;
        }

        if (!client) {
          this.unavailableLanguages.add(languageId);
        }
        return client;
      })
      .catch((error) => {
        if (generation === this.spawnGeneration) {
          this.unavailableLanguages.add(languageId);
        }
        throw error;
      })
      .finally(() => {
        // Only retract the entry we installed; a newer generation may have
        // already stored its own pending spawn under this language.
        if (this.pendingSpawns.get(languageId) === spawnPromise) {
          this.pendingSpawns.delete(languageId);
        }
      });
    this.pendingSpawns.set(languageId, spawnPromise);
    return spawnPromise;
  }

  isLanguageUnavailable(languageId: string): boolean {
    return this.unavailableLanguages.has(languageId);
  }

  private async spawnServerUncached(
    languageId: string,
    generation: number,
  ): Promise<LSPClient | null> {
    try {
      const launchSpec = await serverManager.resolveLaunchSpec(languageId);

      if (!launchSpec) {
        console.warn(`No LSP server configured for language: ${languageId}`);
        return null;
      }

      // `resolveLaunchSpec` awaits, so the root may have changed already. Bail
      // out before spawning a process that would target the stale workspace.
      if (generation !== this.spawnGeneration) {
        return null;
      }

      const serverProcess = spawn(launchSpec.command, launchSpec.args, {
        cwd: launchSpec.cwd || this.rootPath || process.cwd(),
        stdio: ["pipe", "pipe", "pipe"],
      });

      const client = new LSPClient(serverProcess, languageId, this.rootPath || process.cwd());
      const rootUri = pathToFileURL(this.rootPath || process.cwd()).toString();
      await client.initialize(rootUri);
      await serverManager.recordServerStarted(languageId, launchSpec.sha256);

      // Initialization and bookkeeping are the long poles here; re-check
      // immediately before publishing so a root change during either await
      // cannot leave a server registered against the previous workspace.
      if (generation !== this.spawnGeneration) {
        try {
          client.kill();
        } catch {
          // Ignore cleanup failures for a client we are discarding.
        }
        return null;
      }

      client.on("notification", (message: LspMessage & { params?: unknown }) => {
        if (message.method !== "textDocument/publishDiagnostics") {
          return;
        }

        const payload = message.params as LspDiagnosticsPayload | undefined;
        if (!payload?.uri) {
          return;
        }

        const diagnostics = Array.isArray(payload.diagnostics) ? payload.diagnostics : [];
        this.diagnosticsByUri.set(payload.uri, diagnostics);
        this.emit("diagnostics", {
          languageId,
          uri: payload.uri,
          diagnostics,
        });
      });

      this.servers.set(languageId, client);
      client.on("exit", () => {
        void serverManager.recordServerStopped(languageId, launchSpec.sha256);
      });
      return client;
    } catch (error) {
      const err = error as Error;
      console.error(`Failed to start LSP server for ${languageId}:`, err.message);
      return null;
    }
  }

  async getClientForFile(filePath: string): Promise<LSPClient | null> {
    const languageId = this.getLanguageId(filePath);
    if (!languageId) {
      return null;
    }

    let client: LSPClient | null = this.servers.get(languageId) ?? null;
    if (!client) {
      client = await this.spawnServer(languageId);
    }

    return client;
  }

  async getClientForLanguage(languageId: string): Promise<LSPClient | null> {
    let client: LSPClient | null = this.servers.get(languageId) ?? null;
    if (!client) {
      client = await this.spawnServer(languageId);
    }

    return client;
  }

  private async ensureDocumentSynced(filePath: string, text?: string): Promise<{
    client: LSPClient;
    uri: string;
    languageId: string;
  } | null> {
    const languageId = this.getLanguageId(filePath);
    if (!languageId) {
      return null;
    }

    const client = await this.getClientForLanguage(languageId);
    if (!client || !client.initialized) {
      return null;
    }

    const uri = pathToFileURL(path.resolve(filePath)).toString();

    let currentText = text;
    if (typeof currentText !== "string") {
      try {
        currentText = await fs.readFile(filePath, "utf8");
      } catch {
        return null;
      }
    }

    const currentVersion = this.documentVersions.get(uri) ?? 0;
    const previousText = this.lastDocumentText.get(uri);

    if (currentVersion === 0) {
      await client.openDocument(uri, languageId, 1, currentText);
      this.documentVersions.set(uri, 1);
      this.openDocumentLanguages.set(uri, languageId);
      this.lastDocumentText.set(uri, currentText);
      return { client, uri, languageId };
    }

    if (previousText !== currentText) {
      const nextVersion = currentVersion + 1;
      await client.changeDocument(uri, nextVersion, currentText);
      this.documentVersions.set(uri, nextVersion);
      this.lastDocumentText.set(uri, currentText);
    }

    return { client, uri, languageId };
  }

  async openDocument(filePath: string, text?: string) {
    const languageId = this.getLanguageId(filePath);
    if (!languageId) {
      return false;
    }

    const client = await this.getClientForLanguage(languageId);
    if (!client || !client.initialized) {
      return false;
    }

    const uri = pathToFileURL(path.resolve(filePath)).toString();
    let docText = text;
    if (typeof docText !== "string") {
      docText = await fs.readFile(filePath, "utf8");
    }

    await client.openDocument(uri, languageId, 1, docText);
    this.documentVersions.set(uri, 1);
    this.openDocumentLanguages.set(uri, languageId);
    this.lastDocumentText.set(uri, docText);
    return true;
  }

  async changeDocument(filePath: string, text: string) {
    const synced = await this.ensureDocumentSynced(filePath);
    if (!synced) {
      return false;
    }

    const currentVersion = this.documentVersions.get(synced.uri) ?? 1;
    const nextVersion = currentVersion + 1;
    await synced.client.changeDocument(synced.uri, nextVersion, text);
    this.documentVersions.set(synced.uri, nextVersion);
    this.lastDocumentText.set(synced.uri, text);
    return true;
  }

  async saveDocument(filePath: string) {
    const synced = await this.ensureDocumentSynced(filePath);
    if (!synced) {
      return false;
    }

    const text = this.lastDocumentText.get(synced.uri);
    await synced.client.saveDocument(synced.uri, text);
    return true;
  }

  async closeDocument(filePath: string) {
    const languageId = this.getLanguageId(filePath);
    if (!languageId) {
      return false;
    }

    const client = await this.getClientForLanguage(languageId);
    if (!client || !client.initialized) {
      return false;
    }

    const uri = pathToFileURL(path.resolve(filePath)).toString();
    await client.closeDocument(uri);
    this.documentVersions.delete(uri);
    this.openDocumentLanguages.delete(uri);
    this.lastDocumentText.delete(uri);
    this.diagnosticsByUri.delete(uri);
    return true;
  }

  async didChangeConfiguration(settings: Record<string, unknown>) {
    const calls = Array.from(this.servers.values()).map((client) =>
      client.didChangeConfiguration(settings),
    );
    await Promise.all(calls);
  }

  willSaveDocument(filePath: string, reason = 1) {
    const uri = pathToFileURL(path.resolve(filePath)).toString();
    for (const client of this.servers.values()) {
      if (client.initialized && this.openDocumentLanguages.has(uri)) {
        client.willSaveDocument(uri, reason);
      }
    }
  }

  async didChangeWorkspaceFolders(
    added: Array<{ uri: string; name: string }>,
    removed: Array<{ uri: string; name: string }>,
  ) {
    const calls = Array.from(this.servers.values()).map((client) =>
      client.didChangeWorkspaceFolders(added, removed),
    );
    await Promise.all(calls);
  }

  async didChangeWatchedFiles(changes: Array<{ filePath: string; type: 1 | 2 | 3 }>) {
    const byLanguage = new Map<string, Array<{ uri: string; type: 1 | 2 | 3 }>>();

    for (const change of changes) {
      const languageId = this.getLanguageId(change.filePath);
      if (!languageId) {
        continue;
      }

      if (!byLanguage.has(languageId)) {
        byLanguage.set(languageId, []);
      }

      byLanguage.get(languageId)?.push({
        uri: pathToFileURL(path.resolve(change.filePath)).toString(),
        type: change.type,
      });
    }

    const calls: Promise<void>[] = [];
    for (const [languageId, languageChanges] of byLanguage.entries()) {
      const client = await this.getClientForLanguage(languageId);
      if (!client || !client.initialized || languageChanges.length === 0) {
        continue;
      }

      calls.push(client.didChangeWatchedFiles(languageChanges));
    }

    await Promise.all(calls);
  }

  async willCreateFiles(filePaths: string[]) {
    const byLanguage = new Map<string, Array<{ uri: string }>>();

    for (const filePath of filePaths) {
      const languageId = this.getLanguageId(filePath);
      if (!languageId) {
        continue;
      }

      if (!byLanguage.has(languageId)) {
        byLanguage.set(languageId, []);
      }

      byLanguage.get(languageId)?.push({
        uri: pathToFileURL(path.resolve(filePath)).toString(),
      });
    }

    const results: unknown[] = [];
    for (const [languageId, files] of byLanguage.entries()) {
      const client = await this.getClientForLanguage(languageId);
      if (!client || !client.initialized || files.length === 0) {
        continue;
      }

      results.push(await client.willCreateFiles(files));
    }

    return results;
  }

  async didCreateFiles(filePaths: string[]) {
    const byLanguage = new Map<string, Array<{ uri: string }>>();

    for (const filePath of filePaths) {
      const languageId = this.getLanguageId(filePath);
      if (!languageId) {
        continue;
      }

      if (!byLanguage.has(languageId)) {
        byLanguage.set(languageId, []);
      }

      byLanguage.get(languageId)?.push({
        uri: pathToFileURL(path.resolve(filePath)).toString(),
      });
    }

    const calls: Promise<void>[] = [];
    for (const [languageId, files] of byLanguage.entries()) {
      const client = await this.getClientForLanguage(languageId);
      if (!client || !client.initialized || files.length === 0) {
        continue;
      }

      calls.push(client.didCreateFiles(files));
    }

    await Promise.all(calls);
  }

  async willRenameFiles(changes: Array<{ oldFilePath: string; newFilePath: string }>) {
    const byLanguage = new Map<string, Array<{ oldUri: string; newUri: string }>>();

    for (const change of changes) {
      const languageId = this.getLanguageId(change.newFilePath) || this.getLanguageId(change.oldFilePath);
      if (!languageId) {
        continue;
      }

      if (!byLanguage.has(languageId)) {
        byLanguage.set(languageId, []);
      }

      byLanguage.get(languageId)?.push({
        oldUri: pathToFileURL(path.resolve(change.oldFilePath)).toString(),
        newUri: pathToFileURL(path.resolve(change.newFilePath)).toString(),
      });
    }

    const results: unknown[] = [];
    for (const [languageId, files] of byLanguage.entries()) {
      const client = await this.getClientForLanguage(languageId);
      if (!client || !client.initialized || files.length === 0) {
        continue;
      }

      results.push(await client.willRenameFiles(files));
    }

    return results;
  }

  async didRenameFiles(changes: Array<{ oldFilePath: string; newFilePath: string }>) {
    const byLanguage = new Map<string, Array<{ oldUri: string; newUri: string }>>();

    for (const change of changes) {
      const languageId = this.getLanguageId(change.newFilePath) || this.getLanguageId(change.oldFilePath);
      if (!languageId) {
        continue;
      }

      if (!byLanguage.has(languageId)) {
        byLanguage.set(languageId, []);
      }

      byLanguage.get(languageId)?.push({
        oldUri: pathToFileURL(path.resolve(change.oldFilePath)).toString(),
        newUri: pathToFileURL(path.resolve(change.newFilePath)).toString(),
      });
    }

    const calls: Promise<void>[] = [];
    for (const [languageId, files] of byLanguage.entries()) {
      const client = await this.getClientForLanguage(languageId);
      if (!client || !client.initialized || files.length === 0) {
        continue;
      }

      calls.push(client.didRenameFiles(files));
    }

    await Promise.all(calls);
  }

  async willDeleteFiles(filePaths: string[]) {
    const byLanguage = new Map<string, Array<{ uri: string }>>();

    for (const filePath of filePaths) {
      const languageId = this.getLanguageId(filePath);
      if (!languageId) {
        continue;
      }

      if (!byLanguage.has(languageId)) {
        byLanguage.set(languageId, []);
      }

      byLanguage.get(languageId)?.push({
        uri: pathToFileURL(path.resolve(filePath)).toString(),
      });
    }

    const results: unknown[] = [];
    for (const [languageId, files] of byLanguage.entries()) {
      const client = await this.getClientForLanguage(languageId);
      if (!client || !client.initialized || files.length === 0) {
        continue;
      }

      results.push(await client.willDeleteFiles(files));
    }

    return results;
  }

  async didDeleteFiles(filePaths: string[]) {
    const byLanguage = new Map<string, Array<{ uri: string }>>();

    for (const filePath of filePaths) {
      const languageId = this.getLanguageId(filePath);
      if (!languageId) {
        continue;
      }

      if (!byLanguage.has(languageId)) {
        byLanguage.set(languageId, []);
      }

      byLanguage.get(languageId)?.push({
        uri: pathToFileURL(path.resolve(filePath)).toString(),
      });
    }

    const calls: Promise<void>[] = [];
    for (const [languageId, files] of byLanguage.entries()) {
      const client = await this.getClientForLanguage(languageId);
      if (!client || !client.initialized || files.length === 0) {
        continue;
      }

      calls.push(client.didDeleteFiles(files));
    }

    await Promise.all(calls);
  }

  onDiagnostics(listener: (event: { languageId: string; uri: string; diagnostics: LspDiagnostic[] }) => void): () => void {
    this.on("diagnostics", listener);
    return () => {
      this.off("diagnostics", listener);
    };
  }

  getDiagnosticsForFile(filePath: string): LspDiagnostic[] {
    const uri = pathToFileURL(path.resolve(filePath)).toString();
    return this.diagnosticsByUri.get(uri) ?? [];
  }

  async getPullDiagnosticsForFile(filePath: string) {
    const synced = await this.ensureDocumentSynced(filePath);
    if (!synced) {
      return null;
    }

    const previousResultId = this.documentDiagnosticResultIds.get(synced.uri);

    try {
      const result = await synced.client.sendRequest("textDocument/diagnostic", {
        textDocument: { uri: synced.uri },
        previousResultId,
      }) as LspDocumentDiagnosticReport | null;

      if (!result || (result.kind !== "full" && result.kind !== "unchanged")) {
        return null;
      }

      if (typeof result.resultId === "string") {
        this.documentDiagnosticResultIds.set(synced.uri, result.resultId);
      }

      if (Array.isArray(result.items)) {
        this.diagnosticsByUri.set(synced.uri, result.items);
      }

      return {
        kind: result.kind || "full",
        resultId: typeof result.resultId === "string" ? result.resultId : null,
        items: Array.isArray(result.items) ? result.items : [],
      };
    } catch (error) {
      console.error("LSP pull diagnostics (document) failed:", (error as Error).message);
      return null;
    }
  }

  async getWorkspacePullDiagnostics(languageId?: string) {
    const resolvedLanguageId =
      typeof languageId === "string" && languageId.trim().length > 0
        ? languageId
        : (this.openDocumentLanguages.values().next().value as string | undefined);

    if (!resolvedLanguageId) {
      return null;
    }

    const client = await this.getClientForLanguage(resolvedLanguageId);
    if (!client || !client.initialized) {
      return null;
    }

    const previousResultIds = Array.from(this.workspaceDiagnosticResultIds.entries()).map(
      ([uri, resultId]) => ({ uri, value: resultId }),
    );

    try {
      const result = await client.sendRequest("workspace/diagnostic", {
        previousResultIds,
      }) as LspWorkspaceDiagnosticReportResult | null;

      if (!result || !Array.isArray(result.items)) {
        return null;
      }

      result.items.forEach((item) => {
        if (typeof item?.uri !== "string") {
          return;
        }

        if (typeof item.resultId === "string") {
          this.workspaceDiagnosticResultIds.set(item.uri, item.resultId);
        }

        if (Array.isArray(item.items)) {
          this.diagnosticsByUri.set(item.uri, item.items);
        }
      });

      return result;
    } catch (error) {
      console.error("LSP pull diagnostics (workspace) failed:", (error as Error).message);
      return null;
    }
  }

  toPosition(line: number, character: number): LspPosition {
    return {
      line: line - 1,
      character: character - 1,
    };
  }

  async getHover(filePath: string, line: number, character: number) {
    const synced = await this.ensureDocumentSynced(filePath);
    if (!synced) {
      return null;
    }

    try {
      return await synced.client.getHover(synced.uri, this.toPosition(line, character));
    } catch (error) {
      console.error("LSP hover failed:", (error as Error).message);
      return null;
    }
  }

  async getDefinition(filePath: string, line: number, character: number, text?: string) {
    const synced = await this.ensureDocumentSynced(filePath, text);
    if (!synced) {
      return null;
    }

    try {
      return await synced.client.getDefinition(synced.uri, this.toPosition(line, character));
    } catch (error) {
      console.error("LSP definition failed:", (error as Error).message);
      return null;
    }
  }

  async getDeclaration(filePath: string, line: number, character: number, text?: string) {
    const synced = await this.ensureDocumentSynced(filePath, text);
    if (!synced) {
      return null;
    }

    try {
      return await synced.client.getDeclaration(synced.uri, this.toPosition(line, character));
    } catch (error) {
      const err = error as Error;
      const message = err.message || "";

      if (/Unhandled method|Method not found|not supported/i.test(message)) {
        try {
          const fallbackDefinition = await synced.client.getDefinition(
            synced.uri,
            this.toPosition(line, character),
          );
          if (fallbackDefinition) {
            return fallbackDefinition;
          }

          return await synced.client.getTypeDefinition(
            synced.uri,
            this.toPosition(line, character),
          );
        } catch (fallbackError) {
          console.error("LSP declaration fallback failed:", (fallbackError as Error).message);
          return null;
        }
      }

      console.error("LSP declaration failed:", message);
      return null;
    }
  }

  async getTypeDefinition(filePath: string, line: number, character: number) {
    const synced = await this.ensureDocumentSynced(filePath);
    if (!synced) {
      return null;
    }

    try {
      return await synced.client.getTypeDefinition(synced.uri, this.toPosition(line, character));
    } catch (error) {
      console.error("LSP type definition failed:", (error as Error).message);
      return null;
    }
  }

  async getImplementation(filePath: string, line: number, character: number) {
    const synced = await this.ensureDocumentSynced(filePath);
    if (!synced) {
      return null;
    }

    try {
      return await synced.client.getImplementation(synced.uri, this.toPosition(line, character));
    } catch (error) {
      console.error("LSP implementation failed:", (error as Error).message);
      return null;
    }
  }

  async getReferences(filePath: string, line: number, character: number, includeDeclaration = true) {
    const synced = await this.ensureDocumentSynced(filePath);
    if (!synced) {
      return null;
    }

    try {
      return await synced.client.getReferences(
        synced.uri,
        this.toPosition(line, character),
        includeDeclaration,
      );
    } catch (error) {
      console.error("LSP references failed:", (error as Error).message);
      return null;
    }
  }

  async getDocumentHighlight(filePath: string, line: number, character: number) {
    const synced = await this.ensureDocumentSynced(filePath);
    if (!synced) {
      return null;
    }

    try {
      return await synced.client.getDocumentHighlight(synced.uri, this.toPosition(line, character));
    } catch (error) {
      console.error("LSP document highlight failed:", (error as Error).message);
      return null;
    }
  }

  async getMoniker(filePath: string, line: number, character: number) {
    const synced = await this.ensureDocumentSynced(filePath);
    if (!synced) {
      return null;
    }

    try {
      return await synced.client.getMoniker(synced.uri, this.toPosition(line, character));
    } catch (error) {
      console.error("LSP moniker failed:", (error as Error).message);
      return null;
    }
  }

  async getDocumentSymbols(filePath: string) {
    const synced = await this.ensureDocumentSynced(filePath);
    if (!synced) {
      return null;
    }

    try {
      return await synced.client.getDocumentSymbols(synced.uri);
    } catch (error) {
      console.error("LSP document symbols failed:", (error as Error).message);
      return null;
    }
  }

  async getCodeLens(filePath: string) {
    const synced = await this.ensureDocumentSynced(filePath);
    if (!synced) {
      return null;
    }

    try {
      return await synced.client.getCodeLens(synced.uri);
    } catch (error) {
      console.error("LSP code lens failed:", (error as Error).message);
      return null;
    }
  }

  async getFoldingRange(filePath: string) {
    const synced = await this.ensureDocumentSynced(filePath);
    if (!synced) {
      return null;
    }

    try {
      return await synced.client.getFoldingRange(synced.uri);
    } catch (error) {
      console.error("LSP folding range failed:", (error as Error).message);
      return null;
    }
  }

  async getSelectionRange(filePath: string, line: number, character: number) {
    const synced = await this.ensureDocumentSynced(filePath);
    if (!synced) {
      return null;
    }

    try {
      return await synced.client.getSelectionRange(synced.uri, [this.toPosition(line, character)]);
    } catch (error) {
      console.error("LSP selection range failed:", (error as Error).message);
      return null;
    }
  }

  async getDocumentLinks(filePath: string) {
    const synced = await this.ensureDocumentSynced(filePath);
    if (!synced) {
      return null;
    }

    try {
      return await synced.client.getDocumentLinks(synced.uri);
    } catch (error) {
      console.error("LSP document links failed:", (error as Error).message);
      return null;
    }
  }

  async getLinkedEditingRange(filePath: string, line: number, character: number) {
    const synced = await this.ensureDocumentSynced(filePath);
    if (!synced) {
      return null;
    }

    try {
      return await synced.client.getLinkedEditingRange(synced.uri, this.toPosition(line, character));
    } catch (error) {
      console.error("LSP linked editing range failed:", (error as Error).message);
      return null;
    }
  }

  async getDocumentColors(filePath: string) {
    const synced = await this.ensureDocumentSynced(filePath);
    if (!synced) {
      return null;
    }

    try {
      return await synced.client.getDocumentColors(synced.uri);
    } catch (error) {
      console.error("LSP document colors failed:", (error as Error).message);
      return null;
    }
  }

  async getColorPresentations(
    filePath: string,
    color: unknown,
    startLine: number,
    startCharacter: number,
    endLine: number,
    endCharacter: number,
  ) {
    const synced = await this.ensureDocumentSynced(filePath);
    if (!synced) {
      return null;
    }

    try {
      return await synced.client.getColorPresentations(
        synced.uri,
        color,
        {
          start: this.toPosition(startLine, startCharacter),
          end: this.toPosition(endLine, endCharacter),
        },
      );
    } catch (error) {
      console.error("LSP color presentations failed:", (error as Error).message);
      return null;
    }
  }

  async prepareCallHierarchy(filePath: string, line: number, character: number) {
    const synced = await this.ensureDocumentSynced(filePath);
    if (!synced) {
      return null;
    }

    try {
      return await synced.client.prepareCallHierarchy(
        synced.uri,
        this.toPosition(line, character),
      );
    } catch (error) {
      console.error("LSP call hierarchy prepare failed:", (error as Error).message);
      return null;
    }
  }

  async prepareTypeHierarchy(filePath: string, line: number, character: number) {
    const synced = await this.ensureDocumentSynced(filePath);
    if (!synced) {
      return null;
    }

    try {
      return await synced.client.prepareTypeHierarchy(
        synced.uri,
        this.toPosition(line, character),
      );
    } catch (error) {
      console.error("LSP type hierarchy prepare failed:", (error as Error).message);
      return null;
    }
  }

  async getIncomingCalls(item: Record<string, unknown>) {
    const uri = typeof item?.uri === "string" ? item.uri : "";
    const languageId = uri.startsWith("file://")
      ? this.getLanguageId(uri.replace("file://", ""))
      : null;
    if (!languageId) {
      return null;
    }

    const client = await this.getClientForLanguage(languageId);
    if (!client || !client.initialized) {
      return null;
    }

    try {
      return await client.getIncomingCalls(item);
    } catch (error) {
      console.error("LSP incoming calls failed:", (error as Error).message);
      return null;
    }
  }

  async getOutgoingCalls(item: Record<string, unknown>) {
    const uri = typeof item?.uri === "string" ? item.uri : "";
    const languageId = uri.startsWith("file://")
      ? this.getLanguageId(uri.replace("file://", ""))
      : null;
    if (!languageId) {
      return null;
    }

    const client = await this.getClientForLanguage(languageId);
    if (!client || !client.initialized) {
      return null;
    }

    try {
      return await client.getOutgoingCalls(item);
    } catch (error) {
      console.error("LSP outgoing calls failed:", (error as Error).message);
      return null;
    }
  }

  async getTypeHierarchySupertypes(item: Record<string, unknown>) {
    const uri = typeof item?.uri === "string" ? item.uri : "";
    const languageId = uri.startsWith("file://")
      ? this.getLanguageId(uri.replace("file://", ""))
      : null;
    if (!languageId) {
      return null;
    }

    const client = await this.getClientForLanguage(languageId);
    if (!client || !client.initialized) {
      return null;
    }

    try {
      return await client.getTypeHierarchySupertypes(item);
    } catch (error) {
      console.error("LSP type hierarchy supertypes failed:", (error as Error).message);
      return null;
    }
  }

  async getTypeHierarchySubtypes(item: Record<string, unknown>) {
    const uri = typeof item?.uri === "string" ? item.uri : "";
    const languageId = uri.startsWith("file://")
      ? this.getLanguageId(uri.replace("file://", ""))
      : null;
    if (!languageId) {
      return null;
    }

    const client = await this.getClientForLanguage(languageId);
    if (!client || !client.initialized) {
      return null;
    }

    try {
      return await client.getTypeHierarchySubtypes(item);
    } catch (error) {
      console.error("LSP type hierarchy subtypes failed:", (error as Error).message);
      return null;
    }
  }

  async getInlayHints(
    filePath: string,
    startLine: number,
    startCharacter: number,
    endLine: number,
    endCharacter: number,
  ) {
    const synced = await this.ensureDocumentSynced(filePath);
    if (!synced) {
      return null;
    }

    try {
      return await synced.client.getInlayHints(synced.uri, {
        start: this.toPosition(startLine, startCharacter),
        end: this.toPosition(endLine, endCharacter),
      });
    } catch (error) {
      console.error("LSP inlay hint failed:", (error as Error).message);
      return null;
    }
  }

  async getInlineValues(
    filePath: string,
    range: { start: LspPosition; end: LspPosition },
    context: { frameId?: number; stoppedLocation?: { start: LspPosition; end: LspPosition } } = {},
  ) {
    const synced = await this.ensureDocumentSynced(filePath);
    if (!synced) {
      return null;
    }

    try {
      return await synced.client.getInlineValues(synced.uri, range, context);
    } catch (error) {
      console.error("LSP inline value failed:", (error as Error).message);
      return null;
    }
  }

  async getInlineCompletion(
    filePath: string,
    line: number,
    character: number,
    context: Record<string, unknown> = {},
  ) {
    const synced = await this.ensureDocumentSynced(filePath);
    if (!synced) {
      return null;
    }

    try {
      return await synced.client.getInlineCompletion(
        synced.uri,
        this.toPosition(line, character),
        context,
      );
    } catch (error) {
      console.error("LSP inline completion failed:", (error as Error).message);
      return null;
    }
  }

  async resolveInlineCompletionItem(item: Record<string, unknown>, languageId?: string, filePath?: string) {
    const client = await this.getClientForResolve(languageId, filePath);
    if (!client) {
      return null;
    }

    try {
      return await client.resolveInlineCompletionItem(item);
    } catch (error) {
      console.error("LSP inline completion resolve failed:", (error as Error).message);
      return null;
    }
  }

  async getCompletion(filePath: string, line: number, character: number) {
    const synced = await this.ensureDocumentSynced(filePath);
    if (!synced) {
      return null;
    }

    try {
      return await synced.client.getCompletion(synced.uri, this.toPosition(line, character));
    } catch (error) {
      console.error("LSP completion failed:", (error as Error).message);
      return null;
    }
  }

  async resolveCompletionItem(item: Record<string, unknown>, languageId?: string, filePath?: string) {
    const client = await this.getClientForResolve(languageId, filePath);
    if (!client) {
      return null;
    }

    try {
      return await client.resolveCompletionItem(item);
    } catch (error) {
      console.error("LSP completion resolve failed:", (error as Error).message);
      return null;
    }
  }

  async resolveCodeAction(action: Record<string, unknown>, languageId?: string, filePath?: string) {
    const client = await this.getClientForResolve(languageId, filePath);
    if (!client) {
      return null;
    }

    try {
      return await client.resolveCodeAction(action);
    } catch (error) {
      console.error("LSP code action resolve failed:", (error as Error).message);
      return null;
    }
  }

  async resolveCodeLens(codeLens: Record<string, unknown>, languageId?: string, filePath?: string) {
    const client = await this.getClientForResolve(languageId, filePath);
    if (!client) {
      return null;
    }

    try {
      return await client.resolveCodeLens(codeLens);
    } catch (error) {
      console.error("LSP code lens resolve failed:", (error as Error).message);
      return null;
    }
  }

  async resolveDocumentLink(link: Record<string, unknown>, languageId?: string, filePath?: string) {
    const client = await this.getClientForResolve(languageId, filePath);
    if (!client) {
      return null;
    }

    try {
      return await client.resolveDocumentLink(link);
    } catch (error) {
      console.error("LSP document link resolve failed:", (error as Error).message);
      return null;
    }
  }

  async resolveWorkspaceSymbol(symbol: Record<string, unknown>, languageId?: string) {
    const client = await this.getClientForResolve(languageId);
    if (!client) {
      return null;
    }

    try {
      return await client.resolveWorkspaceSymbol(symbol);
    } catch (error) {
      console.error("LSP workspace symbol resolve failed:", (error as Error).message);
      return null;
    }
  }

  async resolveInlayHint(hint: Record<string, unknown>, languageId?: string, filePath?: string) {
    const client = await this.getClientForResolve(languageId, filePath);
    if (!client) {
      return null;
    }

    try {
      return await client.resolveInlayHint(hint);
    } catch (error) {
      console.error("LSP inlay hint resolve failed:", (error as Error).message);
      return null;
    }
  }

  async getSemanticTokensForCode(filePath: string, languageId: string, code: string) {
    const client = await this.getClientForLanguage(languageId);
    if (!client || !client.initialized || !client.semanticLegend) {
      return null;
    }

    const uri = pathToFileURL(path.resolve(filePath)).toString();

    try {
      await client.openDocument(uri, languageId, 1, code);
      const result = (await client.getSemanticTokens(uri)) as LspSemanticTokensResult | null;

      return {
        data: Array.isArray(result?.data) ? result.data : [],
        legend: client.semanticLegend,
        languageId,
      };
    } catch (error) {
      console.warn("LSP semantic tokens failed:", (error as Error).message);
      return null;
    } finally {
      try {
        await client.closeDocument(uri);
      } catch {
        // Ignore close errors for transient semantic-token requests.
      }
    }
  }

  async getSemanticTokensRange(
    filePath: string,
    startLine: number,
    startCharacter: number,
    endLine: number,
    endCharacter: number,
  ) {
    const synced = await this.ensureDocumentSynced(filePath);
    if (!synced || !synced.client.semanticLegend) {
      return null;
    }

    try {
      const result = (await synced.client.getSemanticTokensRange(synced.uri, {
        start: this.toPosition(startLine, startCharacter),
        end: this.toPosition(endLine, endCharacter),
      })) as LspSemanticTokensResult | null;

      return {
        data: Array.isArray(result?.data) ? result.data : [],
        legend: synced.client.semanticLegend,
        languageId: synced.languageId,
      };
    } catch (error) {
      console.warn("LSP semantic tokens range failed:", (error as Error).message);
      return null;
    }
  }

  async getSemanticTokensFull(filePath: string) {
    const synced = await this.ensureDocumentSynced(filePath);
    if (!synced || !synced.client.semanticLegend) {
      return null;
    }

    try {
      const result = (await synced.client.getSemanticTokens(synced.uri)) as LspSemanticTokensResult | null;
      const fullData = Array.isArray(result?.data) ? result.data : [];
      const resultId = typeof result?.resultId === "string" ? result.resultId : "0";
      this.semanticTokenSnapshots.set(synced.uri, { data: fullData, resultId, languageId: synced.languageId });

      return {
        data: fullData,
        resultId,
        legend: synced.client.semanticLegend,
        languageId: synced.languageId,
      };
    } catch (error) {
      console.warn("LSP semantic tokens full failed:", (error as Error).message);
      return null;
    }
  }

  async getSemanticTokensDocumentDelta(filePath: string, previousResultId?: string) {
    const synced = await this.ensureDocumentSynced(filePath);
    if (!synced || !synced.client.semanticLegend) {
      return null;
    }

    try {
      const priorSnapshot = this.semanticTokenSnapshots.get(synced.uri);
      const effectivePreviousResultId = previousResultId || priorSnapshot?.resultId || "0";

      const result =
        effectivePreviousResultId === "0"
          ? (await synced.client.getSemanticTokens(synced.uri)) as LspSemanticTokensResult | null
          : (await synced.client.getSemanticTokensDelta(synced.uri, effectivePreviousResultId)) as
              | {
                  resultId?: string;
                  edits?: Array<{ start: number; deleteCount: number; data?: number[] }>;
                  data?: number[];
                }
              | null;

      const fullData = Array.isArray((result as LspSemanticTokensResult | null)?.data)
        ? ((result as LspSemanticTokensResult | null)?.data as number[])
        : [];

      if (Array.isArray((result as { edits?: unknown[] } | null)?.edits)) {
        const deltaResult = result as {
          resultId?: string;
          edits?: Array<{ start: number; deleteCount: number; data?: number[] }>;
        };
        const nextResultId = typeof deltaResult.resultId === "string" ? deltaResult.resultId : effectivePreviousResultId;
        this.semanticTokenSnapshots.set(synced.uri, {
          data: fullData,
          resultId: nextResultId,
          languageId: synced.languageId,
        });

        return {
          data: fullData,
          resultId: nextResultId,
          edits: deltaResult.edits || [],
          legend: synced.client.semanticLegend,
          languageId: synced.languageId,
        };
      }

      const nextResultId = typeof (result as { resultId?: string } | null)?.resultId === "string"
        ? ((result as { resultId?: string }).resultId as string)
        : effectivePreviousResultId;
      this.semanticTokenSnapshots.set(synced.uri, {
        data: fullData,
        resultId: nextResultId,
        languageId: synced.languageId,
      });

      return {
        data: fullData,
        resultId: nextResultId,
        edits: [],
        legend: synced.client.semanticLegend,
        languageId: synced.languageId,
      };
    } catch (error) {
      console.warn("LSP semantic tokens delta failed:", (error as Error).message);
      return null;
    }
  }

  async getSemanticTokensDelta(
    filePath: string,
    languageId: string,
    code: string,
    previousResultId?: string,
  ) {
    const client = await this.getClientForLanguage(languageId);
    if (!client || !client.initialized || !client.semanticLegend) {
      return null;
    }

    const uri = pathToFileURL(path.resolve(filePath)).toString();

    try {
      await client.openDocument(uri, languageId, 1, code);

      const priorSnapshot = this.semanticTokenSnapshots.get(uri);
      const effectivePreviousResultId = previousResultId || priorSnapshot?.resultId || "0";

      const result =
        effectivePreviousResultId === "0"
          ? (await client.getSemanticTokens(uri)) as LspSemanticTokensResult | null
          : (await client.getSemanticTokensDelta(uri, effectivePreviousResultId)) as
              | {
                  resultId?: string;
                  edits?: Array<{ start: number; deleteCount: number; data?: number[] }>;
                }
              | null;

      const fullData = Array.isArray((result as LspSemanticTokensResult | null)?.data)
        ? ((result as LspSemanticTokensResult | null)?.data as number[])
        : [];

      if (Array.isArray((result as { edits?: unknown[] } | null)?.edits)) {
        const deltaResult = result as {
          resultId?: string;
          edits?: Array<{ start: number; deleteCount: number; data?: number[] }>;
        };
        const nextResultId = typeof deltaResult.resultId === "string" ? deltaResult.resultId : effectivePreviousResultId;
        this.semanticTokenSnapshots.set(uri, { data: fullData, resultId: nextResultId, languageId });

        return {
          data: fullData,
          resultId: nextResultId,
          edits: deltaResult.edits || [],
          legend: client.semanticLegend,
          languageId,
        };
      }

      const nextResultId = typeof (result as { resultId?: string } | null)?.resultId === "string"
        ? ((result as { resultId?: string }).resultId as string)
        : effectivePreviousResultId;
      this.semanticTokenSnapshots.set(uri, { data: fullData, resultId: nextResultId, languageId });

      return {
        data: fullData,
        resultId: nextResultId,
        edits: [],
        legend: client.semanticLegend,
        languageId,
      };
    } catch (error) {
      console.warn("LSP semantic tokens delta failed:", (error as Error).message);
      return null;
    } finally {
      try {
        await client.closeDocument(uri);
      } catch {
        // Ignore close errors for transient semantic-token requests.
      }
    }
  }

  async getCodeActions(
    filePath: string,
    startLine: number,
    startCharacter: number,
    endLine: number,
    endCharacter: number,
    context: { diagnostics?: unknown[]; only?: string[]; triggerKind?: number } = {},
  ) {
    const synced = await this.ensureDocumentSynced(filePath);
    if (!synced) {
      return null;
    }

    return synced.client.getCodeActions(
      synced.uri,
      {
        start: this.toPosition(startLine, startCharacter),
        end: this.toPosition(endLine, endCharacter),
      },
      context,
    );
  }

  async renameSymbol(filePath: string, line: number, character: number, newName: string) {
    const synced = await this.ensureDocumentSynced(filePath);
    if (!synced) {
      return null;
    }

    return synced.client.rename(synced.uri, this.toPosition(line, character), newName);
  }

  async prepareRename(filePath: string, line: number, character: number) {
    const synced = await this.ensureDocumentSynced(filePath);
    if (!synced) {
      return null;
    }

    return synced.client.prepareRename(synced.uri, this.toPosition(line, character));
  }

  async formatDocument(
    filePath: string,
    options: {
      tabSize: number;
      insertSpaces: boolean;
      trimTrailingWhitespace?: boolean;
      insertFinalNewline?: boolean;
      trimFinalNewlines?: boolean;
    },
  ) {
    const synced = await this.ensureDocumentSynced(filePath);
    if (!synced) {
      return null;
    }

    return synced.client.formatting(synced.uri, options);
  }

  async formatRange(
    filePath: string,
    startLine: number,
    startCharacter: number,
    endLine: number,
    endCharacter: number,
    options: {
      tabSize: number;
      insertSpaces: boolean;
      trimTrailingWhitespace?: boolean;
      insertFinalNewline?: boolean;
      trimFinalNewlines?: boolean;
    },
  ) {
    const synced = await this.ensureDocumentSynced(filePath);
    if (!synced) {
      return null;
    }

    return synced.client.rangeFormatting(
      synced.uri,
      {
        start: this.toPosition(startLine, startCharacter),
        end: this.toPosition(endLine, endCharacter),
      },
      options,
    );
  }

  async formatOnType(
    filePath: string,
    line: number,
    character: number,
    ch: string,
    options: {
      tabSize: number;
      insertSpaces: boolean;
      trimTrailingWhitespace?: boolean;
      insertFinalNewline?: boolean;
      trimFinalNewlines?: boolean;
    },
  ) {
    const synced = await this.ensureDocumentSynced(filePath);
    if (!synced) {
      return null;
    }

    return synced.client.onTypeFormatting(
      synced.uri,
      this.toPosition(line, character),
      ch,
      options,
    );
  }

  async getWorkspaceSymbols(query: string, languageId?: string) {
    if (languageId) {
      const client = await this.getClientForLanguage(languageId);
      if (!client || !client.initialized) {
        return null;
      }

      return client.workspaceSymbol(query);
    }

    const clients = Array.from(this.servers.values());
    const results = await Promise.all(clients.map((client) => client.workspaceSymbol(query)));
    return results.flatMap((result) => (Array.isArray(result) ? result : [result]));
  }

  async getSignatureHelp(filePath: string, line: number, character: number) {
    const synced = await this.ensureDocumentSynced(filePath);
    if (!synced) {
      return null;
    }

    return synced.client.signatureHelp(synced.uri, this.toPosition(line, character));
  }

  async executeWorkspaceCommand(
    command: string,
    args: unknown[] = [],
    languageId?: string,
    filePath?: string,
  ) {
    const client = await this.getClientForResolve(languageId, filePath);
    if (!client) {
      return null;
    }

    try {
      return await client.executeCommand(command, args);
    } catch (error) {
      console.error("LSP workspace execute command failed:", (error as Error).message);
      return null;
    }
  }

  async willSaveWaitUntil(filePath: string, reason = 1) {
    const synced = await this.ensureDocumentSynced(filePath);
    if (!synced) {
      return null;
    }

    try {
      return await synced.client.willSaveWaitUntil(synced.uri, reason);
    } catch (error) {
      console.error("LSP willSaveWaitUntil failed:", (error as Error).message);
      return null;
    }
  }

  private async getClientForResolve(languageId?: string, filePath?: string) {
    let resolvedLanguageId = languageId;
    if (!resolvedLanguageId && filePath) {
      resolvedLanguageId = this.getLanguageId(filePath) || undefined;
    }

    if (!resolvedLanguageId) {
      return null;
    }

    const client = await this.getClientForLanguage(resolvedLanguageId);
    if (!client || !client.initialized) {
      return null;
    }

    return client;
  }

  async shutdown() {
    const openDocs = Array.from(this.openDocumentLanguages.keys());
    const closePromises = openDocs.map(async (uri) => {
      const languageId = this.openDocumentLanguages.get(uri);
      if (!languageId) {
        return;
      }

      const client = this.servers.get(languageId);
      if (!client) {
        return;
      }

      try {
        await client.closeDocument(uri);
      } catch {
        // Ignore close errors during shutdown.
      }
    });
    await Promise.all(closePromises);

    const shutdownPromises = Array.from(this.servers.values()).map((client) =>
      client.shutdown().catch((err) => console.error("Shutdown error:", err)),
    );

    await Promise.all(shutdownPromises);

    this.servers.forEach((client) => {
      try {
        client.kill();
      } catch {
        // Ignore
      }
    });

    this.servers.clear();
    // Invalidate in-flight spawns for the same reason as a root change: a
    // spawn completing after shutdown would otherwise register a live server.
    this.spawnGeneration += 1;
    this.pendingSpawns.clear();
    this.unavailableLanguages.clear();
    this.documentVersions.clear();
    this.openDocumentLanguages.clear();
    this.lastDocumentText.clear();
    this.diagnosticsByUri.clear();
    this.documentDiagnosticResultIds.clear();
    this.workspaceDiagnosticResultIds.clear();
  }
}

export const coreLsp = new CoreLsp();

export default CoreLsp;
