---
name: agent-customization
description: Create, fix, or debug agent customization files — SKILL.md, .instructions.md, .prompt.md, .agent.md, copilot-instructions.md — including frontmatter and trigger issues. Triggers - "create a custom agent/skill", "add agent instructions", "why isn't this skill triggering".
---

# Agent Customization

## File types

- `SKILL.md` — one skill per directory (`skills/<name>/SKILL.md`); YAML frontmatter requires `name` and `description`.
- `.instructions.md` — global/always-on instructions.
- `.prompt.md` — system prompt customizations.
- `.agent.md` — agent definitions and modes.
- `copilot-instructions.md` — VS Code Copilot repo config.

## Writing effective skills

- Only the frontmatter `description` is loaded into the agent prompt; the body is read on demand. Spend effort on the description.
- Description formula: what it does + trigger phrases + "NOT for X (use Y)" disambiguation from overlapping skills. Keep it to 1-3 sentences on ONE line (multi-line YAML breaks discovery).
- Body: imperative workflow steps and hard rules only — no capability marketing, no generic best practices.

## Debugging "skill not triggering"

1. Check frontmatter parses: `name:` and `description:` each on a single line at the top of the file.
2. Check the directory layout (`skills/<dir>/SKILL.md`) and that the skill isn't disabled in user preferences.
3. Check the description actually contains the phrases users say — vague descriptions don't match intent.
4. Check for a duplicate `name` in another skills directory — higher-precedence dirs override.
