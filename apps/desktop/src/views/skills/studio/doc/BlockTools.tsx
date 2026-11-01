/**
 * The controls that belong to the block the caret is in, sitting on that block:
 * a table's rows and columns, a code block's language, a callout's kind, a link's
 * address. Nothing to go looking for, and nothing showing until it's relevant.
 */
import type { Node as PMNode } from "prosemirror-model";
import { addColumnAfter, addRowAfter, deleteColumn, deleteRow, isInTable } from "prosemirror-tables";
import type { EditorView } from "prosemirror-view";
import { useEffect, useState } from "react";
import { setLink } from "./commands";
import { schema } from "./markdown/schema";

const { nodes, marks } = schema;

const KINDS = ["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"];
const LANGUAGES = ["", "sh", "python", "js", "ts", "json", "yaml", "md"];

type Tool =
  | { kind: "table"; top: number; left: number; width: number }
  | { kind: "code"; pos: number; node: PMNode; top: number; left: number; width: number }
  | { kind: "callout"; pos: number; node: PMNode; top: number; left: number; width: number }
  | { kind: "link"; href: string; top: number; left: number };

function toolFor(view: EditorView, wrap: HTMLElement | null): Tool | null {
  if (!wrap || !view.hasFocus()) return null;
  const origin = wrap.getBoundingClientRect();
  const { $from, empty } = view.state.selection;
  const placed = (pos: number) => {
    const el = view.nodeDOM(pos);
    if (!(el instanceof HTMLElement)) return null;
    const r = el.getBoundingClientRect();
    return { top: r.top - origin.top, left: r.left - origin.left, width: r.width };
  };
  if (isInTable(view.state)) {
    for (let d = $from.depth; d > 0; d--) {
      if ($from.node(d).type === nodes.table) {
        const at = placed($from.before(d));
        // A table's own DOM is wrapped: what's measured is the table itself.
        if (at) return { kind: "table", ...at };
      }
    }
  }
  if ($from.parent.type === nodes.code_block) {
    const pos = $from.before();
    const at = placed(pos);
    if (at) return { kind: "code", pos, node: $from.parent, ...at };
  }
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    if (node.type === nodes.blockquote && node.attrs.callout) {
      const pos = $from.before(d);
      const at = placed(pos);
      if (at) return { kind: "callout", pos, node, ...at };
    }
  }
  if (empty) {
    const link = $from.marks().find((m) => m.type === marks.link);
    if (link) {
      const c = view.coordsAtPos($from.pos);
      return {
        kind: "link",
        href: link.attrs.href as string,
        top: c.bottom - origin.top + 4,
        left: c.left - origin.left,
      };
    }
  }
  return null;
}

export function BlockTools({
  view,
  tick,
  wrap,
  onOpenLink,
}: {
  view: EditorView;
  tick: number;
  wrap: () => HTMLElement | null;
  onOpenLink: (href: string) => void;
}) {
  const [tool, setTool] = useState<Tool | null>(null);
  const [editing, setEditing] = useState(false);
  const [href, setHref] = useState("");

  // biome-ignore lint/correctness/useExhaustiveDependencies: tick is what says the caret moved.
  useEffect(() => {
    setTool(toolFor(view, wrap()));
    setEditing(false);
  }, [tick, view]);

  useEffect(() => {
    const refresh = () => setTool(toolFor(view, wrap()));
    view.dom.addEventListener("focus", refresh);
    return () => view.dom.removeEventListener("focus", refresh);
  }, [view, wrap]);

  if (!tool) return null;
  const hold = (e: { preventDefault: () => void }) => e.preventDefault();
  const run = (command: (s: typeof view.state, d: typeof view.dispatch) => boolean) => {
    command(view.state, view.dispatch);
    view.focus();
  };

  if (tool.kind === "table") {
    return (
      <div
        className="doc-tools is-table"
        style={{ top: tool.top - 30, left: tool.left }}
        role="toolbar"
        aria-label="This table"
      >
        <button type="button" onMouseDown={hold} onClick={() => run(addRowAfter)}>
          Add row
        </button>
        <button type="button" onMouseDown={hold} onClick={() => run(addColumnAfter)}>
          Add column
        </button>
        <button type="button" onMouseDown={hold} onClick={() => run(deleteRow)}>
          Remove row
        </button>
        <button type="button" onMouseDown={hold} onClick={() => run(deleteColumn)}>
          Remove column
        </button>
      </div>
    );
  }

  if (tool.kind === "code") {
    const info = (tool.node.attrs.info as string).trim();
    const choices = LANGUAGES.includes(info) ? LANGUAGES : [info, ...LANGUAGES];
    return (
      <div
        className="doc-tools is-code"
        style={{ top: tool.top + 6, left: tool.left + tool.width - 150, width: 144 }}
      >
        <label>
          <span className="visually-hidden">Language</span>
          <select
            value={info}
            onChange={(e) => {
              view.dispatch(view.state.tr.setNodeAttribute(tool.pos, "info", e.target.value));
              view.focus();
            }}
          >
            {choices.map((l) => (
              <option key={l} value={l}>
                {l || "Plain text"}
              </option>
            ))}
          </select>
        </label>
      </div>
    );
  }

  if (tool.kind === "callout") {
    const kind = tool.node.attrs.callout as string;
    const choices = KINDS.includes(kind) ? KINDS : [kind, ...KINDS];
    return (
      <div className="doc-tools is-callout" style={{ top: tool.top + 8, left: tool.left + 12 }}>
        <label>
          <span className="visually-hidden">Kind of note</span>
          <select
            value={kind}
            onChange={(e) => {
              view.dispatch(view.state.tr.setNodeAttribute(tool.pos, "callout", e.target.value));
              view.focus();
            }}
          >
            {choices.map((k) => (
              <option key={k} value={k}>
                {k[0]}
                {k.slice(1).toLowerCase()}
              </option>
            ))}
          </select>
        </label>
      </div>
    );
  }

  return (
    <div className="doc-tools is-link" style={{ top: tool.top, left: tool.left }}>
      {editing ? (
        <input
          // biome-ignore lint/a11y/noAutofocus: the author just asked to edit this address.
          autoFocus
          aria-label="Link address"
          value={href}
          onChange={(e) => setHref(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              setLink(href.trim() || null)(view.state, view.dispatch);
              setEditing(false);
              view.focus();
            } else if (e.key === "Escape") {
              setEditing(false);
              view.focus();
            }
          }}
        />
      ) : (
        <>
          <span className="doc-tools-address">{tool.href}</span>
          <button
            type="button"
            onMouseDown={hold}
            onClick={() => {
              setHref(tool.href);
              setEditing(true);
            }}
          >
            Edit
          </button>
          <button type="button" onMouseDown={hold} onClick={() => onOpenLink(tool.href)}>
            Open
          </button>
          <button type="button" onMouseDown={hold} onClick={() => run(setLink(null))}>
            Remove
          </button>
        </>
      )}
    </div>
  );
}
