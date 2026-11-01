# Skill Studio: weaving capabilities

## Current studio

The latest UI uses one contextual footer palette, inline support links, selection-only text formatting,
and a quiet Canvas / Agent view / Markdown icon group. When to use opens directly in a sidebar and
is optional. Improvements contain only validation issues and unfinished content; selecting a fix
scrolls to and highlights its target. Earlier sections below record the design iterations.

Current screenshots: [canvas](../media/skill-weaving/studio-current-canvas.png),
[agent view](../media/skill-weaving/studio-current-agent.png),
[optional setup](../media/skill-weaving/studio-current-when.png), and
[no optional warnings](../media/skill-weaving/studio-current-improvements.png).

This iteration builds on PR #42's editor and persistence model. The composition is an authoring
surface over an ordinary Agent Skills package. No capability behavior requires Habi UI state.

## Audit and design choice

The prior implementation already supplied source reconciliation, opaque Markdown preservation,
transactional moves, drag previews, skill provenance, composition metadata, autosave and conflict
handling. The generic piece tray, article typography and hidden composition controls made that
engineering read as a document editor.

Three directions were considered:

- A free-positioned thread canvas offers spatial freedom but implies a runtime graph and scales poorly.
- Making the existing section/skill matrix primary exposes composition clearly, but makes standalone
  skills and ordinary writing secondary and grows horizontally with every dependency.
- A continuous guidance structure with expertise joining at the instruction preserves reading order,
  direct writing and portability. Grouped connections provide the larger view only when needed.

The third direction is implemented as instruction-level composition. A compact identity states
the capability's purpose; the guidance shows its anatomy in a semantic gutter. Selecting a paragraph
or procedure step reveals its actual contributions and direct support actions. A quoted destination
stays visible while choosing a tool, supporting knowledge, an example, an asset or expertise.
The author states how or when it helps; that explanation becomes ordinary prose in the exact
instruction. Blank skills open an illustrated palette: instruction, sequence, decision, boundary,
example and result. Choosing one places actual editable starter content on the canvas in one action,
selecting the first words for replacement. Creation and editing stay on the canvas. The smaller
palette remains visible above composed guidance. Colored sequences, decisions and result pieces
express structure without implying an execution graph. Optional patterns remain behind a disclosure.
The selected unit exposes Edit, Add support, Move up/down and Add below (Add after procedure for a
nested step). Draft readiness lives alongside the identity rather than a bright header prompt.


## Implementation boundaries

- `DocEditor` retains one ProseMirror view across Compose, Agent view and Markdown visibility changes.
  Source editing retains its existing history behavior.
- `anatomyPlugin` derives visual structure from the document without changing its nodes or source.
- `CanvasPalette` offers illustrated pieces initially and a compact palette during composition.
  `insertCanvasPiece` inserts portable example nodes, selects the first editable phrase and keeps
  insertion and subsequent writing in separate undo steps. No generation or script execution occurs.
- `GuidanceActions` places controls at the selected unit; Edit focuses the live document. Advanced
  plain-field editing helpers retain source-preservation tests but are not the primary authoring flow.
- `guidanceContext` maps temporary instruction anchors through ProseMirror transactions. A deleted
  target is rejected; choosing support never silently redirects it to a later caret. Material purpose
  and skill conditions are inserted as literal text alongside portable links/skill atoms, in one undo.
- `InstructionSupport` follows keyboard and pointer selection, showing each instruction's existing
  contributions and actions. `MaterialWorkspace` carries a shared intent input through creation,
  import and same-file reuse; the shelf carries an explicit condition for selected-instruction use.
- `Overview` groups all uses by skill; its optional matrix preserves section operations. Nested uses
  cannot silently move an entire procedure through a control that promises to move one reference.
- `MaterialWorkspace` reuses `Materials`, `FileEditor`, `BinaryView`, safe import APIs and the global
  autosave registry. It lists recognized relationships directly from the live instruction document.
