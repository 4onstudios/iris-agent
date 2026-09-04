---
name: search-results
description: Format GitHub search results for display — sortable tables, filtered views, counts, side-by-side comparisons with links. Triggers - "show results in a table", "sort by comments", "only open issues", "compare these". NOT for running the search itself (use github-search).
---

# Search Results

## Workflow

1. Take the result set (from github-search or provided by the user); apply any requested filter/sort first.
2. Render as a markdown table. Default columns: Title (linked) | State | Author | Created | Comments. Adjust columns to what's relevant.
3. End with a one-line stat: total shown / total found, breakdown by state if mixed.

## Rules

- Every title must be a direct GitHub link.
- Truncate titles at ~60 chars with `…`.
- Default sort: relevance; state the sort order used when it differs.
- >20 results: show top 20 and say how many were omitted.
