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
  libraries were connected): its *strand* in the sidebar and on every item row, its warp
  down the library's index (and its spine), its warp in the welcome loom. Team libraries are
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

- **Home: the loom** — the principle as a headline ("What one developer learns, every
  project keeps."), a three-line lifecycle block (sources · refining · shared, each a link),
  and the loom: warp threads are knowledge sources, weft rows are your projects, and a
  source's thread surfaces as a float where its knowledge applies to that project. A saffron
  knot marks where a refinement from a project went back into a library. The last row is
  unwoven and holds the one primary action, *Open a project…* (read-only). Rows and source
  names are controls; pointing at one brings what it connects to forward. It scales (ten
  source columns, seven rows, "+N more") and stays composed when empty: faint rows keep the
  cloth's texture, and a first run shows undyed threads with a faint twill. Creating and
  adding skills live in the sidebar, palette and project views; their shortcuts sit at the
  foot with the labeled sample workspace on a first run.
- **In this project** — skills and instruction files already in the repository, read-only,
  with real next actions (read, copy to My skills, turn part into a skill). Shown in place of
  recommendations when there is nothing to recommend yet.
- **Skill editor** — title, save state and actions above; *Purpose · Instructions ·
  Applicability · Files* in the main column; the applicability preview alongside (below on
  narrow windows). Conditions hang on the thread, the same line that later ties each reason to
  its evidence in the preview.
- **Add skills** — three sources as rows, then an inspection list with origin, problems and
  duplicate handling before anything is copied.
- **Project home** — below 1020 px the header compacts (icon actions on the title row) and the
  workbench shows the list or one item with "← Recommendations", never both squeezed. The
  wide layout: the project's swatch, identity (name, path, branch), the recognized
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
- **Sidebar** — navigation first: projects, My skills, *Libraries*, Contributions when there
  are any. Connected libraries are one family on one warp — a hairline spine through each
  source's thread (stitched for community) — that continues into a small open knot, *Explore
  libraries →*: the collection goes on. No headings for provenance (team, community, local,
  Git or folder are in each tooltip, the Libraries page and the source sheet). Opening a
  project appears on hover or focus of its heading (and ⌘O); creating a skill is ⌘N. Below
  720 px the sidebar becomes a rail of icons and threads.
- **Libraries** — a destination of its own: *Connected* (team · local · community, with
  freshness), *Discover* (a short curated list of community libraries not yet connected, each
  previewed — what it covers, about how many skills, licence, trust — before *Connect
  library*), and *Your own* (connect a Git repository, use a folder; each a focused page).
- **Library** — an index of knowledge and one reading surface. The index is the library's
  warp: its thread runs down the rail (stitched for community) and each skill is a pick across
  it — a hanging initial, the title, a one-line purpose (agent trigger text left out), quiet
  mono marks for rules and scripts; the chosen skill is crossed by the saffron weft. The
  library itself is two lines (name and count; repository · team/community · freshness).
  Typing in the index filters it ("/" from anywhere); ↑/↓ or j/k move, Enter reads. While
  reading, the rest of the index steps back until pointed at. The reader: **one document
  surface at a time** — the skill's head (library · trust · position; title with *Add to a
  project…* and *Edit a copy*; the human summary; a signature line: scripts emphasized,
  files, languages, rules, lineage; *Details* and *Contents*) above SKILL.md, or one of its
  files in place of it (← or Esc returns to the same scroll position). *Details* unfolds the
  full description as written, rules, needs, licence, source and notes. *Contents* (⌘I,
  remembered for the session) opens the package as an inspector beside the document: root
  files, language folders as an index line when there are several, other folders with
  counts, and *Runs* — the files an agent could run. While it is open the index folds into
  the library's spine (name set vertically on its thread, position below), which opens over
  the reader on hover, focus or click. Below 980 px the index is a bar above the reader
  ("Anthropic / Claude API · 5 / 20 ▾") and the inspector comes in over the reader's edge.
  Git details (repository, revision, refresh, who reviews it, disconnect) live in a sheet
  opened from the library's address. The same reader shows an item's content inside a
  project, with a quiet package line in place of the head.
- **Contributions** — one dense row per contribution: a single state chip (with "checked …
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
tab title marks it as fixture data. It is excluded from production builds.
