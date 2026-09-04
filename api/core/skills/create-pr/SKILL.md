---
name: create-pr
description: Create a GitHub pull request from current changes — branch, commit, push, title/description, linked issues, draft or ready. Triggers - "create/open a PR", "submit as pull request", "draft PR". NOT for responding to review feedback on an existing PR (use pr-comments).
---

# Create PR

## Workflow

1. Verify state: `git status`, current branch, diff vs default branch. Never open a PR from the default branch — create a feature branch if needed.
2. Commit and push outstanding changes (confirm with the user before pushing).
3. Use the repository's PR template if one exists (`.github/PULL_REQUEST_TEMPLATE*`); otherwise use the fallback below.
4. Title: imperative, ≤72 chars, describes the change not the activity.
5. Link issues with closing keywords (`Fixes #123`) when applicable.
6. Create as draft if the user wants early feedback; otherwise ready for review.

## Fallback description format

```
## Summary
What changed and why (2-4 sentences).

## Testing
How the change was verified.

Fixes #<issue> (if applicable)
```

## Rules

- Keep the PR focused; flag unrelated changes instead of bundling them.
- Mention screenshots for UI changes.
