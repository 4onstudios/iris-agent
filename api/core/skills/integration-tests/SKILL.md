---
name: integration-tests
description: Generate integration tests in four layers — L1 TestContainers (DB/queue/cache in Docker), L2 smoke tests, L3 cloud/Azure integration, L4 end-to-end behavioral flows. Triggers - "add integration tests", "create TestContainers/smoke/e2e tests". NOT for unit tests.
---

# Integration Tests

## Layer selection

Ask which layer(s) if the user didn't specify. Default to L1 + L2.

- **L1 TestContainers**: real DB/queue/cache in Docker containers; test the data/messaging boundary.
- **L2 Smoke**: app starts, critical endpoints/happy paths respond, basic error handling.
- **L3 Cloud (Azure)**: real service connectivity, auth flows, managed identity — requires provisioned resources; confirm they exist first.
- **L4 Behavioral**: full user workflows across components, data consistency end-to-end.

## Workflow

1. Identify integration points from the code (DB clients, HTTP clients, queues, external SDKs).
2. Use the project's existing test framework and conventions — inspect current tests first.
3. Write fixtures with realistic data; every test must clean up its resources (containers, rows, files).
4. Name tests after the scenario they verify, not the method they call.
5. Run the new tests and iterate until green; then run the existing suite to confirm no interference.

## Rules

- Tests must be independent and order-agnostic; enable parallel execution where the framework supports it.
- Never hardcode credentials — use env vars or the framework's secret mechanism.
- If Docker isn't available, say so and offer L2 alternatives instead of writing untestable code.
