# Iris Agent

Iris Agent is the standalone coding-agent service used by [AIRIS](https://github.com/4onstudios/iris).

It provides streaming chat, workspace tools, LSP routes, MCP integration, command approvals, and run lifecycle APIs. It can run as:
- **HTTP Service** - RESTful API under `/api/agent`
- **CLI** - Interactive chat in the terminal
- **ACP Server** - Agent Client Protocol via stdio for seamless IDE integration

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

### CLI Mode

```sh
OPENAI_API_KEY=... npm run cli -- --workspace /path/to/project --chat
```

This starts an interactive chat session in your terminal with access to the workspace.

### ACP Server

```sh
OPENAI_API_KEY=... npm run cli -- --workspace /path/to/project --acp
```

This starts an ACP (Agent Client Protocol) server that listens on stdio, allowing IDE integrations and other ACP clients to communicate with the agent.

## CLI Usage

```sh
iris-agent --workspace <path> [--acp | --chat] [--port <port>]
```

**Options:**
- `--workspace` (required) - Path to the workspace/project root
- `--acp` - Start ACP protocol server (stdio-based)
- `--chat` - Start interactive chat mode
- `--port <port>` - Port number (used by HTTP mode, default: 8080)

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

## ACP Protocol

The ACP server supports the following custom RPC methods:

- `chat` - Send a message to the agent
  - **Params:** `{ message: string }`
  - **Response:** `{ success: boolean, response: any }`

- `list_tools` - Get available tools
  - **Params:** `{}`
  - **Response:** `{ tools: Tool[] }`

- `list_skills` - Get available skills
  - **Params:** `{}`
  - **Response:** `{ skills: string[] }`

- `workspace_info` - Get workspace metadata
  - **Params:** `{}`
  - **Response:** `{ workspaceRoot: string, timestamp: string, agentVersion: string }`

## Development

```sh
npm run typecheck
npm run build
npm test
```

This project is released under the [MIT License](LICENSE).