- `materialUses` identifies actual links, inline code paths and images; it skips fences, opaque content,
  remote targets and traversal. Detach/retarget edits only the chosen occurrence. No file is deleted.
- Paths remain inspectable and encoded correctly in Markdown. Displayed shell commands quote filenames.
  Neither previews nor creation execute scripts or install dependencies.
- Rename is explicitly a path-only operation with affected references shown before confirmation.
  Deletion is separately confirmed and explicitly irreversible in this UI.
- Rich preview is complemented by exact instruction text so unsupported source remains inspectable.

## Verification

Representative scratch packages cover standalone guidance, conditional PR review with a script,
a release review with fourteen distinct expertise threads and repeated uses, and missing references.
Screenshots in [skill-weaving](../media/skill-weaving/canvas-composed.jpg) include light, dark and
1024×700 layouts. Unit scenarios also cover twenty threads and one hundred uses.

The frontend regression suite includes preservation, single-action undo, contextual insertion,
repeated-reference navigation, read-only controls, missing materials, safe filenames, replacement,
conflict retention and accessibility checks. Real local skill corpora were also round-tripped.
Rust package, save-journal, export and composition tests were run without changing the persistence layer.

Real browser pointer input verified dragging Security Review to an insertion gap, the thread preview,
the connected instruction, and a single undo restoring both the Markdown and composition metadata.
Material relationships have distinct type glyphs, keyboard inspection, contextual editing and explicit
missing-file recovery. Material tooltip attributes belong to the editor decorations, avoiding mutations
by the global tooltip layer during hover. Pointer inspection captures the material before a selection
redraw can replace its decoration. URI-encoded filenames remain recognized by the material list.

Browser authoring checks covered script creation/editing/reuse and detaching one of two uses;
missing Markdown creation, editing and rendered preview; renaming to a spaced filename with impact
disclosed; reconnecting the resulting missing reference; importing a shell file through the path
picker with byte-identical contents; and cancelling a warned deletion while keeping the file intact.
A small edit in a complex-format fixture preserved every unrelated byte. Physical material inspection
was verified after the tooltip fix, without a synthetic-click fallback.

A synthetic 75 KB document with 500 blocks and 300 material references was exercised over 200 edits.
Plugin transaction p95 was 2.03 ms and serialization p95 was 0.14 ms in Node/jsdom; these figures exclude
browser layout and native rendering.

The earlier instruction-level flow passed 628 frontend tests in 44 files with the real skill corpus
enabled. The final visual-palette iteration passed 653 frontend tests across 46 files, with two
corpus-dependent tests skipped in that run; lint, typecheck and production build passed.
The full Rust run passed 1,042 tests with two ignored tests; formatting and clippy passed.
Repository script tests passed 70 tests with one skip. Typecheck and production build were checked
with four pre-existing deleted generated bindings temporarily restored from HEAD, then removed again.
Those unrelated deletions are preserved in the worktree.

The newcomer browser journey used visible authoring controls from a blank skill: purpose, a three-step
procedure, a Python helper created for the middle step, explicit helper purpose, conditional Security
Review on the same step, readiness review and installation into an isolated scratch project. The
installed package contained the authored prose and helper bytes without bundling the referenced skill.
Reusing that helper in step three created a second use of the same file; detaching the middle use kept
the other and the file intact, and undo restored the connection. Closing and reopening preserved both
purposes and the expertise condition. This is automated interaction evidence, not a human usability
study or a claimed human completion time.

At 1024×700, selected-instruction support is a compact expandable dock within reach, rather than a
panel below the entire document. Pointer and keyboard expansion were verified. Desktop support stays
beside the instruction, with a short destination excerpt and separate contribution purposes.

Actual macOS WKWebView checks verified a one-line edit on disk, undo restoring original bytes,
redo, and an immediate window close persisting the pending edit. The native shelf opened successfully.
Native pointer dragging/Finder drop could not be reverified in this session because screenshot capture
failed; the prior PR's tests remain evidence for those behaviors. IME and Windows/Linux interaction
remain unverified here. No merge or deployment is part of this change.

