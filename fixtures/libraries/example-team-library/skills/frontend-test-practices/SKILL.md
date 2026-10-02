---
name: frontend-test-practices
description: Write and review Vitest/Testing Library tests for web front ends. Use when adding or changing front-end tests.
---

# Front-end test practices

- Query by role and accessible name; avoid test ids unless nothing else works.
- Assert on behaviour the user can observe.
- Fake timers and network at the boundary, not inside components.
- Keep each test independent; no shared mutable fixtures.
