import express from "express";
import http from "http";
import path from "path";

const mockCoreLsp = {
  setRootPath: jest.fn(),
  openDocument: jest.fn(),
  changeDocument: jest.fn(),
  saveDocument: jest.fn(),
  closeDocument: jest.fn(),
  getDiagnosticsForFile: jest.fn(),
  getPullDiagnosticsForFile: jest.fn(),
  getWorkspacePullDiagnostics: jest.fn(),
  getCodeActions: jest.fn(),
  renameSymbol: jest.fn(),
  prepareRename: jest.fn(),
  formatDocument: jest.fn(),
  formatRange: jest.fn(),
  formatOnType: jest.fn(),
  getWorkspaceSymbols: jest.fn(),
  getSignatureHelp: jest.fn(),
  getDeclaration: jest.fn(),
  getTypeDefinition: jest.fn(),
  getImplementation: jest.fn(),
  getDefinition: jest.fn(),
  getDocumentHighlight: jest.fn(),
  getMoniker: jest.fn(),
  getCompletion: jest.fn(),
  resolveCompletionItem: jest.fn(),
  getDocumentSymbols: jest.fn(),
  getCodeLens: jest.fn(),
  resolveCodeAction: jest.fn(),
  resolveCodeLens: jest.fn(),
  resolveDocumentLink: jest.fn(),
  resolveWorkspaceSymbol: jest.fn(),
  resolveInlayHint: jest.fn(),
  getInlineCompletion: jest.fn(),
  resolveInlineCompletionItem: jest.fn(),
  willSaveWaitUntil: jest.fn(),
  willSaveDocument: jest.fn(),
  didChangeWorkspaceFolders: jest.fn(),
  getFoldingRange: jest.fn(),
  getSelectionRange: jest.fn(),
  getLinkedEditingRange: jest.fn(),
  getDocumentLinks: jest.fn(),
  getDocumentColors: jest.fn(),
  getColorPresentations: jest.fn(),
  prepareCallHierarchy: jest.fn(),
  getIncomingCalls: jest.fn(),
  getOutgoingCalls: jest.fn(),
  prepareTypeHierarchy: jest.fn(),
  getTypeHierarchySupertypes: jest.fn(),
  getTypeHierarchySubtypes: jest.fn(),
  getInlayHints: jest.fn(),
  getInlineValues: jest.fn(),
  getSemanticTokensDelta: jest.fn(),
  getSemanticTokensRange: jest.fn(),
  getSemanticTokensFull: jest.fn(),
  getSemanticTokensDocumentDelta: jest.fn(),
  executeWorkspaceCommand: jest.fn(),
  didChangeConfiguration: jest.fn(),
  didChangeWatchedFiles: jest.fn(),
  willCreateFiles: jest.fn(),
  didCreateFiles: jest.fn(),
  willRenameFiles: jest.fn(),
  didRenameFiles: jest.fn(),
  willDeleteFiles: jest.fn(),
  didDeleteFiles: jest.fn(),
  getSemanticTokensForCode: jest.fn(),
};

jest.mock("../api/core/agent/index", () => ({
  createCodingAgent: jest.fn(),
  createAgentRequestContext: jest.fn((enabledSkills?: string[]) => ({ enabledSkills })),
  getSkillsList: jest.fn(async () => []),
}));

jest.mock("../api/core/library/lsp/coreLsp", () => ({
  coreLsp: mockCoreLsp,
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const agentRouter = require("../api/agent").default;

type RunningServer = {
  server: http.Server;
  baseUrl: string;
};

const postJson = async (
  baseUrl: string,
  apiPath: string,
  payload: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> => {
  const url = new URL(`${baseUrl}${apiPath}`);
  const body = JSON.stringify(payload);

  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body).toString(),
          ...headers,
        },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => {
          let parsed: unknown = {};
          try {
            parsed = text ? JSON.parse(text) : {};
          } catch {
            parsed = {};
          }

          resolve({ status: res.statusCode || 0, body: parsed });
        });
      },
    );

    req.on("error", reject);
    req.write(body);
    req.end();
  });
};

const startServer = async (): Promise<RunningServer> => {
  const app = express();
  app.use(express.json());
  app.use("/api/agent", agentRouter);

  const server = await new Promise<http.Server>((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to start test server");
  }

  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
};

const stopServer = async (server: http.Server): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
};

