# Changelog checklist

- [ ] Changeset `id` and `author` are set and unique.
- [ ] The changeset is included from the master changelog.
- [ ] A rollback exists, or the comment explains why it is irreversible.
- [ ] New `NOT NULL` columns have a default or a backfill step.
- [ ] Large-table index creation will not lock writes.
- [ ] No previously released changeset was modified (checksum change).
- [ ] Data migrations are idempotent.
