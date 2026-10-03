# Command line

The `habi` command is an internal tool, not part of a release: it is not built into the
installers or offered for download, and its output and exit codes carry no compatibility
promise. It exists to drive `habi-core` without the desktop app, for the test data
([test-data.md](test-data.md)), the website snapshot ([website.md](website.md)) and the CLI tests
in `crates/habi-cli/tests`. It does what the desktop app does with libraries, projects, installs
and contributions. Both use the same core and the same data folder, and you can run them at the
same time.

```sh
cargo install --path crates/habi-cli    # from a clone of the repository
habi --help                             # every command; `habi <command> --help` for one
```

## How commands behave

- **The project.** Commands find the project from the current folder: the nearest folder with
  `.habi/lock.json`, else the Git root, else the current folder. `-C <folder>` names it
  explicitly.
- **Previews.** Every command that changes files shows the plan and asks before applying it.
  `--yes` skips the question; `--dry-run` only shows the preview.
- **Conflicts.** When a file was edited since Habi wrote it, the plan stops at a conflict. Add
  `--keep <path>` to keep your version or `--overwrite <path>` to take Habi's (the previous
  content is kept in the journal). Both can be repeated.
- **JSON.** With `--json`, each command prints exactly one JSON document on standard output.
  Errors are `{"error": {"code", "message"}}` with a nonzero exit status, and commands that
  change files need `--yes` or `--dry-run`.

## Libraries

```sh
habi source add Team git@github.com:your-team/skills.git --branch main
habi source add Local ./path/to/library                 # a folder on this machine
habi source add Superpowers https://github.com/obra/superpowers --community
habi source refresh                                     # fetch; never changes a project
habi source list
habi source items Team
habi source role Superpowers team                       # or: community
habi source remove Team                                 # installed copies are kept
```

`source add` takes `--subdir` to use one folder of the repository, and `--branch` or `--tag`
to track something other than the default branch. It does not fetch; run `habi source refresh`
next.

The built-in [catalog](../library-authors/catalog.md) of public libraries:

```sh
habi catalog list
habi catalog preview <id> --skills      # fetch and look inside; nothing is connected
habi catalog connect <id>               # connect it as a community library
habi catalog forget <id>                # discard a preview
```

## Projects

```sh
habi inspect                                   # what Habi detects, with evidence
habi recommend                                 # what fits, with a one-line reason
habi recommend --all                           # also what does not apply, and unmatched items
habi explain liquibase-migration-review        # the full reasoning and its checks
```

When several libraries have an item with the same id, name it as `<library>/<id>`, for example
`Team/jpa-entity-review`.

## Installing and updating

```sh
habi install liquibase-migration-review --client claude-code,cursor
habi install jpa-entity-review --client codex --mcp --dry-run
habi status                                    # installed items, local edits, updates
habi update                                    # every item with an update, three-way
habi remove jpa-entity-review
habi history                                   # operations Habi performed here
habi restore <operation>                       # undo an operation
habi recover                                   # roll back an interrupted operation
```

`--client` takes a comma-separated list of `claude-code`, `cursor`, `codex`, `gemini-cli`,
`copilot`, `opencode` and `junie`. Without it, Habi installs for the agent tools the project
already uses ([how it tells](../guide/agent-tools.md#choosing-which-tools)); if it finds none, it asks
you to name them. `--mcp` also adds the MCP server configuration an item suggests.

Installing on this machine (into your own skill folders) is available in the desktop app only.

## Correcting what Habi detected

```sh
habi declare tag db:jooq --absent --note "migrated away"
habi declare tag framework:spring-boot --present --module .
habi declarations                              # with ids
habi undeclare <id>
```

A declaration applies to every module unless you pass `--module`: `.` is the repository root,
and `habi inspect` lists the other module ids. It is labeled as yours wherever it is used, and
can be removed.

## Running an item's checks

```sh
habi check liquibase-migration-review changelog-is-wellformed           # preview only
habi check liquibase-migration-review changelog-is-wellformed --run     # asks, then runs
```

A check runs a program from the library with your privileges, without a sandbox. `--bind
name=value` chooses a binding from the listed candidates, and `--module` picks where it runs.

## Contributing

```sh
habi contribute start Team .claude/skills/my-skill    # a skill folder in this project
habi contribute start Team --item jpa-entity-review   # or an item in the library
habi contribute show <id>                             # what would leave this machine
habi contribute describe <id> --title "…" --message "…"
habi contribute exclude <id> notes.md                 # leave a changed file out (`include` undoes it)
habi contribute rehearse <id>                         # where its rules apply, as text for reviewers
habi contribute commit <id>                           # a branch in Habi's cache; nothing is pushed
habi contribute export <id> ~/Desktop                 # a patch file
habi contribute publish <id> --open-request           # push, and open a pull or merge request
habi contribute status <id>                           # state and comments from the host
habi contribute revise <id>                           # then commit and publish again
habi contribute commit <id> --build-on-remote         # only if someone else pushed to the branch
habi contribute cancel-revision <id>
habi contribute list
habi contribute discard <id>
```

[Sharing](../guide/sharing.md) explains each step and what Habi does and does not do on the Git host.

## Maintenance

```sh
habi validate path/to/library        # check a library before publishing it
habi diagnostics --output report.txt # a redacted report for a bug report
habi gc                              # free disk space
```

`habi gc` keeps what can still be restored; [Recovery](../guide/recovery.md#freeing-space) says what it
removes. Skills in My skills are managed in the desktop app; the command line has no commands for them
yet.
