# Recovery and failure handling

## Applying changes

Multi-file changes cannot be a single file-system transaction, so Habi uses a write-ahead
journal per operation (`<data>/journal/<project-id>/<operation-id>.json`):

1. Take the project lock (shared by desktop and CLI).
2. Roll back any operation a crash left in `applying` state.
3. Re-check every precondition digest. Any difference → `stalePlan`; nothing is written.
4. Store the current content of every file that will change in the blob store, then save
   the journal (`applying`).
5. Apply each change atomically, marking progress in the journal.
6. Mark the journal `committed`.

| Situation | What happens |
|---|---|
| A step fails (permission, disk full) | Completed steps are undone; journal → `rolledBack`. |
| The process dies mid-apply | The next operation on the project, or "Check for interrupted operations" (`habi recover`), undoes it. |
| A file changed after Habi wrote it, before undo | It is left as is and reported; journal → `needsAttention`. Its earlier version stays in the blob store. |
| Restore of a completed operation | Built as a normal plan; files edited since the operation become conflicts. |
| A step changed only a file's executable bit | Rolling back or restoring puts the bit back (the journal records each file's mode). |

The lock file is always the last step, so an interrupted apply never records files that were
not written.

### Restoring and the lock file

Restore does not put `.habi/lock.json` back as a file, because later operations may have
changed it too. Habi recomputes it instead:

- Items the restored operation did not change keep their current entries.
- Items a later operation changed again stay as they are now (the preview says so).
- The other items go back to their entries from before the operation.
- In every case, only what the restore leaves on disk is recorded. A file the restore
  deletes is no longer listed, and a file you chose to keep stays listed with the content
  it has.

### Known limitations

- **Case-only renames.** Restoring an operation that only changed the letter case of a file
  name (`checklist.md` → `Checklist.md`) restores nothing on a case-insensitive file system
  (macOS and Windows by default). The content is identical, and the lock records the old
  name, which still finds the file there, but the file keeps the new letter case. Rename it
  by hand if the old case matters.
- **Lock files from earlier versions.** Lock files written before this release do not record
  whether Habi created `AGENTS.md`, `CLAUDE.md` or an MCP configuration file. For those
  entries Habi deletes such a file only if nothing at all is left in it (instructions), or
  not at all (MCP). An older lock may also record one MCP server for only one of the items
  that need it, or one `AGENTS.md` section for two items. Habi leaves a section another item
  still records in place; reinstalling an affected item records the server for it too.
- **New MCP servers in an update.** An update adopts changed definitions of servers Habi
  added, and removes servers the item no longer needs. It does not add a server the item
  newly suggests; the preview says so, and installing the item again with *Add suggested
  MCP configuration* adds it.

## Sources

| Situation | What happens |
|---|---|
| Network/authentication failure on refresh | The last good snapshot stays; the source is marked stale with the error and its time. |
| Interrupted fetch | Git's own atomic ref updates leave the bare cache usable; the next refresh retries. |
| Corrupted cached content | Blob reads verify SHA-256; corruption is reported and a refresh restores the content. |
| Corrupted snapshot metadata | Reported with "refresh the source"; other sources are unaffected. |
| A tag moved or history was rewritten | Warning on the source; updates must still be reviewed before adoption. |

## Local database

- Migrations run in transactions. Before migrating an existing database, Habi keeps a copy
  (`habi.db.pre-v<N>.bak`). A failed migration leaves the previous database unchanged.
- A database written by a newer Habi is refused rather than modified. Move it aside to start
  fresh (projects and installed files are unaffected; re-add sources).
- Nothing in the database is needed for installed skills to work.

## Projects

- A moved or deleted project shows as *missing*; Habi does not recreate it.
- Malformed manifests mark coverage as failed with the reason; inspection continues.
- A malformed `.habi/lock.json` blocks install/update with a clear message instead of being
  overwritten.

## Destructive resets are not the default

No recovery path in Habi asks the user to delete their data. The data folder can be removed
safely at any time: installed project files are ordinary files and keep working.

## Local skills

| Situation | What happens |
|---|---|
| A draft save fails (disk full, permissions) | The editor shows *Not saved* and keeps the text on screen; the file on disk is the last successful write (writes are atomic). |
| The app closes or crashes while editing | Edits are written within a second of a pause, on ⌘S, on window blur and when leaving the editor. At most the last moment of typing is lost; the draft reopens from disk. |
| The draft's files were edited outside Habi | The next save is refused as a conflict. Choose *Show the other version* or *Keep mine*; nothing is overwritten until you do. |
| `SKILL.md` no longer parses (hand-edited frontmatter) | The editor says so and opens the file as plain text under *Files* to repair it. |
| A draft was moved to the trash by mistake | *My skills → Trash → Restore*. |
| Network is unavailable | Creating, editing, previewing, importing from folders/projects, installing and exporting all work. Connecting or refreshing a Git library and sending a contribution fail with a specific error and can be retried; the draft is unaffected. |
| Upgrading from 0.1.0 data | The database is migrated to schema v2 (adds `local_skills`); a copy of the previous database is kept as `habi.db.pre-v2.bak`. |
