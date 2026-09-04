---
name: dev-server
description: Start, stop, or troubleshoot local development servers — pick the right script, run as a background process, handle port conflicts, report the URL. Triggers - "start the dev server", "run the app locally", "start frontend and backend", "port already in use".
---

# Dev Server

## Workflow

1. Find the dev command: check `package.json` scripts (or Makefile / framework config) — never guess.
2. Check the target port is free; if occupied, identify the process and ask before killing it, or use an alternate port.
3. Start the server as a long-running background process (never block on it).
4. Wait for the ready signal in output; report the URL and port.
5. On startup failure, read the error output and fix the cause — don't blindly restart.

## Rules

- Multiple services (frontend + backend): start each separately and confirm each is ready.
- Reuse an already-running healthy server instead of starting a duplicate.
- Stop servers you started when the user is done with them.
