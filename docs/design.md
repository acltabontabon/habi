# Design direction — Loom

Habi is an instrument for developers. *Habi* is Tagalog for "weave": individual know-how,
woven into the projects where it helps. The interface is precise and quiet, and the weave is
its one signature — used only where it carries meaning.

## Expression

- **Two themes.** *Daylight*: crisp neutral surfaces (`--paper #f6f5f1`) and near-black ink.
  *Graphite*: deep neutral dark (`#0f0f11`) where colored threads read clearly. Both follow
  the system unless the user picks one.
- **Type with two voices.** IBM Plex Sans for reading, set tight and confident for titles.
  IBM Plex Mono is the machine voice: section labels, kickers, counts, paths, ids, stack
  tokens and CLI hints. Both fonts are bundled (OFL); there is no third face.
- **One accent: the saffron thread** (`--thread`). It marks selection and the line from a
  reason to the evidence behind it. It never fills large areas.
- **Dyes mark provenance.** Each library gets a natural-dye color (`--dye-0…7`, in the order
  libraries were connected): its *strand* in the sidebar and on every item row, its
  *selvedge* along the top of its page, its warp in the welcome loom. Team libraries are
  solid threads; **community libraries are stitched (dashed)** — published by others, not
  reviewed by the team. A dye is always next to the library's name; color is never the only
  signal.
- **A project is a swatch.** Its mark is woven from the dyes of the libraries whose items
  fit it, in a weave structure derived from its id. Nothing fits yet → an empty loom. The
  composition strip under the header shows the same threads as proportions, with counts.
- **Semantic colors are separate** (ok, unknown, warn, danger) and always paired with an
  icon and a word. Unknown has its own calm slate tone and a dashed mark: it is a valid
  result, not an error.
- **Structure through hairlines and section bars**, not cards. Recommendation groups are
  sticky section bars with a tone mark, a title in ink and a count, so a long list never
  loses its landmarks.
- **Developers' affordances.** Every main view can be reproduced from the command line; the
  matching `habi` command is shown quietly in mono where it helps.
- **Motion** only communicates: the welcome loom draws its weft and weaves its cloth once;
  selections fade their background. Nothing loops. `prefers-reduced-motion` turns motion off.

## Key screens

- **Welcome** — one question, one primary action (*Open a project…*), and two quiet
  alternatives (*Create a skill*, *Add existing skills*). A team library is not a
  prerequisite. Recent projects and drafts appear once there are any; the labeled sample
  workspace and the privacy line sit in the footer.
- **In this project** — skills and instruction files already in the repository, read-only,
  with real next actions (read, copy to My skills, turn part into a skill). Shown in place of
  recommendations when there is nothing to recommend yet.
- **Skill editor** — title, save state and actions above; *Purpose · Instructions ·
  Applicability · Files* in the main column; the applicability preview alongside (below on
  narrow windows). Conditions hang on the thread, the same line that later ties each reason to
  its evidence in the preview.
- **Add skills** — three sources as rows, then an inspection list with origin, problems and
  duplicate handling before anything is copied.
- **Project home** — the project's swatch, identity (name, path, branch), the recognized
  stack as mono tokens, the composition strip (which libraries fit, how much), and a
  list-and-detail workbench grouped by *Team requirements → Fits this project → Needs
  information → Available → Does not apply*. *Available* (no applicability rules) and *Does
  not apply* are collapsed, never hidden; installed items always stay listed.
- **Why this fits** — the four facets, a specific next action, the evaluation tree with
  threads to file:line chips that open an excerpt of the exact file, exclusions,
  prerequisites, evidence and scope/limits.
- **Workflow** — numbered steps on a vertical thread, references opening inline, "Prepare
  for my agent" kept apart from "Run a check".
- **Review** — clients and scope, every file with an expandable diff and plain explanation,
  conflicts with explicit choices, notes, the recovery promise, and a final button that names
  the action ("Install for Cursor in this project").
- **Libraries** — *Team libraries* and *Community* are separate sections. Connecting offers a
  short, fixed list of well-known community libraries (no index service, no ranking), then
  URL first, whose library it is, and everything else under advanced options. A library page
  leads with its selvedge, freshness, a stat strip (skills, with rules, shipping scripts,
  proprietary) and, for community libraries, what not having been reviewed means.
- **Sharing activity** — one dense row per contribution: a single state chip (with "checked …
  ago" for host-reported states), destination, last update and one next action. A
  contribution's page puts the file list beside the selected diff (stacked on narrow
  windows), validation split into blocking and warnings, and the destination with the title,
  message and one concretely named action ("Create pull request"). Its three-step thread
  (review, prepare branch, send) never marks an unopened request as done.

## Tokens and components

Tokens: `apps/desktop/src/styles/tokens.css`. Components: `src/components` (Button, Facet,
Status, Notice, Empty, Working, Dialog, DiffView, Markdown, Toasts, Icon/Mark, and the weave:
Strand, Swatch, Selvedge). Layout and view styles: `src/styles/app.css` and
`authoring.css`; the weave's own drawing: `src/styles/weave.css`. Library dyes:
`src/lib/dye.ts`.

## Accessibility

WCAG AA contrast targets for text tokens (ratios noted in `tokens.css`), visible focus
rings, semantic landmarks and headings, labelled controls, dialogs with focus traps,
keyboard navigation (↑/↓ or j/k in lists, ⌘K palette, ⌘O open, ⌘, settings, Esc), and an
automated axe-core check in the component tests. Status never relies on color alone.

## Design preview

`pnpm dev` in a plain browser loads a dev-only preview whose IPC answers come from JSON
generated by the real core (`cargo test -p habi-core --test ui_fixtures -- --ignored`). A
banner marks it as fixture data. It is excluded from production builds.
