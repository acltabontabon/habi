---
name: api-contract-review
description: Review OpenAPI specification changes for breaking changes and consistency. Use when an openapi.yaml/json changes or when designing a new endpoint.
license: Apache-2.0
---

# API contract review

1. Diff the OpenAPI document against the base branch.
2. Classify every change using [breaking changes](references/breaking-changes.md).
3. Check naming (camelCase properties, plural collection paths), pagination and
   error responses (`application/problem+json`).
4. For breaking changes, require a version bump or a deprecation plan.
5. Report: breaking changes, risky changes, style issues.
