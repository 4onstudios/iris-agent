---
name: search-integration
description: Search the local workspace codebase — exact text, regex, and file-type-filtered searches with contextual results. Triggers - "find all usages of", "where is X defined/imported", "locate TODO comments", "find files matching". NOT for GitHub-wide search (use github-search).
---

# Search Integration

## Workflow

1. Pick the cheapest query that answers the question: exact string for identifiers; regex with alternation (`foo|bar`) to cover variants in ONE pass; glob file filters to cut noise.
2. Run the search; if zero hits, broaden once (case variants, partial word) before concluding it's absent.
3. Report file paths with line numbers and a snippet of surrounding context per match.
4. Group matches by file; note total count.

## Rules

- Escape regex metacharacters when the user gives a literal string.
- Distinguish definitions from usages when the user asks "where is X" — show the definition first.
- Too many hits (>50): narrow by directory or file type instead of dumping everything.
