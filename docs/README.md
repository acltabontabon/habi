# Habi documentation

**New here?** Start with [Getting started](guide/getting-started.md)—sample workspace included, takes ~5 minutes.

Habi finds skills that fit your repo, installs them for your agent tools, and carries improvements back to your library. Local, no account or telemetry.

![The welcome: a headline beside the three threads, find, improve and share, and a card of what Habi works with: Git found, the project stacks it reads, and the seven agent tools.](media/welcome.jpg)

## Using Habi

| Guide | Read it to |
| --- | --- |
| [Getting started](guide/getting-started.md) | Try the sample workspace, open your first project, and know what Habi changes |
| [My skills](guide/my-skills.md) | Write a skill in the Skill Studio, bring in the ones you have, test where it applies, and use it |
| [Sharing](guide/sharing.md) | Send an improved skill to a library as a pull or merge request, follow the review, and revise it |
| [Agent tools](guide/agent-tools.md) | See what Habi writes for Claude Code, Cursor, Codex, Gemini CLI, GitHub Copilot, OpenCode and Junie |
| [Recovery](guide/recovery.md) | Restore a change, finish an interrupted one, and free up space |

## Writing libraries

| Guide | Read it to |
| --- | --- |
| [Habi metadata](library-authors/metadata-schema.md) | Say when a skill applies with `habi.yaml`, and describe a library with `habi-library.yaml` |
| [Detectors](library-authors/detectors.md) | Know what Habi recognizes in a repository, and where that stops |
| [Library catalog](library-authors/catalog.md) | See how the public libraries Habi suggests are chosen, and propose one |

## About Habi

| Document | Read it to |
| --- | --- |
| [Product contract](project/product.md) | Read the principles Habi keeps, what it is not, and where it is going |
| [Security model](project/security-model.md) | Know what Habi trusts, what it never does, and every network request it makes |

## Working on Habi

| Document | Read it to |
| --- | --- |
| [Contributing](../CONTRIBUTING.md) | Set up, run the checks, and send a change |
| [Architecture](dev/architecture.md) | Find your way around the crates and modules, install scopes, data locations, and the UI in a browser |
| [Release](dev/release.md) | Learn the toolchain, versioning, signing and updates, and follow the release checklist |
| [Test data](dev/test-data.md) | Use the fixtures, the sample workspace and the seed script |
| [Design](dev/design.md) | Keep to the visual direction, the key screens and the accessibility rules |
| [Compatibility research](dev/compatibility-research.md) | Check each agent tool's documented paths, and run the smoke tests |
| [Reuse assessment](dev/reuse-assessment.md) | See which dependencies Habi uses, and why some logic is its own |
| [The website](dev/website.md) | Build the site, and see how these pages are published on it |
| [Decisions](dev/decisions/) | Read why Habi supports [seven agent tools](dev/decisions/0001-seven-agent-tools.md) and [installs on this machine](dev/decisions/0002-install-on-this-machine.md) the way it does |

## Documentation map

| Path | For |
|------|-----|
| `README.md` (root) | What Habi is & how to build it |
| `docs/guide/` | Using Habi—tasks, step-by-step |
| `docs/library-authors/` | Writing & curating skill libraries |
| `docs/project/` | Product promises, security model |
| `docs/dev/` | Habi development (why, not what) |
| `website/` | Published docs at [acltabontabon.com/habi/docs](https://acltabontabon.com/habi/docs) |