The final visual-canvas journey used the illustrated palette to place a sequence with one click,
then replaced the selected starter words by typing directly on the canvas. Moving one step and undoing
restored the exact order. Decision and result pieces were added and edited without a creation form.
A Python helper and Security Review were connected to the middle step; direct canvas editing preserved
both connections, and reopening retained their prose, metadata and helper bytes. The 1024px layout
had no horizontal page overflow. Current evidence is `canvas-initial.jpg`, `canvas-composed.jpg`,
`canvas-support.jpg`, and `canvas-composed-compact.jpg`; `studio-form-*` records a rejected iteration.


The visual connection layer derives step-local threads from actual package references and skill
mentions. Script, skill and reference cards are visible beneath each connected paragraph even when
another step is selected. Their purpose comes from the adjoining prose; unknown intent is labeled as
a reference/mention rather than invented. These are ProseMirror decorations, not document content:
save/export and undo keep their existing portable representation. Pointer and keyboard inspection
select the exact occurrence before opening its details. Missing materials and unresolved expertise
are visible. Tests cover repeated file uses, mixed connection types, source fidelity and undo; the
full frontend suite passed 657 tests with two corpus-dependent skips. Browser checks covered all
three connection types together under the middle procedure step. See `visual-threads.png`.


## Interactive canvas connections

Connections now carry Drag, Move to… and Disconnect controls on the canvas. Dragging an available
material or shelf skill onto a paragraph connects it to that exact step. Existing connection cards
can be dragged between steps. Habi-authored attachment sentences move with their purpose/condition;
manual inline links preserve the surrounding author prose. Disconnect removes only that use,
never the underlying package file. Each move/disconnect is one undoable edit.

Instruction targets stay stationary while a dragged contribution crosses gaps. Dropping an existing
connection outside a step cancels; dropping a shelf contribution outside the canvas also cancels.
Escape cancels active drags. The shelf's condition is retained on an exact-step skill drop, and its
picker closes after the successful connection. Move to… provides the equivalent keyboard operation.

The composed canvas offers two disclosures: Add a step and Give it support. The first reveals six
plain-language guidance choices; the second explains Another skill, A tool for the job, and Something
to read, with Skill/Script/Reference shown as secondary labels. Options close on selection, outside
click or Escape; the latter returns focus to the trigger. The blank canvas keeps its illustrated starters. The selected step
remains named, move arrows have accessible labels, and the connection cards retain visible actions.
Choosing a contribution closes the optional duplicate support panel. Explore patterns remains a
visible disclosure; only its count and the introductory helper sentence were removed.

Browser checks in the isolated scratch package covered all three contribution types: drag from the
shelf/material tray to a step, drag an existing card between steps, canvas disconnect, undo, keyboard
move, outside-drop cancellation, and saved package source. The script/reference files remained on disk.
The regression suite passed 669 tests with 2 skipped; lint reports only 6 existing warnings. Typecheck
is blocked solely by four pre-existing deleted generated binding files (AppInfo, Settings, UpdateInfo,
UpdateProgress). No generated bindings were restored or unrelated changes reverted.

Final canvas and support chooser: [interactive weave](../media/skill-weaving/interactive-weave.png), [support choices](../media/skill-weaving/support-choices.png).


### Inline connections replace duplicate branches

The repeated connection section beneath each instruction has been removed. Skills and material links
remain in the instruction itself. A small adjacent options control reveals Open, Drag, Move to… and
Disconnect; the options control can also be dragged directly. The popup stays inside the canvas and
closes on outside click or Escape. Widgets remain excluded from saved Markdown. Browser verification
covered inline disconnect/undo and dragging a skill connection to another step with its condition intact.

### Floating studio palette

