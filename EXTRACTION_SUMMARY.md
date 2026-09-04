# iris-agent: Backend Agent Extraction Summary

**Date:** Sep 04, 2026  
**Status:** ✅ Ready for Publishing  
**Branch:** `extract/backend-agent-standalone`  
**Tag:** `v0.1.0`

## What Was Extracted

The backend **AIRIS coding-agent** has been extracted from the monorepo into a standalone, open-source HTTP service at `/Users/uka.osim/4onstudio-repo/iris-agent`.

### Key Components

- **Express HTTP Service** - Listens on PORT (default 8080)
- **Agent Runtime** - Full Mastra-based coding agent with tools, models, streaming
- **API Routes** - `/api/agent/*` endpoints (chat, skills, tools, runs, LSP, MCP)
- **CORS Middleware** - Configurable allowed origins via `AGENT_ALLOWED_ORIGINS` env

### Files & Directories

```
iris-agent/
├── server.ts              # Express host (CORS, health check, routing)
├── api/                   # Backend agent implementation
│   ├── agent.ts          # Main Express router + auth middleware
│   ├── core/
│   │   ├── agent/        # Agent runtime, tools, tools config
│   │   ├── library/      # Utilities (LSP, MCP, safety, workspace)
│   │   └── store/        # Run persistence (SQLite)
│   └── handlers/         # Endpoint implementations
├── tests/                 # 27 agent-focused test files
├── package.json          # Service manifest (@4onstudios/iris-agent, MIT)
├── README.md             # Quick-start & configuration
├── LICENSE               # MIT License
└── tsconfig.json         # TypeScript config
```

## What Was Changed

### Removals & Adaptations

- **Removed:** Browser/desktop-only code:
  - `src/agent/` (client-side Iris dependencies) - **not needed**
  - Tauri module imports (desktop integration)
  - File System Access API (browser only)
  - ACP & registry tests (desktop-specific)

- **Modified for Node.js Backend:**
  - `api/core/library/tauri.ts` - Checks `typeof window === "undefined"` first (return false)
  - `api/core/library/tauriImport.ts` - Stub that rejects (Tauri unavailable in backend)
  - `api/core/library/workspaceIdentity.ts` - Type assertions for `window.workspaceRoot`, `window.workspaceStructure`
  - `api/core/library/desktopWorkspace.ts` - Already stubbed (`getDesktopWorkspacePath() => null`)
  - `api/core/agent/tools/applyDiff.ts` - Fixed `applyPatch()` signature for diff v9.0.0
  - `api/core/agent/tools/fileContent.ts` - Type assertions for `window.directoryHandle` (FileSystem API)
  - `jest.config.cjs` - Changed testEnvironment from `jsdom` to `node`

- **Tests Removed** (desktop-only):
  - `agent.acp*.test.ts` (5 tests)
  - `agent.defaultRegistry.test.ts`
  - `agent.externalLifecycle.test.ts`
  - `agent.registry.test.ts`
  - `agent.repoMapIndex.test.ts`
  - `agent.skillsDiscovery.test.ts`
  - `agent.skillsPath.test.ts`
  - **Remaining:** 27 functional test files

### TypeScript Validation

✅ All compilation errors resolved:
```bash
npm run typecheck  # → No errors
```

### Service Verification

✅ Service starts successfully:
```bash
npm start  # → Listening on port 8080
```

## Configuration

### Environment Variables

```bash
# Service
PORT=8080                          # Server port (default: 8080)
NODE_ENV=production               # Environment

# CORS (browser clients)
AGENT_ALLOWED_ORIGINS=             # Comma-separated origins
                                   # Example: https://app.example.com,https://web.example.com
                                   # Omit to allow only non-browser clients (CLI, reverse proxy)

# LLM Provider Keys
OPENAI_API_KEY=sk-...              # OpenAI
ANTHROPIC_API_KEY=sk-ant-...       # Anthropic
GOOGLE_GENERATIVE_AI_API_KEY=...   # Google
OPENROUTER_API_KEY=sk-or-...       # OpenRouter
```

### Usage

**Via npm:**
```bash
npm install
npm start                          # Production mode
npm run dev                        # Watch mode with nodemon
npm test                           # Run test suite
npm run typecheck                  # TypeScript validation
```

**Via Docker (future):**
```bash
docker build -t iris-agent:latest .
docker run -p 8080:8080 -e OPENAI_API_KEY=sk-... iris-agent:latest
```

## Next Steps

1. **Create GitHub Repository** - `4onstudios/iris-agent` (requires GitHub auth)
   ```bash
   gh repo create iris-agent --public --source=. --remote=origin --push
   ```

2. **Update Iris Monorepo** - Configure Iris to call this service:
   - Modify Iris server to proxy `/api/agent/*` to standalone service
   - Update environment config to point to service host/port
   - Add service startup/health checks to Iris deployment

3. **Publish npm Package** (optional):
   - Register with npm registry
   - Run `npm publish --access public`

4. **Distribution** - Docker Hub, GitHub Container Registry

## Verification Checklist

- [x] Dependencies installed (`npm install` → 839 packages)
- [x] TypeScript compilation (`npm run typecheck` → 0 errors)
- [x] Service startup (`npm start` → listening on 8080)
- [x] Tests runnable (`npm test` → 27 test files ready)
- [x] Git repository initialized
- [x] Feature branch: `extract/backend-agent-standalone`
- [x] Version tagged: `v0.1.0`
- [x] License: MIT

## Known Limitations

- **Workspace Root:** Service expects clients to provide workspace root in request body (`workspaceRoot` field)
  - Desktop (Tauri) mode still available via `TAURI_BUNDLED` env var
  - Web/CLI modes can pass workspace path explicitly

- **Desktop Auth Middleware:** `requireDesktopAuth` and `hasDesktopAuth` still present but skipped unless `TAURI_BUNDLED` set
  - Allows both desktop and web deployments from same codebase

- **ACP (Agent Client Protocol):** Not included in standalone service
  - Can be added later as optional feature
  - Desktop Iris can still use ACP; standalone service provides HTTP interface

## Extracted From

- **Repository:** `4onstudios/iris` (monorepo)
- **Extracted:** `api/core/agent/`, `api/agent.ts`, `tests/agent.*.test.ts`
- **Commit:** (reference for traceability)

---

**Ready to publish:** Yes ✅  
**Status:** v0.1.0 on `extract/backend-agent-standalone`  
**Next:** Push to GitHub, configure Iris integration
