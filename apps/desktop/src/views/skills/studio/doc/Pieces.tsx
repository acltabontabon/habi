/**
 * What a page can be made of, within reach. Pick one up and put it where it goes,
 * or press it to add it at the caret. Each glyph is a small picture of the piece,
 * so what's on offer can be read without trying any of it.
 */
import type { Node as PMNode } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";
import { type ReactNode, type PointerEvent as ReactPointerEvent, useEffect, useId, useState } from "react";
import { ghostLabel } from "./drag";
import { markdownForFile } from "./fileRefs";
import { parseBody } from "./markdown/parse";
import { schema } from "./markdown/schema";
import { placeBlocks } from "./moves";

const { nodes } = schema;

type Piece = {
  id: string;
  label: string;
  hint: string;
  glyph: ReactNode;
  make?: () => PMNode[];
  /** For a piece that needs a choice made first. */
  choose?: "skill" | "file";
};

const para = (text?: string) => nodes.paragraph.create(null, text ? schema.text(text) : null);
const item = (attrs?: Record<string, unknown>) => nodes.list_item.create(attrs ?? null, para());

const line = (y: number, w = 14, x = 2) => <rect x={x} y={y} width={w} height="1.6" rx=".8" />;

const PIECES: Piece[] = [
  {
    id: "heading",
    label: "Section",
    hint: "A heading that starts a part",
    glyph: <rect x="2" y="4" width="11" height="3.4" rx="1" />,
    make: () => [nodes.heading.create({ level: 2 }), para()],
  },
  {
    id: "steps",
    label: "Steps",
    hint: "A numbered procedure",
    glyph: (
      <>
        <circle cx="3" cy="4" r="1.3" />
        {line(3.2, 10, 6)}
        <circle cx="3" cy="9" r="1.3" />
        {line(8.2, 10, 6)}
        <circle cx="3" cy="14" r="1.3" />
        {line(13.2, 7, 6)}
      </>
    ),
    make: () => [nodes.ordered_list.create(null, item())],
  },
  {
    id: "checklist",
    label: "Checklist",
    hint: "Things to confirm",
    glyph: (
      <>
        <rect x="1.5" y="2.5" width="3.4" height="3.4" rx=".8" />
        {line(3.4, 10, 7)}
        <rect x="1.5" y="10" width="3.4" height="3.4" rx=".8" />
        {line(10.9, 8, 7)}
      </>
    ),
    make: () => [nodes.bullet_list.create(null, item({ checked: false }))],
  },
  {
    id: "code",
    label: "Code",
    hint: "An example to follow",
    glyph: (
      <path
        d="M6 4 2.5 9 6 14M12 4l3.5 5L12 14"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ),
    make: () => [nodes.code_block.create()],
  },
  {
    id: "note",
    label: "Note",
    hint: "Worth knowing",
    glyph: (
      <>
        <rect x="1.5" y="3" width="15" height="12" rx="2" opacity=".28" />
        {line(6.5, 10, 4)}
        {line(10, 7, 4)}
      </>
    ),
    make: () => [nodes.blockquote.create({ callout: "NOTE" }, para())],
  },
  {
    id: "table",
    label: "Table",
    hint: "Rows and columns",
    glyph: (
      <path
        d="M2 4h14v10H2zM2 9h14M7 4v10"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    ),
    make: () => {
      const row = (type: typeof nodes.table_cell) =>
        nodes.table_row.create(null, [type.create(), type.create(), type.create()]);
      return [
        nodes.table.create(null, [row(nodes.table_header), row(nodes.table_cell), row(nodes.table_cell)]),
        para(),
      ];
    },
  },
  {
    id: "file",
    label: "File",
    hint: "A picture, reference or script",
    glyph: (
      <path
        d="M4 2.5h6.5L14 6v9.5H4zM10.5 2.5V6H14"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    ),
    choose: "file",
  },
  {
    id: "skill",
    label: "Skill",
    hint: "A link to another skill, for where it applies",
    glyph: (
      <>
        <circle cx="9" cy="9" r="3" />
        <path d="M1 9h16" fill="none" stroke="currentColor" strokeWidth="1.2" />
      </>
    ),
    choose: "skill",
  },
];

