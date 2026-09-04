---
name: github-summary
description: Summarize a single GitHub issue, PR, or notification — key points, decisions, open questions, action items. Triggers - "summarize this issue/PR", "what's this discussion about", "what are the action items". NOT for searching (use github-search).
---

# GitHub Summary

## Workflow

1. Fetch the full item: title, description, all comments, and for PRs the changed-files overview.
2. Extract decisions and requirements from the discussion — weight recent comments and maintainer responses higher.
3. Output in this format, omitting empty sections:

```
**Overview**: 1-2 sentences.
**Key points**: bullets (max 5).
**Decisions**: what was agreed.
**Open questions**: unresolved items.
**Action items**: who/what, if identifiable.
```

## Rules

- Report only what is in the thread; never infer decisions that weren't made.
- Keep the whole summary under ~150 words unless the user asks for detail.
