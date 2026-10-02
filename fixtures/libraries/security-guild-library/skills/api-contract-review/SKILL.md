---
name: api-contract-review
description: Security-focused review of API contracts — authentication, authorization scopes and data exposure. Use when an OpenAPI document changes.
---

# API contract review (security)

This skill shares its name with the platform team's API review on purpose: Habi must
keep the two apart by source and report the collision when both would install to the
same directory.

1. Every operation declares a security requirement.
2. No response exposes internal identifiers or personal data without need.
3. Error responses do not leak stack traces.
