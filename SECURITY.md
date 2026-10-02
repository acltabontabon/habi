# Security policy

Habi installs files into developers' repositories, runs Git with their credentials and can
push branches on their behalf, so we take security reports seriously.

## Reporting a vulnerability

Please **do not open a public issue.** Report privately through GitHub:
**Security → Report a vulnerability** on
[github.com/acltabontabon/habi](https://github.com/acltabontabon/habi/security/advisories/new),
or email **me@acltabontabon.com** with "Habi security" in the subject.

Include what you found, how to reproduce it (a minimal library or repository helps), and
the impact you expect. You will get an acknowledgement within 3 working days and a plan
within 10. We will credit you in the release notes unless you prefer otherwise.

## Supported versions

Habi is pre-release. Fixes go into the latest 0.x release only.

## In scope

For example:

- Library content (skills, `habi.yaml`, `habi-library.yaml`) causing writes outside the
  selected project, following symbolic links, or overwriting files without a preview.
- Library content or a Git host causing commands to run (hooks, filters, `gh`/`glab`
  arguments, verification checks) without the user's explicit action.
- Secrets leaking into installed files, MCP configuration, contribution branches, patches,
  logs or the diagnostic report.
- Text from a Git host (review comments, titles) being rendered as HTML or followed as
  links in the desktop app.
- Bypassing the desktop app's content security policy or command allow-list.

The intended boundaries are described in [docs/security.md](docs/security.md).

## Out of scope

- Behavior of the agents themselves (Claude Code, Cursor, Codex) after they load a skill.
- Issues requiring an attacker who can already write to your user account or your Git
  configuration.
