---
name: liquibase-migration-review
description: Review Liquibase changelogs for safe, reversible database migrations. Use when a change adds or edits files under db/changelog, or when asked to review a schema migration.
license: Apache-2.0
metadata:
  maintainer: platform-guild
---

# Liquibase migration review

Use this skill when a change touches Liquibase changelogs (`db/changelog/**`).

## Procedure

1. Find the master changelog and confirm every new changeset is included from it.
2. For each new changeset, check the items in [the checklist](references/checklist.md).
3. Never edit a changeset that may already be applied. Add a new one instead.
4. Confirm each changeset has a `rollback` or is explicitly marked irreversible
   with a reason in its `comment`.
5. Flag locking risks: adding `NOT NULL` columns without defaults, building
   indexes on large tables without `CONCURRENTLY` (PostgreSQL), renames.
6. Summarize findings as: blocking issues, risks, suggestions.

## Output

A short review with file and changeset ids for every finding.
