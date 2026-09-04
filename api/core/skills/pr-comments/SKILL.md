---
name: pr-comments
description: Address review comments (including Copilot review comments) on an existing pull request — implement requested changes, reply to reviewers, resolve threads. Triggers - "address review comments", "address PR comments", "apply reviewer suggestions", "respond to PR feedback", "implement requested changes", "resolve these threads". NOT for creating a new PR (use create-pr).
---

# PR Comments

## Workflow

1. Fetch the PR. If its last-updated timestamp is under 3 minutes old the PR is still changing — re-fetch with a refresh so you don't act on stale threads.
2. Collect unresolved feedback: inline threads not yet resolved, plus general review comments requesting changes.
3. Classify each: actionable code change, question, or opinion.
4. Implement actionable changes grouped by file; keep each change scoped to what the reviewer asked.
5. Commit with messages referencing the feedback; push after user confirmation.
6. Reply per thread: "Done in <commit>" for implemented items; a brief technical rationale when respectfully declining; ask for clarification when the request is ambiguous.
7. Resolve threads only after the change is pushed or the discussion is settled, and only where the thread is actually resolvable by you.

## Rules

- Never resolve a thread you haven't addressed.
- Skip threads already resolved, or that you lack permission to resolve.
- If a suggestion would introduce a bug or conflict with another comment, say so in the reply instead of silently skipping it.
- Report anything intentionally skipped, with the reasoning.