The primary tools now live in the bottom studio dock: Add a step, Give it support, and View.
Upward-opening palettes use amber, sage, and lavender accents; View contains Canvas, Connections,
Agent view, and Markdown. The dock replaces both the page-wide tool row and the separate Add guidance
button. It remains available in preview/source modes and reserves space below the canvas.
Selected-piece actions live behind one corner options button, with outside-click/Escape dismissal.
Legacy branch widgets and drag-ring styling are explicitly retired during live updates.

### Final palette: collapsible footer

The floating dropdown dock is superseded by a full-width collapsible footer tray. Steps, Support,
and View select directly visible choices; the tray remembers its selected group when collapsed.
It reserves layout space rather than covering the document. Blank skills retain their illustrated
starting canvas. Browser checks verified footer insertion/undo, support selection, and collapse/expand.
The full frontend suite passes 670 tests, with 2 skipped. Typecheck retains only the existing missing
generated-binding errors. See [footer palette](../media/skill-weaving/footer-palette.png).


### Unified palette and caret formatting

The footer is the common home for Steps, Support, and View. Selected-step actions stay in that tray; the duplicate support sidebar and step options popover are removed. Connection options open the same Support tray with Open, drag, move, and disconnect actions. Formatting stays above the focused caret, works without a text selection, and hides on scroll or blur. It is not a palette category.

Step tiles drag into top-level gaps or between numbered steps. Support category tiles can be dropped onto an exact instruction to open its skill/material chooser. Existing contributions still move between instructions and disconnect without deleting their underlying files. Palette drags no longer autoscroll while the pointer is outside the canvas.

Validated in an isolated browser tab: insertion between steps, reference target capture, connection move/disconnect and undo, and formatting at an unselected caret. Frontend suite: 672 passed, 2 skipped. Typecheck remains limited by the four pre-existing missing generated bindings. Screenshots: `docs/media/skill-weaving/unified-palette.png` and `docs/media/skill-weaving/caret-format.png`.

### Context-following tools

The palette starts with step choices and switches to support when an instruction is activated by pointer or keyboard. Clicking blank canvas resets it; interactions inside the palette retain the selected instruction. View controls live in the studio header and preview modes hide the authoring palette. Removed redundant Edit words/Add support controls and duplicated target labels. The caret toolbar uses a smaller default set and hints `Type / for skills & files`; the slash chooser temporarily replaces it.

Support capture now uses the plugin installed in the live editor, so an editor surviving a development module reload still opens pickers. Regression coverage includes reloaded target capture, selection-driven palette changes, and deselection. Browser checks confirmed skill and script card clicks, slash discovery, and header view switching. Full suite: 673 passed, 2 skipped.

### Final palette arrangement

Heading and Divider are direct insertion actions before Steps in the palette bar, separated from contextual tool categories. There is no separate organization row. Support appears automatically for an active instruction and contains only the skill, script, and reference choices; the redundant material shortcut, selected-kind label, and reorder row were removed. Formatting appears only for a nonempty text selection. The slash hint remains in the palette bar, with no popup while simply typing. Verified heading/divider insertion and undo in the browser. Full suite: 676 passed, 2 skipped; final arrangement checks: 33 passed. Screenshot: `docs/media/skill-weaving/arranged-palette.png`.

### Structural dragging and quiet tray chrome

Heading and Divider drag to the same insertion guides as steps. Dropping inside a numbered procedure splits the list around the structural element, preserves later numbering in both Markdown and CSS counters, and undoes in one action. Dividers between steps do not add a stray empty instruction. Verified both structural drags and undo in the browser; regression tests cover exact ordering and numbering. The margin plus and its insertion entry point are removed in studio mode; the existing drag grip remains.

The tray label itself toggles collapse, with a quiet typographic treatment and subtle separator rather than a pill. Removed the separate Collapse control, persistent slash hint, and default purpose helper copy. Length feedback appears only near the description limit. Full suite before final presentation edits: 678 passed, 2 skipped; subsequent affected checks passed. Typecheck still reports only the pre-existing generated-binding omissions. Final screenshot: `docs/media/skill-weaving/quiet-palette.png`.
