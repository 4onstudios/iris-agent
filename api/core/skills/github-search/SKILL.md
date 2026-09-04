---
name: github-search
description: Build and run GitHub search queries for issues, PRs, code, and repos using qualifier syntax (state, label, author, repo, language, dates). Triggers - "search GitHub for", "find issues/PRs about X", "find code using this pattern". NOT for formatting existing results (use search-results) or summarizing one item (use github-summary).
---

# GitHub Search

## Workflow

1. Translate the request into qualifier syntax; combine filters for precision.
2. Execute the search.
3. Return results with direct GitHub URLs and one-line context each; hand off to search-results for table formatting.
4. If results are too broad/narrow, refine qualifiers once before asking the user.

## Qualifier reference

- `type:issue|pr` · `state:open|closed` · `is:merged|draft`
- `repo:owner/name` · `org:name` · `author:user` · `assignee:user`
- `label:"bug"` · `in:title,body` · `language:typescript`
- `created:>2026-01-01` · `updated:<2026-06-01` · `comments:>10`
- `sort:updated-desc` · negate with `-` (e.g. `-label:wontfix`)
