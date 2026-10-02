/**
 * One skill's trip through Habi, as the command line printed it: from
 * another team's library, into a repository, improved, and back to everyone.
 *
 * Captured from habi 0.1.0 against this repository's fixtures: the example
 * team library as a Git repository, billing-service and platform-monorepo.
 * Output is trimmed (marked "…") and machine paths are shortened to ~/work;
 * nothing else is changed. Reproduce with website/scripts/journey.sh.
 */
export type Step = {
  id: "explore" | "check" | "use" | "pay" | "everyone";
  verb: string;
  title: string;
  says: string;
  cwd: string;
  terminal: { cmd: string; out: string }[];
};

export const journey: Step[] = [
  {
    id: "explore",
    verb: "Explore",
    title: "Another team's library, connected",
    says: "A Git repository you already have access to. Nothing to migrate, nothing to host.",
    cwd: "",
    terminal: [
      {
        cmd: 'habi source add "Platform team" git@example.invalid:platform/agent-skills.git',
        out: 'Connected `Platform team`. Fetch it with: habi source refresh "Platform team"',
      },
      {
        cmd: "habi source refresh",
        out: `Platform team: now at 2a2d123763 (10 new, 0 updated, 0 removed). Installed copies were not changed.
    new: api-contract-review
    new: java-service-conventions
    new: liquibase-migration-review
    new: service-observability
    …`,
      },
    ],
  },
  {
    id: "check",
    verb: "Check",
    title: "What fits this repository, and why",
    says: "Read from pom.xml — nothing built, nothing run.",
    cwd: "billing-service",
    terminal: [
      {
        cmd: "habi recommend",
        out: `Fits this project
  Liquibase migration review  [Platform team/liquibase-migration-review]
      Uses Spring Boot (pom.xml:6) · declares org.liquibase:liquibase-core (pom.xml:31) · uses Liquibase (pom.xml:31)
      not installed · ready · evidence: declared by author · next: install
  JPA entity review  [Platform team/jpa-entity-review]
      Uses JPA / Hibernate (pom.xml:27)
      …
  GitHub PR summary  [Platform team/github-pr-summary]
      Uses GitHub Actions (ci.yml)
      not installed · prerequisite missing · evidence: not evaluated · next: set up prerequisites
…
6 items do not apply (show with --all).`,
      },
    ],
  },
  {
    id: "use",
    verb: "Use",
    title: "In the agent you already use",
    says: "Every file previewed first. Every change restorable.",
    cwd: "billing-service",
    terminal: [
      {
        cmd: "habi install liquibase-migration-review --client claude-code,cursor",
        out: `Install for Claude Code and Cursor in this project
  • Liquibase migration review from Platform team (5018e1b232)

  create .claude/skills/liquibase-migration-review/habi.yaml  (+53 −0)
    Claude Code and Cursor read skills from .claude/skills.
  …
  create .claude/skills/liquibase-migration-review/SKILL.md  (+26 −0)
    Claude Code and Cursor read skills from .claude/skills.

  create .habi/lock.json  (+50 −0)
    Records what Habi installed (sources, versions, file digests) so it can detect updates and local edits.
…
Done. Operation 05d2d302 (4 files). Undo with: habi restore 05d2d302 -C ~/work/billing-service`,
      },
    ],
  },
  {
    id: "pay",
    verb: "Pay it forward",
    title: "Your fix, back where it came from",
    says: "Only what you include leaves your machine. The owning team reviews and merges.",
    cwd: "billing-service",
    terminal: [
      {
        cmd: "habi status",
        out: `Liquibase migration review  edited locally  (Platform team · 5018e1b232 · Claude Code, Cursor)
    .claude/skills/liquibase-migration-review/SKILL.md edited locally`,
      },
      {
        cmd: 'habi contribute start "Platform team" .claude/skills/liquibase-migration-review',
        out: `dc4a773756a9  [draft]  Share Liquibase migration review
to Platform team › skills/liquibase-migration-review (base 74898d6f78, branch habi/contrib/liquibase-migration-review-dc4a77)

Changed files (only included ones leave this machine):
  [x] changed   skills/liquibase-migration-review/SKILL.md (+3 −1)

Checked: package format, Habi metadata, file references, secrets — nothing to fix.`,
      },
      {
        cmd: "habi contribute commit dc4a773756a9",
        out: "Committed 814d0a1c29 on branch habi/contrib/liquibase-migration-review-dc4a77 (in Habi's cache; nothing was pushed).\nNext: habi contribute publish dc4a773756a9 --open-request",
      },
    ],
  },
  {
    id: "everyone",
    verb: "Everyone gets it",
    title: "The next project starts from it",
    says: "Reviewed and merged by the team. Picked up on refresh.",
    cwd: "platform-monorepo",
    terminal: [
      {
        cmd: "habi source refresh",
        out: `Platform team: now at 697a40fbc4 (0 new, 1 updated, 0 removed). Installed copies were not changed.
    updated: liquibase-migration-review`,
      },
      {
        cmd: "habi update",
        out: `Adopt the reviewed update in this project
  • Liquibase migration review from Platform team (74898d6f78 → 697a40fbc4)

  modify .claude/skills/liquibase-migration-review/SKILL.md  (+3 −1)
    -6. Summarize findings as: blocking issues, risks, suggestions.
    +6. On MySQL, check the table's size first: an \`ALTER TABLE\` that copies
    +   the table blocks writes until it finishes. Say roughly how long.
    +7. Summarize findings as: blocking issues, risks, suggestions.`,
      },
    ],
  },
];
