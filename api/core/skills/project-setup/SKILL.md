---
name: project-setup
description: Scaffold a complete NEW project from scratch — framework init, config files, dependencies, folder structure, verified build. Triggers - "create a new React/Next.js/Vite/Node project", "set up a workspace", "scaffold an app". NOT for adding files or features to an existing project.
---

# Project Setup

## Workflow

1. Confirm framework, language, and package manager from the request; ask only if genuinely ambiguous.
2. Prefer the official scaffolding CLI (`npm create vite@latest`, `npx create-next-app`, etc.) over hand-writing config.
3. Install dependencies with the chosen package manager.
4. Add essentials the scaffold omits: `.gitignore`, TypeScript strictness, lint/format config if requested.
5. Verify: run the build (and dev server briefly) to prove the setup works before handing off.
6. Summarize the structure and the commands to run.

## Rules

- Use current stable versions; never pin to outdated majors.
- Don't add tooling the user didn't ask for beyond the essentials above.
