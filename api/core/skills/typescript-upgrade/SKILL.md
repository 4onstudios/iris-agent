---
name: typescript-upgrade
description: Upgrade npm dependencies in a TypeScript project and resolve breaking changes — staged upgrades, type-check verification, migration of changed APIs. Triggers - "upgrade dependencies", "update TypeScript/React to latest", "resolve dependency conflict", "migrate to <major version>".
---

# TypeScript Upgrade

## Workflow

1. Baseline first: confirm build, type-check, and tests pass BEFORE upgrading. Fix or note pre-existing failures.
2. Inventory: `npm outdated`; identify majors vs minors/patches.
3. Upgrade in stages — minors/patches in one batch; each major separately.
4. For each major: check the changelog/migration guide, upgrade, fix compile errors and changed APIs, run type-check + tests before moving to the next.
5. Keep related packages in lockstep (e.g. `react`/`react-dom`/`@types/react`; a library and its plugins).
6. Final gate: full build + test suite green; then commit with a summary of versions changed.

## Rules

- Never combine multiple major upgrades in one step — isolate failures.
- If a major upgrade breaks and can't be fixed quickly, revert that package and report the blocker rather than leaving the repo broken.
- Verify peer-dependency warnings; don't silence them with `--force`.
