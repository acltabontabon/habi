---
name: jpa-entity-review
description: Review JPA/Hibernate entity mappings for N+1 queries, fetch strategy and transaction boundaries. Use when entity classes or repositories change.
---

# JPA entity review

- Default to `FetchType.LAZY` for associations; justify every `EAGER`.
- Look for N+1 patterns in loops over associations; prefer fetch joins or entity graphs.
- Keep `equals`/`hashCode` stable for detached entities (business key or id-based with care).
- Check `@Transactional` boundaries on service methods that modify entities.
