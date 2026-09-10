<p align="center">
  <img src="assets/iris-agent-logo.svg" alt="Iris Agent logo" width="180">
</p>

<h1 align="center">Iris Agent</h1>

<p align="center">
  <a href="https://4onstudios.com/">Built by 4onStudios</a>
  ·
  <a href="https://github.com/4onstudios/iris-agent/issues">Issues</a>
  ·
  <a href="https://github.com/4onstudios/iris-agent/pulls">Contribute</a>
</p>

<p align="center">
  <a href="https://github.com/4onstudios/iris-agent/actions/workflows/ci.yml"><img src="https://github.com/4onstudios/iris-agent/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <a href="https://www.npmjs.com/package/@4onstudios/iris-agent"><img src="https://img.shields.io/npm/v/%404onstudios%2Firis-agent" alt="npm version"></a>
  <a href="https://github.com/4onstudios/iris-agent/blob/main/LICENSE"><img src="https://img.shields.io/github/license/4onstudios/iris-agent" alt="MIT License"></a>
</p>

Iris Agent is the standalone coding-agent service used by [AIRIS](https://github.com/4onstudios/iris).

It provides streaming chat, workspace tools, LSP routes, MCP integration, command approvals, and run lifecycle APIs. It can run as:

- **HTTP Service** - RESTful API under `/api/agent`
- **CLI** - Interactive chat in the terminal
- **ACP Server** - Agent Client Protocol via stdio for seamless IDE integration

The SDK and ACP server require Node.js `>=22.13.0`. `IrisClient` is a
Node.js API for IDE desktop or backend processes; it is not intended to run in
a browser renderer.

## Quick Start

This project can be installed and run with either npm or Yarn.

```sh
# npm
npm install
OPENAI_API_KEY=... npm start

# yarn
yarn install
yarn start
```

### HTTP Service

```sh
npm install
OPENAI_API_KEY=... npm start
```

The service listens on port `8080` by default. Set `PORT` to change it. `GET /health` reports service readiness.

### Using Iris Agent in an IDE

To run the standalone agent service for an IDE integration:

```bash
git clone https://github.com/4onstudios/iris-agent.git
cd iris-agent
npm install
npm start
```

The service listens on port `8080` by default and exposes its API under
`/api/agent`. Set `PORT` to use another port and configure
`AGENT_ALLOWED_ORIGINS` with the IDE's origin when browser CORS is required:

```bash
PORT=8080 AGENT_ALLOWED_ORIGINS=http://localhost:3000 npm start
```

The HTTP API is mounted below `/api/agent`. The main endpoints are:

| Endpoint | Purpose |
| --- | --- |
| `POST /api/agent/chat` | Send a message and optional workspace, model, history, tools, skills, MCP, and approval settings. |
| `GET /api/agent/runs/:runId` | Read the current run lifecycle snapshot. |
| `GET /api/agent/runs/:runId/events` | Read persisted run events. Supports `afterSequence` and `limit` (1-500). |
| `POST /api/agent/runs/:runId/cancel` | Request cancellation of a run. |
| `POST /api/agent/command-confirmation` | Approve or skip a pending command execution. |
| `GET /api/agent/skills` | List discovered skills. |
| `GET /api/agent/tools` | List native and MCP tools with their input schemas. |
| `GET /api/agent/slash-commands` | List enabled slash commands. |
| `POST /api/agent/mcp/inspect` | Inspect the tools exposed by one MCP server. |
| `POST /api/agent/mcp/call` | Invoke an MCP tool. |

The service also exposes file, chat-session, semantic-search, and LSP routes under
`/api/agent`. Those routes are intended for the AIRIS desktop client and are
implemented in [`api/`](./api/); use `GET /api/agent/tools` and
`GET /api/agent/skills` for runtime discovery.

Example chat request:

```sh
curl -X POST http://localhost:8080/api/agent/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"Explain this project","workspaceRoot":"/path/to/project"}'
```

Run lifecycle states and event payloads are returned by the run endpoints. Store
the returned `runId` from a chat response if the client needs polling,
progress-event retrieval, or cancellation.

### CLI Mode

```sh
OPENAI_API_KEY=... npm run cli -- --workspace /path/to/project --chat
```

This starts an interactive chat session in your terminal with access to the workspace.

### ACP Server

```sh
OPENAI_API_KEY=... npm run cli -- --workspace /path/to/project --acp
```

This starts an ACP (Agent Client Protocol) server over stdio, allowing IDE
integrations and other ACP clients to communicate with the agent. Standard
output is reserved for newline-delimited JSON-RPC messages; logs are written to
standard error. Each ACP process is bound to the workspace supplied at startup.
To switch workspaces, close the process and respawn `iris-agent` with the new
`--workspace` path.

## CLI Usage

```sh
iris-agent --workspace <path> [--acp | --chat]
```

**Options:**

- `--workspace` (required) - Path to the workspace/project root
- `--acp` - Start ACP protocol server (stdio-based)
- `--chat` - Start interactive chat mode

Short aliases are also available: `-w`, `-a`, and `-c`. Running the CLI
without `--chat` or `--acp` prints help.

**Examples:**

```sh
# Interactive chat
npm run cli -- --workspace . --chat

# ACP server for IDE integration
npm run cli -- --workspace . --acp

# HTTP service (default)
npm start
```

## Browser Client

Configure the precise browser origins permitted to call this service:

```sh
AGENT_ALLOWED_ORIGINS=https://airis.4onstudios.com npm start
```

Multiple origins may be supplied as a comma-separated list. Requests without an `Origin` header (such as a local CLI or reverse proxy) are accepted; browser origins are denied unless explicitly configured.

## Providers

Configure the API key for the model provider selected by the client:

- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `GOOGLE_GENERATIVE_AI_API_KEY`
- `OPENROUTER_API_KEY`
- `OLLAMA_API_KEY`

Provider-specific configuration:

| Variable | Description |
| --- | --- |
| `OLLAMA_BASE_URL` | Ollama-compatible server URL. |
| `OPENROUTER_BASE_URL` | OpenRouter-compatible API URL. |
| `OPENROUTER_SITE_URL` / `OPENROUTER_SITE_NAME` | Optional OpenRouter request metadata. |
| `ANTHROPIC_BETA` / `ANTHROPIC_BETAS` | Optional Anthropic beta headers. |
| `HF_TOKEN` | Hugging Face authentication where required by a configured provider. |

### Runtime configuration

| Variable | Description |
| --- | --- |
| `PORT` | HTTP listening port; defaults to `8080`. |
| `AGENT_ALLOWED_ORIGINS` | Comma-separated browser origins allowed by CORS. Requests without an `Origin` header are allowed. |
| `DATABASE_URL` | Database connection URL used by the configured agent storage. |
| `IRIS_AGENT_RUNS_DB_PATH` | SQLite path for persisted run lifecycle data. |
| `IRIS_BACKEND_SERVICE` | Selects the backend service integration. |
| `IRIS_AGENT_PREFERRED_AGENT_ID` | Preferred external agent identifier. |
| `IRIS_AGENT_EXTERNAL_AGENT_MANIFEST_PATH` | Path to an external-agent manifest. |
| `IRIS_AGENT_GIT_SAFETY_MODE` | Git safety policy; defaults to `suggest`. |
| `IRIS_AGENT_AUTO_LINT` / `IRIS_AGENT_AUTO_TEST` | Enable automatic lint/test validation. |
| `IRIS_AGENT_LINT_CMD` / `IRIS_AGENT_TEST_CMD` | Override validation commands. |
| `IRIS_AGENT_AUTO_FIX_VALIDATION` | Enable automatic validation fixes. |
| `IRIS_AGENT_INPUT_TOKEN_LIMIT` / `IRIS_AGENT_MAX_OUTPUT_TOKENS` | Token-budget controls. |
| `IRIS_AGENT_PROMPT_TOKEN_BUDGET_RATIO` | Prompt budget ratio. |
| `IRIS_AGENT_MODEL_RETRY_ATTEMPTS` | Model request retry count. |
| `IRIS_AGENT_REFLECTION_MAX` / `IRIS_AGENT_REFLECTION_MAX_STEPS` | Reflection-loop limits. |
| `IRIS_AGENT_REFLECTION_RETRY_ATTEMPTS` | Reflection retry count. |
| `IRIS_AGENT_REFLECTION_NO_PROGRESS_REPEATS` | Maximum repeated no-progress reflection cycles. |
| `IRIS_ENABLE_SLASH_COMMANDS` | Enable slash-command handling. |
| `IRIS_DEBUG_TOKEN_USAGE_SOURCE` | Enable token-usage diagnostics. |
| `IRIS_AGENT_STREAM_RETRY_ENABLED` | Enable stream retries. Related retry delay and limit variables are supported by the runtime. |
| `IRIS_VERBOSE_SKILL_DISCOVERY` | Enable verbose skill-discovery logging. |
| `BROWSER_NO_SANDBOX` | Set to `true` only when browser automation must run without a sandbox. |

Environment values can be supplied in a local `.env` file for the HTTP server
because it loads `dotenv/config`. Do not commit `.env` files or API keys.

### Desktop authentication

Desktop-only routes require both `TAURI_BUNDLED=1` and `IRIS_DESKTOP_TOKEN`.
Clients send the token in the `X-Desktop-Token` header. These protected routes
include key management, file operations, remote chat-session synchronization,
and MCP inspection/calls. Do not expose the desktop token to browsers.

### Persistence

Run lifecycle data is stored in SQLite. Set `IRIS_AGENT_RUNS_DB_PATH` to choose
the database location; otherwise it is stored at `~/.iris/agent-runs.sqlite`.
Chat sessions are stored as JSON files under `~/.iris/chat-sessions/` and are
managed through the desktop synchronization routes.

### MCP and approvals

MCP servers are supplied in chat requests or MCP route payloads. Use
`POST /api/agent/mcp/inspect` to discover tools before calling
`POST /api/agent/mcp/call`. MCP tool names must start with `mcp_`.
Commands that require approval pause until the client submits
`POST /api/agent/command-confirmation` with a `confirmationId` and boolean
`approved` value.

## ACP Protocol

The stdio server implements the standard ACP v1 lifecycle:

- `initialize`
- `session/new`
- `session/prompt`
- `session/cancel`
- `session/close`
- `session/update` notifications for assistant text, reasoning, and tool status

The server currently advertises text and resource-link prompts plus session
close support. It does not advertise session persistence or unsupported media
capabilities.

Each ACP session must use the workspace supplied when starting the process.
Close and respawn the CLI to use another workspace.

### IrisClient SDK

Install the published package in the Node.js process that owns your IDE's
agent integration:

```sh
npm install @4onstudios/iris-agent
```

The spawned agent uses the provider credentials from its environment. For
example:

```sh
OPENAI_API_KEY=... npm run your-ide-backend
```

When using a local checkout instead of the published package, build it before
starting the compiled CLI:

```sh
npm install
npm run build
```

The ACP subprocess writes protocol messages to stdout and diagnostic logs to
stderr. Never merge logs into stdout or pipe stdout through a text logger;
doing so corrupts the ACP stream.

IDE extensions written for Node.js can use the exported `IrisClient` instead of
managing ACP messages or the agent subprocess directly:

```ts
import { IrisClient } from "@4onstudios/iris-agent";

const { client } = await IrisClient.spawn({
  cwd: workspaceRoot,
  onSessionUpdate(notification) {
    renderAgentUpdate(notification.update);
  },
});

try {
  await client.openSession(workspaceRoot);
  const result = await client.prompt("Explain the selected code");
  console.log(result.stopReason);
} finally {
  await client.close();
}
```

`IrisClient.spawn()` starts `iris-agent --workspace <cwd> --acp`, initializes the
ACP connection, and owns process cleanup. The `cwd` must be the workspace path
the agent is allowed to access. The package's `iris-agent` executable must be
available on `PATH`; use `command` and `args` when your IDE starts a local
checkout or a custom launcher:

```ts
const { client } = await IrisClient.spawn({
  command: "node",
  args: ["/path/to/iris-agent/dist/cli.js", "--workspace", workspaceRoot, "--acp"],
  cwd: workspaceRoot,
  env: { OPENAI_API_KEY: process.env.OPENAI_API_KEY },
});
```

One `IrisClient` owns one active ACP session. Call `openSession()` before
`prompt()`, use `cancel()` to stop the active turn, call `closeSession()` when
switching workspaces, and call `close()` during IDE shutdown. `close()` also
terminates a process created by `spawn()` and is safe to call repeatedly.

`IrisClient.connect()` accepts an existing ACP stream or in-process ACP agent
when the IDE manages the process or transport itself. Use this for IDEs that
already have a process supervisor or ACP transport. `spawn()` rejects if the
agent executable cannot start or initialization fails, so handle startup errors
before enabling agent commands in the UI.

The `onSessionUpdate` callback receives standard ACP session notifications:

| Update | Typical UI behavior |
| --- | --- |
| `agent_message_chunk` | Append assistant text. |
| `agent_thought_chunk` | Show or hide reasoning according to IDE policy. |
| `tool_call` | Show a tool as running. |
| `tool_call_update` | Update tool status and output. |

Do not expose provider API keys or raw ACP stdio streams to a browser renderer.
Keep the client in the trusted desktop/backend process and forward only the
events and commands your IDE UI needs.

#### Troubleshooting

- `ENOENT` when calling `spawn()` means the configured `command` is not on
  `PATH`. Set `command` and `args` to the compiled CLI, or install the package
  globally for the IDE process.
- An initialization failure usually means the subprocess exited early, the
  provider key is missing, or stdout contains non-ACP output. Inspect stderr
  and verify the provider environment passed through `env`.
- A prompt requires an open session. Call `openSession()` once per workspace,
  then call `closeSession()` before switching workspaces.
- `IrisClient` requires a Node.js desktop/backend process. Browser-only IDE
  clients should call their backend over HTTPS/WebSocket/IPC instead of
  spawning the agent in the renderer.

### Custom IDE Backend

For a custom IDE, keep `IrisClient` in the desktop or backend process and
forward agent updates to the UI over WebSocket, IPC, or the IDE's event bus:

```ts
import { IrisClient } from "@4onstudios/iris-agent";

export class IrisAgentController {
  private client?: IrisClient;

  async start(workspaceRoot: string, onUpdate: (update: unknown) => void) {
    const spawned = await IrisClient.spawn({
      cwd: workspaceRoot,
      clientName: "my-custom-ide",
      clientVersion: "1.0.0",
      onSessionUpdate(notification) {
        onUpdate(notification.update);
      },
    });

    this.client = spawned.client;
    await this.client.openSession(workspaceRoot);
  }

  async prompt(prompt: string) {
    if (!this.client) throw new Error("Iris agent is not running");
    return this.client.prompt(prompt);
  }

  async cancel() {
    await this.client?.cancel();
  }

  async stop() {
    await this.client?.close();
    this.client = undefined;
  }
}
```

Example backend routes can forward updates to the custom IDE client:

```ts
const iris = new IrisAgentController();

await iris.start(workspaceRoot, (update) => {
  websocket.broadcast({ type: "agent-update", update });
});

app.post("/api/agent/prompt", async (request, response) => {
  response.json(await iris.prompt(request.body.prompt));
});

app.post("/api/agent/cancel", async (_request, response) => {
  await iris.cancel();
  response.sendStatus(204);
});

app.post("/api/agent/stop", async (_request, response) => {
  await iris.stop();
  response.sendStatus(204);
});
```

Handle forwarded updates in the IDE UI using `sessionUpdate`:

```ts
function handleAgentUpdate(update: any) {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      appendAssistantText(update.content.text);
      break;
    case "agent_thought_chunk":
      appendReasoning(update.content.text);
      break;
    case "tool_call":
      showToolStarted(update.title, update.toolCallId);
      break;
    case "tool_call_update":
      updateToolStatus(update.toolCallId, update.status);
      break;
  }
}
```

The integration flow is:

```text
Custom IDE UI -> IDE backend -> IrisClient.spawn()
             -> iris-agent --acp -> ACP session/update events
             -> IDE backend -> WebSocket/IPC -> Custom IDE UI
```

## Development

```sh
npm run typecheck
npm run build
npm test
```

The repository also provides Make targets:

```sh
make test  # npm test with Jest's serial/forced-exit flags
make run   # npm start
make dev   # npm run dev
```

For production, run the compiled output from a process supervisor, restrict
`AGENT_ALLOWED_ORIGINS`, keep provider credentials in a secret store, protect
the HTTP service behind TLS/authentication, and use a writable persistent
location for the run database.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup,
validation, and pull request guidance. Use the repository's issue templates for
bug reports and feature requests. See [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)
for community expectations and [SECURITY.md](./SECURITY.md) for private
vulnerability reporting.

The project logo is available at
[`assets/iris-agent-logo.svg`](./assets/iris-agent-logo.svg) for repository and
community references. Keep the logo unchanged when using it as the project
mark.

## Package publishing

The package is configured for public npm publication:

```sh
npm login
npm publish
```

Yarn users can install the published package with:

```sh
yarn global add @4onstudios/iris-agent
```

Publishing requires access to the `@4onstudios` npm scope. The package is
configured with public access, but npm credentials and organization
permissions must be supplied by the publisher.

See [RELEASING.md](./RELEASING.md) for npm publication and versioning steps.

This project is released under the [MIT License](LICENSE).