export function Pieces({
  view,
  files,
  onChoose,
  landInto,
}: {
  view: EditorView;
  /** The skill's own files, for the File piece to offer. */
  files: () => { path: string; name: string; referenced: boolean }[];
  /** The caret is where it should go: let the author choose which. */
  onChoose: (what: "skill" | "file") => void;
  /** Runs a drag for a new piece, with where it lands. */
  landInto: (event: PointerEvent, ghost: HTMLElement, land: (at: number) => void) => void;
}) {
  const [filesOpen, setFilesOpen] = useState(false);
  const [hint, setHint] = useState<Piece | null>(null);
  const [quiet, setQuiet] = useState(false);
  const hintId = useId();

  useEffect(() => {
    if (!filesOpen) return;
    const away = (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest?.(".doc-tray")) setFilesOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFilesOpen(false);
    };
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", esc);
    };
  }, [filesOpen]);

  // Writing, the tray steps back. It's there again the moment the pointer moves.
  useEffect(() => {
    const writing = (e: KeyboardEvent) => {
      if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) setQuiet(true);
    };
    const wake = () => setQuiet(false);
    view.dom.addEventListener("keydown", writing);
    view.dom.addEventListener("blur", wake);
    window.addEventListener("mousemove", wake);
    return () => {
      view.dom.removeEventListener("keydown", writing);
      view.dom.removeEventListener("blur", wake);
      window.removeEventListener("mousemove", wake);
    };
  }, [view]);

  const blocksFor = (path: string) => {
    const blocks: PMNode[] = [];
    parseBody(markdownForFile(path)).doc.forEach((child) => {
      blocks.push(child);
    });
    return blocks;
  };

  const caretSlot = () => {
    const $from = view.state.selection.$from;
    return $from.depth > 0 ? $from.after(1) : view.state.doc.content.size;
  };

  const atCaret = (piece: Piece) => {
    if (piece.choose === "file") {
      setFilesOpen((open) => !open);
      return;
    }
    if (piece.make) {
      const $from = view.state.selection.$from;
      const at = view.hasFocus() && $from.depth > 0 ? $from.after(1) : view.state.doc.content.size;
      const empty = $from.depth === 1 && $from.parent.content.size === 0;
      placeBlocks(view, empty ? $from.before(1) : at, piece.make());
    } else if (piece.choose) {
      view.focus();
      onChoose(piece.choose);
    }
  };

  const lift = (e: ReactPointerEvent, piece: Piece) => {
    landInto(e.nativeEvent, ghostLabel(piece.label), (at) => {
      if (piece.make) placeBlocks(view, at, piece.make());
      else if (piece.choose) {
        placeBlocks(view, at, [para()]);
        if (piece.choose === "file") setFilesOpen(true);
        else onChoose(piece.choose);
      }
    });
  };

  return (
    <div className={`doc-tray${quiet ? " is-quiet" : ""}`} role="toolbar" aria-label="Add to the page">
      {hint && !filesOpen ? (
        <div className="doc-tray-hint" role="tooltip" id={hintId}>
          {hint.hint}. Drag it to where it belongs, or press to add it at the caret.
        </div>
      ) : null}
      {filesOpen ? (
        <div className="doc-tray-files">
          {files().map((f) => (
            <button
              key={f.path}
              type="button"
              className="sk-file"
              title="Drag it to where it belongs, or press to add it at the caret"
              onPointerDown={(e) =>
                landInto(e.nativeEvent, ghostLabel(f.name), (at) => {
                  setFilesOpen(false);
                  placeBlocks(view, at, blocksFor(f.path));
                })
              }
              onClick={() => {
                setFilesOpen(false);
                placeBlocks(view, caretSlot(), blocksFor(f.path));
              }}
            >
              {f.name}
            </button>
          ))}
          <button
            type="button"
            className="sk-file-more"
            onClick={() => {
              setFilesOpen(false);
              onChoose("file");
            }}
          >
            Bring in a new file…
          </button>
        </div>
      ) : null}
      {PIECES.map((piece) => (
        <button
          key={piece.id}
          type="button"
          className={`doc-piece is-${piece.id}`}
          aria-describedby={hint === piece ? hintId : undefined}
          onMouseEnter={() => setHint(piece)}
          onMouseLeave={() => setHint(null)}
          onFocus={() => setHint(piece)}
          onBlur={() => setHint(null)}
          onPointerDown={(e) => lift(e, piece)}
          onClick={() => atCaret(piece)}
        >
          <svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor" aria-hidden="true">
            {piece.glyph}
          </svg>
          <span>{piece.label}</span>
        </button>
      ))}
    </div>
  );
}
