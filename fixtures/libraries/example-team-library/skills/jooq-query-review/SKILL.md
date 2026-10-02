---
name: jooq-query-review
description: Review jOOQ queries for correctness, index use and generated-code drift. Use when repository or query classes using jOOQ change.
---

# jOOQ query review

- Prefer generated table references over string SQL.
- Check that the generated code was regenerated after schema changes.
- Watch for missing `LIMIT` on list endpoints and unbounded `IN` lists.
- Use `fetchOptional`/`fetchOne` semantics deliberately.
