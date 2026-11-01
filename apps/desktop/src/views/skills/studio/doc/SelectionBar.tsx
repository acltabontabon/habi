/** What can be done to selected words, beside them. */
import type { MarkType } from "prosemirror-model";
import { TextSelection } from "prosemirror-state";
import { CellSelection } from "prosemirror-tables";
import type { EditorView } from "prosemirror-view";
import { type CSSProperties, type KeyboardEvent, useEffect, useRef, useState } from "react";
import {
  markActive,
  setHeading,
  setLink,
  toggleBold,
  toggleCode,
  toggleItalic,
  toggleStrike,
} from "./commands";
import { schema } from "./markdown/schema";

const { marks, nodes } = schema;

type Spot = { left: number; top: number; below: boolean };

function spotFor(view: EditorView): Spot | null {
  const { selection } = view.state;
  if (selection.empty || !(selection instanceof TextSelection) || selection instanceof CellSelection)
    return null;
  if (selection.$from.parent.type.spec.code) return null;
  if (!view.hasFocus()) return null;
  const from = view.coordsAtPos(selection.from);
  const to = view.coordsAtPos(selection.to);
  const left = (from.left + to.left) / 2;
  const below = from.top < 120;
  return { left, top: below ? to.bottom + 8 : from.top - 8, below };
}

export function SelectionBar({
  view,
  tick,
  onLinkSkill,
}: {
  view: EditorView;
  tick: number;
  onLinkSkill?: (query: string) => void;
}) {
  const [spot, setSpot] = useState<Spot | null>(null);
  const [linking, setLinking] = useState(false);
  const [href, setHref] = useState("");
  const input = useRef<HTMLInputElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: tick is what says the selection moved.
  useEffect(() => {
    if (linking) return;
    setSpot(spotFor(view));
  }, [tick, view, linking]);

  useEffect(() => {
    const away = () => setSpot((s) => (linking ? s : spotFor(view)));
    view.dom.addEventListener("blur", away);
    window.addEventListener("resize", away);
    return () => {
      view.dom.removeEventListener("blur", away);
      window.removeEventListener("resize", away);
    };
  }, [view, linking]);

  if (!spot) return null;

  const state = view.state;
  const run = (command: (s: typeof state, d: typeof view.dispatch) => boolean) => {
    command(view.state, view.dispatch);
    view.focus();
  };
  const toggle = (label: string, shown: string, type: MarkType, keys: string, command: typeof toggleBold) => (
    <button
      type="button"
      className={`doc-bar-btn is-${label.toLowerCase()}`}
      aria-label={label}
      aria-pressed={markActive(state, type)}
      title={`${label} (${keys})`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => run(command)}
    >
      {shown}
    </button>
  );

  const openLink = () => {
    const link = state.doc
      .slice(state.selection.from, state.selection.to)
      .content.firstChild?.marks.find((m) => m.type === marks.link);
    setHref((link?.attrs.href as string) ?? "");
    setLinking(true);
    requestAnimationFrame(() => input.current?.select());
  };
  const finishLink = (save: boolean) => {
    if (save) setLink(href.trim() || null)(view.state, view.dispatch);
    setLinking(false);
    view.focus();
  };
  const onLinkKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      finishLink(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finishLink(false);
    }
  };

  const inHeading = state.selection.$from.parent.type === nodes.heading;
  const style: CSSProperties = { left: spot.left, top: spot.top };
  return (
    <div
      className={`doc-bar${spot.below ? " is-below" : ""}`}
      style={style}
      role="toolbar"
      aria-label="Format selected text"
    >
      {linking ? (
        <label className="doc-bar-link">
          <span className="visually-hidden">Link address</span>
          <input
            ref={input}
            value={href}
            placeholder="https:// or a file in this skill"
            onChange={(e) => setHref(e.target.value)}
            onKeyDown={onLinkKey}
            onBlur={() => finishLink(false)}
          />
        </label>
      ) : (
        <>
          {toggle("Bold", "B", marks.strong, "⌘B", toggleBold)}
          {toggle("Italic", "I", marks.em, "⌘I", toggleItalic)}
          {toggle("Code", "</>", marks.code, "⌘E", toggleCode)}
          {toggle("Strikethrough", "S", marks.strike, "⌘⇧X", toggleStrike)}
          <span className="doc-bar-gap" aria-hidden="true" />
          <button
            type="button"
            className="doc-bar-btn"
            aria-pressed={inHeading}
            title="Heading"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => run(setHeading(2))}
          >
            Heading
          </button>
          <button
            type="button"
            className="doc-bar-btn"
            aria-pressed={markActive(state, marks.link)}
            title="Link"
            onMouseDown={(e) => e.preventDefault()}
            onClick={openLink}
          >
            Link
          </button>
          {onLinkSkill ? (
            <button
              type="button"
              className="doc-bar-btn is-skill"
              title="Name another skill here"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                const { from, to } = view.state.selection;
                onLinkSkill(view.state.doc.textBetween(from, to, " "));
              }}
            >
              Link a skill
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}