describe("agent LSP routes", () => {
  const originalTauriBundled = process.env.TAURI_BUNDLED;
  const originalDesktopToken = process.env.IRIS_DESKTOP_TOKEN;

  beforeEach(() => {
    process.env.TAURI_BUNDLED = "1";
    process.env.IRIS_DESKTOP_TOKEN = "desktop-secret";

    Object.values(mockCoreLsp).forEach((fn) => {
      if (typeof fn === "function") {
        (fn as jest.Mock).mockReset();
      }
    });

    mockCoreLsp.openDocument.mockResolvedValue(true);
    mockCoreLsp.changeDocument.mockResolvedValue(true);
    mockCoreLsp.saveDocument.mockResolvedValue(true);
    mockCoreLsp.closeDocument.mockResolvedValue(true);
    mockCoreLsp.getDiagnosticsForFile.mockReturnValue([]);
    mockCoreLsp.getPullDiagnosticsForFile.mockResolvedValue({
      kind: "full",
      resultId: "1",
      items: [],
    });
    mockCoreLsp.getWorkspacePullDiagnostics.mockResolvedValue({ items: [] });
    mockCoreLsp.getCodeActions.mockResolvedValue([]);
    mockCoreLsp.renameSymbol.mockResolvedValue({ changes: {} });
    mockCoreLsp.prepareRename.mockResolvedValue({
      start: { line: 1, character: 1 },
      end: { line: 1, character: 4 },
    });
    mockCoreLsp.formatDocument.mockResolvedValue([]);
    mockCoreLsp.formatRange.mockResolvedValue([]);
    mockCoreLsp.formatOnType.mockResolvedValue([]);
    mockCoreLsp.getWorkspaceSymbols.mockResolvedValue([]);
    mockCoreLsp.getSignatureHelp.mockResolvedValue(null);
    mockCoreLsp.getDeclaration.mockResolvedValue([]);
    mockCoreLsp.getTypeDefinition.mockResolvedValue([]);
    mockCoreLsp.getImplementation.mockResolvedValue([]);
    mockCoreLsp.getDefinition.mockResolvedValue([]);
    mockCoreLsp.getDocumentHighlight.mockResolvedValue([]);
    mockCoreLsp.getMoniker.mockResolvedValue([]);
    mockCoreLsp.getCompletion.mockResolvedValue({ isIncomplete: false, items: [] });
    mockCoreLsp.resolveCompletionItem.mockResolvedValue({});
    mockCoreLsp.getDocumentSymbols.mockResolvedValue([]);
    mockCoreLsp.getCodeLens.mockResolvedValue([]);
    mockCoreLsp.resolveCodeAction.mockResolvedValue({});
    mockCoreLsp.resolveCodeLens.mockResolvedValue({});
    mockCoreLsp.resolveDocumentLink.mockResolvedValue({});
    mockCoreLsp.resolveWorkspaceSymbol.mockResolvedValue({});
    mockCoreLsp.resolveInlayHint.mockResolvedValue({});
    mockCoreLsp.getInlineCompletion.mockResolvedValue({ items: [] });
    mockCoreLsp.resolveInlineCompletionItem.mockResolvedValue({});
    mockCoreLsp.willSaveWaitUntil.mockResolvedValue([]);
    mockCoreLsp.willSaveDocument.mockReturnValue(undefined);
    mockCoreLsp.didChangeWorkspaceFolders.mockResolvedValue(undefined);
    mockCoreLsp.getFoldingRange.mockResolvedValue([]);
    mockCoreLsp.getSelectionRange.mockResolvedValue([]);
    mockCoreLsp.getLinkedEditingRange.mockResolvedValue([]);
    mockCoreLsp.getDocumentLinks.mockResolvedValue([]);
    mockCoreLsp.getDocumentColors.mockResolvedValue([]);
    mockCoreLsp.getColorPresentations.mockResolvedValue([]);
    mockCoreLsp.prepareCallHierarchy.mockResolvedValue([]);
    mockCoreLsp.getIncomingCalls.mockResolvedValue([]);
    mockCoreLsp.getOutgoingCalls.mockResolvedValue([]);
    mockCoreLsp.prepareTypeHierarchy.mockResolvedValue([]);
    mockCoreLsp.getTypeHierarchySupertypes.mockResolvedValue([]);
    mockCoreLsp.getTypeHierarchySubtypes.mockResolvedValue([]);
    mockCoreLsp.getInlayHints.mockResolvedValue([]);
    mockCoreLsp.getInlineValues.mockResolvedValue([]);
    mockCoreLsp.getSemanticTokensDelta.mockResolvedValue({
      data: [],
      resultId: "0",
      edits: [],
      legend: { tokenTypes: [], tokenModifiers: [] },
      languageId: "typescript",
    });
    mockCoreLsp.getSemanticTokensRange.mockResolvedValue({
      data: [],
      legend: { tokenTypes: [], tokenModifiers: [] },
      languageId: "typescript",
    });
    mockCoreLsp.getSemanticTokensFull.mockResolvedValue({
      data: [],
      resultId: "0",
      legend: { tokenTypes: [], tokenModifiers: [] },
      languageId: "typescript",
    });
    mockCoreLsp.getSemanticTokensDocumentDelta.mockResolvedValue({
      data: [],
      resultId: "0",
      edits: [],
      legend: { tokenTypes: [], tokenModifiers: [] },
      languageId: "typescript",
    });
    mockCoreLsp.executeWorkspaceCommand.mockResolvedValue({ ok: true });
    mockCoreLsp.didChangeConfiguration.mockResolvedValue(undefined);
    mockCoreLsp.didChangeWatchedFiles.mockResolvedValue(undefined);
    mockCoreLsp.willCreateFiles.mockResolvedValue([]);
    mockCoreLsp.didCreateFiles.mockResolvedValue(undefined);
    mockCoreLsp.willRenameFiles.mockResolvedValue([]);
    mockCoreLsp.didRenameFiles.mockResolvedValue(undefined);
    mockCoreLsp.willDeleteFiles.mockResolvedValue([]);
    mockCoreLsp.didDeleteFiles.mockResolvedValue(undefined);
    mockCoreLsp.getSemanticTokensForCode.mockResolvedValue({
      data: [],
      legend: { tokenTypes: [], tokenModifiers: [] },
      languageId: "typescript",
    });
  });

  afterAll(() => {
    if (originalTauriBundled === undefined) {
      delete process.env.TAURI_BUNDLED;
    } else {
      process.env.TAURI_BUNDLED = originalTauriBundled;
    }

    if (originalDesktopToken === undefined) {
      delete process.env.IRIS_DESKTOP_TOKEN;
    } else {
      process.env.IRIS_DESKTOP_TOKEN = originalDesktopToken;
    }
  });

  it("requires desktop auth for LSP document routes", async () => {
    const { server, baseUrl } = await startServer();

    try {
      const response = await postJson(baseUrl, "/api/agent/lsp/document/open", {
        filePath: "src/example.ts",
        workspaceRoot: "/workspace",
        text: "const x = 1;",
      });

      expect(response.status).toBe(403);
      expect(mockCoreLsp.openDocument).not.toHaveBeenCalled();
    } finally {
      await stopServer(server);
    }
  });

  it("opens document with resolved path and workspace root", async () => {
    const { server, baseUrl } = await startServer();

    try {
      const response = await postJson(
        baseUrl,
        "/api/agent/lsp/document/open",
        {
          filePath: "src/example.ts",
          workspaceRoot: "/tmp/project",
          text: "const x = 1;",
        },
        { "X-Desktop-Token": "desktop-secret" },
      );

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(mockCoreLsp.setRootPath).toHaveBeenCalledWith("/tmp/project");
      expect(mockCoreLsp.openDocument).toHaveBeenCalledWith(
        path.join("/tmp/project", "src/example.ts"),
        "const x = 1;",
      );
    } finally {
      await stopServer(server);
    }
  });

  it("returns diagnostics for a file", async () => {
    mockCoreLsp.getDiagnosticsForFile.mockReturnValue([
      {
        message: "Type mismatch",
        severity: 1,
      },
    ]);

    const { server, baseUrl } = await startServer();

    try {
      const response = await postJson(
        baseUrl,
        "/api/agent/lsp/diagnostics",
        {
          filePath: "src/example.ts",
          workspaceRoot: "/tmp/project",
        },
        { "X-Desktop-Token": "desktop-secret" },
      );

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.diagnostics).toHaveLength(1);
      expect(mockCoreLsp.getDiagnosticsForFile).toHaveBeenCalledWith(
        path.join("/tmp/project", "src/example.ts"),
      );
    } finally {
      await stopServer(server);
    }
  });

  it("returns pull diagnostics for a file", async () => {
    mockCoreLsp.getPullDiagnosticsForFile.mockResolvedValue({
      kind: "full",
      resultId: "diag-1",
      items: [{ message: "Unused variable", severity: 2 }],
    });

    const { server, baseUrl } = await startServer();

    try {
      const response = await postJson(
        baseUrl,
        "/api/agent/lsp/diagnostic",
        {
          filePath: "src/example.ts",
          workspaceRoot: "/tmp/project",
        },
        { "X-Desktop-Token": "desktop-secret" },
      );

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.report.kind).toBe("full");
      expect(response.body.report.items).toHaveLength(1);
      expect(mockCoreLsp.getPullDiagnosticsForFile).toHaveBeenCalledWith(
        path.join("/tmp/project", "src/example.ts"),
      );
    } finally {
      await stopServer(server);
    }
  });

  it("returns workspace pull diagnostics", async () => {
    mockCoreLsp.getWorkspacePullDiagnostics.mockResolvedValue({
      items: [
        {
          uri: "file:///tmp/project/src/example.ts",
          kind: "full",
          resultId: "workspace-1",
          items: [{ message: "Missing return", severity: 1 }],
        },
      ],
    });

    const { server, baseUrl } = await startServer();

    try {
      const response = await postJson(
        baseUrl,
        "/api/agent/lsp/workspace-diagnostic",
        {
          workspaceRoot: "/tmp/project",
          languageId: "typescript",
        },
        { "X-Desktop-Token": "desktop-secret" },
      );

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.report.items).toHaveLength(1);
      expect(mockCoreLsp.getWorkspacePullDiagnostics).toHaveBeenCalledWith("typescript");
    } finally {
      await stopServer(server);
    }
  });

  it("notifies watched file changes", async () => {
    const { server, baseUrl } = await startServer();

    try {
      const response = await postJson(
        baseUrl,
        "/api/agent/lsp/watched-files",
        {
          workspaceRoot: "/tmp/project",
          changes: [
            { filePath: "src/a.ts", type: 2 },
            { filePath: "src/b.py", type: 1 },
          ],
        },
        { "X-Desktop-Token": "desktop-secret" },
      );

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.count).toBe(2);
      expect(mockCoreLsp.didChangeWatchedFiles).toHaveBeenCalledWith([
        { filePath: "src/a.ts", type: 2 },
        { filePath: "src/b.py", type: 1 },
      ]);
    } finally {
      await stopServer(server);
    }
  });

  it("handles workspace file operation notifications", async () => {
    mockCoreLsp.willCreateFiles.mockResolvedValue([{ changes: {} }]);
    mockCoreLsp.willRenameFiles.mockResolvedValue([{ changes: {} }]);
    mockCoreLsp.willDeleteFiles.mockResolvedValue([{ changes: {} }]);

    const { server, baseUrl } = await startServer();

    try {
      const headers = { "X-Desktop-Token": "desktop-secret" };

      const willCreate = await postJson(
        baseUrl,
        "/api/agent/lsp/will-create-files",
        {
          workspaceRoot: "/tmp/project",
          filePaths: ["src/new-file.ts"],
        },
        headers,
      );
      expect(willCreate.status).toBe(200);
      expect(willCreate.body.success).toBe(true);
      expect(mockCoreLsp.willCreateFiles).toHaveBeenCalledWith([
        path.join("/tmp/project", "src/new-file.ts"),
      ]);

      const didCreate = await postJson(
        baseUrl,
        "/api/agent/lsp/did-create-files",
        {
          workspaceRoot: "/tmp/project",
          filePaths: ["src/new-file.ts"],
        },
        headers,
      );
      expect(didCreate.status).toBe(200);
      expect(didCreate.body.success).toBe(true);
      expect(mockCoreLsp.didCreateFiles).toHaveBeenCalledWith([
        path.join("/tmp/project", "src/new-file.ts"),
      ]);

      const willRename = await postJson(
        baseUrl,
        "/api/agent/lsp/will-rename-files",
        {
          workspaceRoot: "/tmp/project",
          files: [{ oldFilePath: "src/old.ts", newFilePath: "src/new.ts" }],
        },
        headers,
      );
      expect(willRename.status).toBe(200);
      expect(willRename.body.success).toBe(true);
      expect(mockCoreLsp.willRenameFiles).toHaveBeenCalledWith([
        {
          oldFilePath: path.join("/tmp/project", "src/old.ts"),
          newFilePath: path.join("/tmp/project", "src/new.ts"),
        },
      ]);

      const didRename = await postJson(
        baseUrl,
        "/api/agent/lsp/did-rename-files",
        {
          workspaceRoot: "/tmp/project",
          files: [{ oldFilePath: "src/old.ts", newFilePath: "src/new.ts" }],
        },
        headers,
      );
      expect(didRename.status).toBe(200);
      expect(didRename.body.success).toBe(true);
      expect(mockCoreLsp.didRenameFiles).toHaveBeenCalledWith([
        {
          oldFilePath: path.join("/tmp/project", "src/old.ts"),
          newFilePath: path.join("/tmp/project", "src/new.ts"),
        },
      ]);

      const willDelete = await postJson(
        baseUrl,
        "/api/agent/lsp/will-delete-files",
        {
          workspaceRoot: "/tmp/project",
          filePaths: ["src/delete-me.ts"],
        },
        headers,
      );
      expect(willDelete.status).toBe(200);
      expect(willDelete.body.success).toBe(true);
      expect(mockCoreLsp.willDeleteFiles).toHaveBeenCalledWith([
        path.join("/tmp/project", "src/delete-me.ts"),
      ]);

      const didDelete = await postJson(
        baseUrl,
        "/api/agent/lsp/did-delete-files",
        {
          workspaceRoot: "/tmp/project",
          filePaths: ["src/delete-me.ts"],
        },
        headers,
      );
      expect(didDelete.status).toBe(200);
      expect(didDelete.body.success).toBe(true);
      expect(mockCoreLsp.didDeleteFiles).toHaveBeenCalledWith([
        path.join("/tmp/project", "src/delete-me.ts"),
      ]);
    } finally {
      await stopServer(server);
    }
  });

  it("returns semantic tokens via coreLsp", async () => {
    mockCoreLsp.getSemanticTokensForCode.mockResolvedValue({
      data: [0, 0, 5, 12, 0],
      legend: {
        tokenTypes: ["function"],
        tokenModifiers: ["declaration"],
      },
      languageId: "typescript",
    });

    const { server, baseUrl } = await startServer();

    try {
      const response = await postJson(
        baseUrl,
        "/api/agent/semantic-tokens",
        {
          code: "function test() {}",
          language: "ts",
          filePath: "src/example.ts",
          workspaceRoot: "/tmp/project",
        },
        { "X-Desktop-Token": "desktop-secret" },
      );

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data).toEqual([0, 0, 5, 12, 0]);
      expect(mockCoreLsp.setRootPath).toHaveBeenCalledWith("/tmp/project");
      expect(mockCoreLsp.getSemanticTokensForCode).toHaveBeenCalledWith(
        path.join("/tmp/project", "src/example.ts"),
        "typescript",
        "function test() {}",
      );
    } finally {
      await stopServer(server);
    }
  });

  it("rejects unsupported semantic-token language", async () => {
    const { server, baseUrl } = await startServer();

    try {
      const response = await postJson(
        baseUrl,
        "/api/agent/semantic-tokens",
        {
          code: "SELECT * FROM users",
          language: "sql",
          filePath: "queries/users.sql",
          workspaceRoot: "/tmp/project",
        },
        { "X-Desktop-Token": "desktop-secret" },
      );

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(typeof response.body.error).toBe("string");
      expect(mockCoreLsp.getSemanticTokensForCode).not.toHaveBeenCalled();
    } finally {
      await stopServer(server);
    }
  });

  it("returns declaration locations", async () => {
    mockCoreLsp.getDeclaration.mockResolvedValue([
      {
        uri: "file:///tmp/project/src/example.ts",
        range: { start: { line: 4, character: 2 } },
      },
    ]);

    const { server, baseUrl } = await startServer();

    try {
      const response = await postJson(
        baseUrl,
        "/api/agent/lsp/declaration",
        {
          filePath: "src/example.ts",
          workspaceRoot: "/tmp/project",
          line: 10,
          character: 3,
          text: "const value = 1;",
        },
        { "X-Desktop-Token": "desktop-secret" },
      );

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.locations).toEqual([
        {
          filePath: "/tmp/project/src/example.ts",
          uri: "file:///tmp/project/src/example.ts",
          line: 5,
          character: 3,
        },
      ]);
      expect(mockCoreLsp.getDeclaration).toHaveBeenCalledWith(
        path.join("/tmp/project", "src/example.ts"),
        10,
        3,
        "const value = 1;",
      );
    } finally {
      await stopServer(server);
    }
  });

  it("returns document highlights", async () => {
    mockCoreLsp.getDocumentHighlight.mockResolvedValue([
      {
        range: {
          start: { line: 1, character: 1 },
          end: { line: 1, character: 3 },
        },
        kind: 2,
      },
    ]);

    const { server, baseUrl } = await startServer();

    try {
      const response = await postJson(
        baseUrl,
        "/api/agent/lsp/document-highlight",
        {
          filePath: "src/example.ts",
          workspaceRoot: "/tmp/project",
          line: 2,
          character: 2,
        },
        { "X-Desktop-Token": "desktop-secret" },
      );

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.highlights).toHaveLength(1);
      expect(mockCoreLsp.getDocumentHighlight).toHaveBeenCalledWith(
        path.join("/tmp/project", "src/example.ts"),
        2,
        2,
      );
    } finally {
      await stopServer(server);
    }
  });

  it("returns folding ranges", async () => {
    mockCoreLsp.getFoldingRange.mockResolvedValue([
      { startLine: 0, endLine: 8, kind: "region" },
    ]);

    const { server, baseUrl } = await startServer();

    try {
      const response = await postJson(
        baseUrl,
        "/api/agent/lsp/folding-ranges",
        {
          filePath: "src/example.ts",
          workspaceRoot: "/tmp/project",
        },
        { "X-Desktop-Token": "desktop-secret" },
      );

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.ranges).toHaveLength(1);
      expect(mockCoreLsp.getFoldingRange).toHaveBeenCalledWith(
        path.join("/tmp/project", "src/example.ts"),
      );
    } finally {
      await stopServer(server);
    }
  });

  it("returns monikers", async () => {
    mockCoreLsp.getMoniker.mockResolvedValue([
      { scheme: "tsc", identifier: "pkg:typescript/example#Symbol", unique: "workspace" },
    ]);

    const { server, baseUrl } = await startServer();

    try {
      const response = await postJson(
        baseUrl,
        "/api/agent/lsp/moniker",
        {
          filePath: "src/example.ts",
          workspaceRoot: "/tmp/project",
          line: 9,
          character: 4,
        },
        { "X-Desktop-Token": "desktop-secret" },
      );

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.monikers).toHaveLength(1);
      expect(mockCoreLsp.getMoniker).toHaveBeenCalledWith(
        path.join("/tmp/project", "src/example.ts"),
        9,
        4,
      );
    } finally {
      await stopServer(server);
    }
  });

  it("returns call hierarchy data", async () => {
    mockCoreLsp.prepareCallHierarchy.mockResolvedValue([
      { name: "handler", uri: "file:///tmp/project/src/example.ts" },
    ]);
    mockCoreLsp.getIncomingCalls.mockResolvedValue([{ from: { name: "caller" } }]);
    mockCoreLsp.getOutgoingCalls.mockResolvedValue([{ to: { name: "callee" } }]);

    const { server, baseUrl } = await startServer();

    try {
      const headers = { "X-Desktop-Token": "desktop-secret" };

      const prep = await postJson(
        baseUrl,
        "/api/agent/lsp/call-hierarchy/prepare",
        {
          filePath: "src/example.ts",
          workspaceRoot: "/tmp/project",
          line: 3,
          character: 4,
        },
        headers,
      );

      expect(prep.status).toBe(200);
      expect(prep.body.success).toBe(true);
      expect(prep.body.items).toHaveLength(1);

      const incoming = await postJson(
        baseUrl,
        "/api/agent/lsp/call-hierarchy/incoming",
        {
          workspaceRoot: "/tmp/project",
          item: { name: "handler", uri: "file:///tmp/project/src/example.ts" },
        },
        headers,
      );

      expect(incoming.status).toBe(200);
      expect(incoming.body.success).toBe(true);
      expect(incoming.body.calls).toHaveLength(1);

      const outgoing = await postJson(
        baseUrl,
        "/api/agent/lsp/call-hierarchy/outgoing",
        {
          workspaceRoot: "/tmp/project",
          item: { name: "handler", uri: "file:///tmp/project/src/example.ts" },
        },
        headers,
      );

      expect(outgoing.status).toBe(200);
      expect(outgoing.body.success).toBe(true);
      expect(outgoing.body.calls).toHaveLength(1);
      expect(mockCoreLsp.prepareCallHierarchy).toHaveBeenCalledWith(
        path.join("/tmp/project", "src/example.ts"),
        3,
        4,
      );
    } finally {
      await stopServer(server);
    }
  });

  it("returns type hierarchy data", async () => {
    mockCoreLsp.prepareTypeHierarchy.mockResolvedValue([
      { name: "BaseType", uri: "file:///tmp/project/src/example.ts" },
    ]);
    mockCoreLsp.getTypeHierarchySupertypes.mockResolvedValue([{ name: "AncestorType" }]);
    mockCoreLsp.getTypeHierarchySubtypes.mockResolvedValue([{ name: "DerivedType" }]);

    const { server, baseUrl } = await startServer();

    try {
      const headers = { "X-Desktop-Token": "desktop-secret" };

      const prep = await postJson(
        baseUrl,
        "/api/agent/lsp/type-hierarchy/prepare",
        {
          filePath: "src/example.ts",
          workspaceRoot: "/tmp/project",
          line: 5,
          character: 2,
        },
        headers,
      );

      expect(prep.status).toBe(200);
      expect(prep.body.success).toBe(true);
      expect(prep.body.items).toHaveLength(1);

      const supertypes = await postJson(
        baseUrl,
        "/api/agent/lsp/type-hierarchy/supertypes",
        {
          workspaceRoot: "/tmp/project",
          item: { name: "BaseType", uri: "file:///tmp/project/src/example.ts" },
        },
        headers,
      );

      expect(supertypes.status).toBe(200);
      expect(supertypes.body.success).toBe(true);
      expect(supertypes.body.items).toHaveLength(1);

      const subtypes = await postJson(
        baseUrl,
        "/api/agent/lsp/type-hierarchy/subtypes",
        {
          workspaceRoot: "/tmp/project",
          item: { name: "BaseType", uri: "file:///tmp/project/src/example.ts" },
        },
        headers,
      );

      expect(subtypes.status).toBe(200);
      expect(subtypes.body.success).toBe(true);
      expect(subtypes.body.items).toHaveLength(1);
      expect(mockCoreLsp.prepareTypeHierarchy).toHaveBeenCalledWith(
        path.join("/tmp/project", "src/example.ts"),
        5,
        2,
      );
    } finally {
      await stopServer(server);
    }
  });

  it("returns inlay hints", async () => {
    mockCoreLsp.getInlayHints.mockResolvedValue([
      { position: { line: 0, character: 5 }, label: ": string" },
    ]);

    const { server, baseUrl } = await startServer();

    try {
      const response = await postJson(
        baseUrl,
        "/api/agent/lsp/inlay-hints",
        {
          filePath: "src/example.ts",
          workspaceRoot: "/tmp/project",
          startLine: 1,
          startCharacter: 1,
          endLine: 20,
          endCharacter: 1,
        },
        { "X-Desktop-Token": "desktop-secret" },
      );

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.hints).toHaveLength(1);
      expect(mockCoreLsp.getInlayHints).toHaveBeenCalledWith(
        path.join("/tmp/project", "src/example.ts"),
        1,
        1,
        20,
        1,
      );
    } finally {
      await stopServer(server);
    }
  });

  it("returns inline values", async () => {
    mockCoreLsp.getInlineValues.mockResolvedValue([
      { range: { start: { line: 0, character: 5 }, end: { line: 0, character: 6 } }, text: "1" },
    ]);

    const { server, baseUrl } = await startServer();

    try {
      const response = await postJson(
        baseUrl,
        "/api/agent/lsp/inline-values",
        {
          filePath: "src/example.ts",
          workspaceRoot: "/tmp/project",
          startLine: 1,
          startCharacter: 1,
          endLine: 20,
          endCharacter: 1,
          frameId: 7,
          stoppedStartLine: 1,
          stoppedStartCharacter: 1,
          stoppedEndLine: 1,
          stoppedEndCharacter: 4,
        },
        { "X-Desktop-Token": "desktop-secret" },
      );

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.inlineValues).toHaveLength(1);
      expect(mockCoreLsp.getInlineValues).toHaveBeenCalledWith(
        path.join("/tmp/project", "src/example.ts"),
        {
          start: { line: 1, character: 1 },
          end: { line: 20, character: 1 },
        },
        {
          frameId: 7,
          stoppedLocation: {
            start: { line: 1, character: 1 },
            end: { line: 1, character: 4 },
          },
        },
      );
    } finally {
      await stopServer(server);
    }
  });

  it("prepares rename at cursor location", async () => {
    const { server, baseUrl } = await startServer();

    try {
      const response = await postJson(
        baseUrl,
        "/api/agent/lsp/prepare-rename",
        {
          filePath: "src/example.ts",
          workspaceRoot: "/tmp/project",
          line: 8,
          character: 6,
        },
        { "X-Desktop-Token": "desktop-secret" },
      );

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.range).toBeTruthy();
      expect(mockCoreLsp.prepareRename).toHaveBeenCalledWith(
        path.join("/tmp/project", "src/example.ts"),
        8,
        6,
      );
    } finally {
      await stopServer(server);
    }
  });

  it("formats a selected range", async () => {
    mockCoreLsp.formatRange.mockResolvedValue([
      {
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 5 },
        },
        newText: "const",
      },
    ]);

    const { server, baseUrl } = await startServer();

    try {
      const response = await postJson(
        baseUrl,
        "/api/agent/lsp/range-format",
        {
          filePath: "src/example.ts",
          workspaceRoot: "/tmp/project",
          startLine: 1,
          startCharacter: 1,
          endLine: 3,
          endCharacter: 1,
          options: { tabSize: 2, insertSpaces: true },
        },
        { "X-Desktop-Token": "desktop-secret" },
      );

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.edits).toHaveLength(1);
      expect(mockCoreLsp.formatRange).toHaveBeenCalledWith(
        path.join("/tmp/project", "src/example.ts"),
        1,
        1,
        3,
        1,
        expect.objectContaining({ tabSize: 2, insertSpaces: true }),
      );
    } finally {
      await stopServer(server);
    }
  });

  it("formats on type trigger", async () => {
    mockCoreLsp.formatOnType.mockResolvedValue([]);

    const { server, baseUrl } = await startServer();

    try {
      const response = await postJson(
        baseUrl,
        "/api/agent/lsp/on-type-format",
        {
          filePath: "src/example.ts",
          workspaceRoot: "/tmp/project",
          line: 12,
          character: 18,
          ch: "\n",
          options: { tabSize: 2, insertSpaces: true },
        },
        { "X-Desktop-Token": "desktop-secret" },
      );

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(mockCoreLsp.formatOnType).toHaveBeenCalledWith(
        path.join("/tmp/project", "src/example.ts"),
        12,
        18,
        "\n",
        expect.objectContaining({ tabSize: 2, insertSpaces: true }),
      );
    } finally {
      await stopServer(server);
    }
  });

  it("returns document links", async () => {
    mockCoreLsp.getDocumentLinks.mockResolvedValue([
      {
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 10 },
        },
        target: "https://example.com",
      },
    ]);

    const { server, baseUrl } = await startServer();

    try {
      const response = await postJson(
        baseUrl,
        "/api/agent/lsp/document-links",
        {
          filePath: "README.md",
          workspaceRoot: "/tmp/project",
        },
        { "X-Desktop-Token": "desktop-secret" },
      );

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.links).toHaveLength(1);
      expect(mockCoreLsp.getDocumentLinks).toHaveBeenCalledWith(
        path.join("/tmp/project", "README.md"),
      );
    } finally {
      await stopServer(server);
    }
  });

  it("returns linked editing ranges", async () => {
    mockCoreLsp.getLinkedEditingRange.mockResolvedValue({
      ranges: [
        {
          start: { line: 1, character: 1 },
          end: { line: 1, character: 4 },
        },
      ],
      wordPattern: "[A-Za-z_][A-Za-z0-9_]*",
    });

    const { server, baseUrl } = await startServer();

    try {
      const response = await postJson(
        baseUrl,
        "/api/agent/lsp/linked-editing-range",
        {
          filePath: "src/example.ts",
          workspaceRoot: "/tmp/project",
          line: 2,
          character: 3,
        },
        { "X-Desktop-Token": "desktop-secret" },
      );

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.ranges).toBeTruthy();
      expect(mockCoreLsp.getLinkedEditingRange).toHaveBeenCalledWith(
        path.join("/tmp/project", "src/example.ts"),
        2,
        3,
      );
    } finally {
      await stopServer(server);
    }
  });

  it("returns document colors and color presentations", async () => {
    mockCoreLsp.getDocumentColors.mockResolvedValue([
      {
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 7 },
        },
        color: { red: 1, green: 0, blue: 0, alpha: 1 },
      },
    ]);
    mockCoreLsp.getColorPresentations.mockResolvedValue([
      { label: "#ff0000" },
    ]);

    const { server, baseUrl } = await startServer();

    try {
      const headers = { "X-Desktop-Token": "desktop-secret" };

      const colors = await postJson(
        baseUrl,
        "/api/agent/lsp/document-colors",
        {
          filePath: "src/example.css",
          workspaceRoot: "/tmp/project",
        },
        headers,
      );

      expect(colors.status).toBe(200);
      expect(colors.body.success).toBe(true);
      expect(colors.body.colors).toHaveLength(1);
      expect(mockCoreLsp.getDocumentColors).toHaveBeenCalledWith(
        path.join("/tmp/project", "src/example.css"),
      );

      const presentations = await postJson(
        baseUrl,
        "/api/agent/lsp/color-presentations",
        {
          filePath: "src/example.css",
          workspaceRoot: "/tmp/project",
          color: { red: 1, green: 0, blue: 0, alpha: 1 },
          startLine: 1,
          startCharacter: 1,
          endLine: 1,
          endCharacter: 8,
        },
        headers,
      );

      expect(presentations.status).toBe(200);
      expect(presentations.body.success).toBe(true);
      expect(presentations.body.presentations).toHaveLength(1);
      expect(mockCoreLsp.getColorPresentations).toHaveBeenCalledWith(
        path.join("/tmp/project", "src/example.css"),
        { red: 1, green: 0, blue: 0, alpha: 1 },
        1,
        1,
        1,
        8,
      );
    } finally {
      await stopServer(server);
    }
  });

  it("returns semantic tokens for a range", async () => {
    mockCoreLsp.getSemanticTokensRange.mockResolvedValue({
      data: [0, 0, 6, 12, 0],
      legend: { tokenTypes: ["function"], tokenModifiers: ["declaration"] },
      languageId: "typescript",
    });

    const { server, baseUrl } = await startServer();

    try {
      const response = await postJson(
        baseUrl,
        "/api/agent/lsp/semantic-tokens-range",
        {
          filePath: "src/example.ts",
          workspaceRoot: "/tmp/project",
          startLine: 1,
          startCharacter: 1,
          endLine: 20,
          endCharacter: 1,
        },
        { "X-Desktop-Token": "desktop-secret" },
      );

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data).toEqual([0, 0, 6, 12, 0]);
      expect(mockCoreLsp.getSemanticTokensRange).toHaveBeenCalledWith(
        path.join("/tmp/project", "src/example.ts"),
        1,
        1,
        20,
        1,
      );
    } finally {
      await stopServer(server);
    }
  });

  it("returns semantic token delta results", async () => {
    mockCoreLsp.getSemanticTokensDelta.mockResolvedValue({
      data: [0, 0, 4, 12, 0],
      resultId: "1",
      edits: [{ start: 0, deleteCount: 0, data: [0, 0, 4, 12, 0] }],
      legend: { tokenTypes: ["function"], tokenModifiers: ["declaration"] },
      languageId: "typescript",
    });

    const { server, baseUrl } = await startServer();

    try {
      const response = await postJson(
        baseUrl,
        "/api/agent/semantic-tokens-delta",
        {
          code: "function test() {}",
          language: "ts",
          filePath: "src/example.ts",
          workspaceRoot: "/tmp/project",
          previousResultId: "0",
        },
        { "X-Desktop-Token": "desktop-secret" },
      );

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.resultId).toBe("1");
      expect(Array.isArray(response.body.edits)).toBe(true);
      expect(mockCoreLsp.getSemanticTokensDelta).toHaveBeenCalledWith(
        path.join("/tmp/project", "src/example.ts"),
        "typescript",
        "function test() {}",
        "0",
      );
    } finally {
      await stopServer(server);
    }
  });

  it("returns completion, symbols, and code lens", async () => {
    mockCoreLsp.getCompletion.mockResolvedValue({
      isIncomplete: false,
      items: [{ label: "print" }],
    });
    mockCoreLsp.getDocumentSymbols.mockResolvedValue([{ name: "main", kind: 12 }]);
    mockCoreLsp.getCodeLens.mockResolvedValue([{ range: { start: { line: 0, character: 0 } } }]);

    const { server, baseUrl } = await startServer();

    try {
      const headers = { "X-Desktop-Token": "desktop-secret" };

      const completion = await postJson(
        baseUrl,
        "/api/agent/lsp/completion",
        {
          filePath: "src/example.ts",
          workspaceRoot: "/tmp/project",
          line: 4,
          character: 10,
        },
        headers,
      );
      expect(completion.status).toBe(200);
      expect(completion.body.success).toBe(true);

      const symbols = await postJson(
        baseUrl,
        "/api/agent/lsp/document-symbols",
        {
          filePath: "src/example.ts",
          workspaceRoot: "/tmp/project",
        },
        headers,
      );
      expect(symbols.status).toBe(200);
      expect(symbols.body.success).toBe(true);
      expect(symbols.body.symbols).toHaveLength(1);

      const codeLens = await postJson(
        baseUrl,
        "/api/agent/lsp/code-lens",
        {
          filePath: "src/example.ts",
          workspaceRoot: "/tmp/project",
        },
        headers,
      );
      expect(codeLens.status).toBe(200);
      expect(codeLens.body.success).toBe(true);
      expect(codeLens.body.codeLens).toHaveLength(1);

      expect(mockCoreLsp.getCompletion).toHaveBeenCalledWith(
        path.join("/tmp/project", "src/example.ts"),
        4,
        10,
      );
      expect(mockCoreLsp.getDocumentSymbols).toHaveBeenCalledWith(
        path.join("/tmp/project", "src/example.ts"),
      );
      expect(mockCoreLsp.getCodeLens).toHaveBeenCalledWith(
        path.join("/tmp/project", "src/example.ts"),
      );
    } finally {
      await stopServer(server);
    }
  });

  it("returns semantic tokens full and delta from lsp routes", async () => {
    mockCoreLsp.getSemanticTokensFull.mockResolvedValue({
      data: [0, 0, 6, 12, 0],
      resultId: "1",
      legend: { tokenTypes: ["function"], tokenModifiers: [] },
      languageId: "typescript",
    });
    mockCoreLsp.getSemanticTokensDocumentDelta.mockResolvedValue({
      data: [0, 0, 3, 12, 0],
      resultId: "2",
      edits: [{ start: 0, deleteCount: 0, data: [0, 0, 3, 12, 0] }],
      legend: { tokenTypes: ["function"], tokenModifiers: [] },
      languageId: "typescript",
    });

    const { server, baseUrl } = await startServer();

    try {
      const headers = { "X-Desktop-Token": "desktop-secret" };

      const full = await postJson(
        baseUrl,
        "/api/agent/lsp/semantic-tokens-full",
        {
          filePath: "src/example.ts",
          workspaceRoot: "/tmp/project",
        },
        headers,
      );
      expect(full.status).toBe(200);
      expect(full.body.success).toBe(true);
      expect(full.body.resultId).toBe("1");

      const delta = await postJson(
        baseUrl,
        "/api/agent/lsp/semantic-tokens-delta",
        {
          filePath: "src/example.ts",
          workspaceRoot: "/tmp/project",
          previousResultId: "1",
        },
        headers,
      );
      expect(delta.status).toBe(200);
      expect(delta.body.success).toBe(true);
      expect(delta.body.resultId).toBe("2");
      expect(Array.isArray(delta.body.edits)).toBe(true);

      expect(mockCoreLsp.getSemanticTokensFull).toHaveBeenCalledWith(
        path.join("/tmp/project", "src/example.ts"),
      );
      expect(mockCoreLsp.getSemanticTokensDocumentDelta).toHaveBeenCalledWith(
        path.join("/tmp/project", "src/example.ts"),
        "1",
      );
    } finally {
      await stopServer(server);
    }
  });

  it("resolves protocol items and supports willSave/inline completion", async () => {
    mockCoreLsp.resolveCompletionItem.mockResolvedValue({ label: "print", detail: "resolved" });
    mockCoreLsp.resolveCodeAction.mockResolvedValue({ title: "Fix all" });
    mockCoreLsp.resolveCodeLens.mockResolvedValue({ command: { title: "Run" } });
    mockCoreLsp.resolveDocumentLink.mockResolvedValue({ target: "https://example.com" });
    mockCoreLsp.resolveWorkspaceSymbol.mockResolvedValue({ name: "main" });
    mockCoreLsp.resolveInlayHint.mockResolvedValue({ label: ": number" });
    mockCoreLsp.resolveInlineCompletionItem.mockResolvedValue({ insertText: "value" });
    mockCoreLsp.getInlineCompletion.mockResolvedValue({ items: [{ insertText: "value" }] });
    mockCoreLsp.willSaveWaitUntil.mockResolvedValue([{ newText: "" }]);

    const { server, baseUrl } = await startServer();

    try {
      const headers = { "X-Desktop-Token": "desktop-secret" };
      const sharedPayload = {
        workspaceRoot: "/tmp/project",
        languageId: "typescript",
        filePath: "src/example.ts",
        item: { label: "x" },
      };

      const completionResolve = await postJson(baseUrl, "/api/agent/lsp/completion/resolve", sharedPayload, headers);
      expect(completionResolve.status).toBe(200);
      const codeActionResolve = await postJson(baseUrl, "/api/agent/lsp/code-action/resolve", sharedPayload, headers);
      expect(codeActionResolve.status).toBe(200);
      const codeLensResolve = await postJson(baseUrl, "/api/agent/lsp/code-lens/resolve", sharedPayload, headers);
      expect(codeLensResolve.status).toBe(200);
      const docLinkResolve = await postJson(baseUrl, "/api/agent/lsp/document-link/resolve", sharedPayload, headers);
      expect(docLinkResolve.status).toBe(200);
      const wsSymbolResolve = await postJson(
        baseUrl,
        "/api/agent/lsp/workspace-symbol/resolve",
        { workspaceRoot: "/tmp/project", languageId: "typescript", item: { name: "x" } },
        headers,
      );
      expect(wsSymbolResolve.status).toBe(200);
      const inlayResolve = await postJson(baseUrl, "/api/agent/lsp/inlay-hint/resolve", sharedPayload, headers);
      expect(inlayResolve.status).toBe(200);
      const inlineResolve = await postJson(baseUrl, "/api/agent/lsp/inline-completion/resolve", sharedPayload, headers);
      expect(inlineResolve.status).toBe(200);

      const inlineCompletion = await postJson(
        baseUrl,
        "/api/agent/lsp/inline-completion",
        {
          workspaceRoot: "/tmp/project",
          filePath: "src/example.ts",
          line: 9,
          character: 4,
          context: { triggerKind: 1 },
        },
        headers,
      );
      expect(inlineCompletion.status).toBe(200);
      expect(inlineCompletion.body.success).toBe(true);

      const willSave = await postJson(
        baseUrl,
        "/api/agent/lsp/will-save-wait-until",
        {
          workspaceRoot: "/tmp/project",
          filePath: "src/example.ts",
          reason: 1,
        },
        headers,
      );
      expect(willSave.status).toBe(200);
      expect(willSave.body.success).toBe(true);

      expect(mockCoreLsp.resolveCompletionItem).toHaveBeenCalled();
      expect(mockCoreLsp.resolveCodeAction).toHaveBeenCalled();
      expect(mockCoreLsp.resolveCodeLens).toHaveBeenCalled();
      expect(mockCoreLsp.resolveDocumentLink).toHaveBeenCalled();
      expect(mockCoreLsp.resolveWorkspaceSymbol).toHaveBeenCalled();
      expect(mockCoreLsp.resolveInlayHint).toHaveBeenCalled();
      expect(mockCoreLsp.resolveInlineCompletionItem).toHaveBeenCalled();
      expect(mockCoreLsp.getInlineCompletion).toHaveBeenCalledWith(
        path.join("/tmp/project", "src/example.ts"),
        9,
        4,
        { triggerKind: 1 },
      );
      expect(mockCoreLsp.willSaveWaitUntil).toHaveBeenCalledWith(
        path.join("/tmp/project", "src/example.ts"),
        1,
      );
    } finally {
      await stopServer(server);
    }
  });

  it("executes workspace command", async () => {
    mockCoreLsp.executeWorkspaceCommand.mockResolvedValue({ applied: true });

    const { server, baseUrl } = await startServer();

    try {
      const response = await postJson(
        baseUrl,
        "/api/agent/lsp/execute-command",
        {
          workspaceRoot: "/tmp/project",
          command: "editor.action.organizeImports",
          args: ["src/example.ts"],
          languageId: "typescript",
        },
        { "X-Desktop-Token": "desktop-secret" },
      );

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(mockCoreLsp.executeWorkspaceCommand).toHaveBeenCalledWith(
        "editor.action.organizeImports",
        ["src/example.ts"],
        "typescript",
        undefined,
      );
    } finally {
      await stopServer(server);
    }
  });

  it("notifies will-save", async () => {
    const { server, baseUrl } = await startServer();

    try {
      const response = await postJson(
        baseUrl,
        "/api/agent/lsp/will-save",
        {
          workspaceRoot: "/tmp/project",
          filePath: "src/example.ts",
          reason: 1,
        },
        { "X-Desktop-Token": "desktop-secret" },
      );

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(mockCoreLsp.willSaveDocument).toHaveBeenCalledWith(
        path.join("/tmp/project", "src/example.ts"),
        1,
      );
    } finally {
      await stopServer(server);
    }
  });

  it("notifies workspace folder changes", async () => {
    const { server, baseUrl } = await startServer();

    try {
      const response = await postJson(
        baseUrl,
        "/api/agent/lsp/workspace-folders",
        {
          workspaceRoot: "/tmp/project",
          added: [{ uri: "file:///tmp/project", name: "project" }],
          removed: [{ uri: "file:///tmp/old", name: "old" }],
        },
        { "X-Desktop-Token": "desktop-secret" },
      );

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(mockCoreLsp.didChangeWorkspaceFolders).toHaveBeenCalledWith(
        [{ uri: "file:///tmp/project", name: "project" }],
        [{ uri: "file:///tmp/old", name: "old" }],
      );
    } finally {
      await stopServer(server);
    }
  });
});
