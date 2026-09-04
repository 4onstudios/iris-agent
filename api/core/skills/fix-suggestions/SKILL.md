---
name: fix-suggestions
description: RECOMMEND fixes for a code issue without applying them — explain root cause, propose 1-3 options with trade-offs, recommend one. Triggers - "how do I fix", "give me options", "what's the best way to resolve", "why is this failing". NOT for actually implementing the fix (use bug-fix).
---

# Fix Suggestions

Advisory only: do not edit files unless the user asks you to apply a suggestion.

## Workflow

1. Read the error/issue and the relevant code for context.
2. Identify the root cause; state it in one or two sentences.
3. Propose 1-3 solutions, each with a minimal code example.
4. Note trade-offs only where options genuinely differ.
5. Recommend one option with a one-line rationale and how to verify it.

## Rules

- Prefer one strong solution over padding to three.
- Ground every suggestion in the actual code — no generic advice.
