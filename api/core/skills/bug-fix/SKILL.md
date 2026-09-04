---
name: bug-fix
description: Diagnose and FIX a bug end-to-end — reproduce, find root cause, apply the smallest safe code change, verify with tests. Triggers - "fix this bug", "this is broken", "resolve this error", failing test/build. NOT for advisory-only recommendations without editing code (use fix-suggestions).
---

# Bug Fix

## Workflow

1. Gather evidence: exact error text, logs, stack trace, failing test.
2. Reproduce the failure (or isolate a deterministic trigger) BEFORE editing code.
3. Trace to root cause. Never patch symptoms.
4. Apply the minimal fix, preserving existing conventions. No refactors, no unrelated changes.
5. Validate: run the failing test plus directly related tests/lint/build.
6. Add a regression test when practical.
7. Report: root cause, change made, verification evidence — briefly.

## Rules

- If not reproducible, state assumptions and the next diagnostic steps explicitly; do not guess-fix.
- One bug per fix. If you discover other issues, mention them; don't fix them unasked.
