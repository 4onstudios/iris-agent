# Iris Agent

Iris Agent is the standalone coding-agent HTTP service used by [AIRIS](https://github.com/4onstudios/iris).

It provides streaming chat, workspace tools, LSP routes, MCP integration, command approvals, and run lifecycle APIs under `/api/agent`.

## Run locally

```sh
npm install
OPENAI_API_KEY=... npm start
```

The service listens on port `8080` by default. Set `PORT` to change it. `GET /health` reports service readiness.

## Connect a browser client

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

## Development

```sh
npm run typecheck
npm test
```

This project is released under the [MIT License](LICENSE).
