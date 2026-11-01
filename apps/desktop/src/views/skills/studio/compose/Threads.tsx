/**
 * The composition, in the margin of the page: a hairline with a knot beside each
 * place a skill is deliberately used, level with the words that use it. It's drawn
 * from the document, so it grows as you write and there's nothing to connect by
 * hand. No composed skills draws nothing at all.
 */
import type { EditorView } from "prosemirror-view";
import { type CSSProperties, useEffect, useMemo, useState } from "react";
import { knotColor } from "./knots";
import { occurrencesIn, roleWords } from "./roles";

export type ThreadStatus = "found" | "unsure" | "missing";

type Knot = {
  key: string;
  top: number;
  uses: { name: string; title: string; role: string | null; pos: number; status: ThreadStatus }[];
};

const MIN_GAP = 44;
/** More than this in one block is shown as one counted knot. */
const GATHER_ABOVE = 2;

function measure(view: EditorView, look: (name: string) => { title: string; status: ThreadStatus }): Knot[] {
  const host = view.dom.parentElement;
  if (!host) return [];
  const origin = host.getBoundingClientRect();
  const byBlock = new Map<number, Knot>();
  for (const o of occurrencesIn(view.state.doc)) {
    if (o.role === null) continue;
    const chip = view.nodeDOM(o.pos);
    const el = chip instanceof HTMLElement ? chip : null;
    if (!el) continue;
    const rect = el.getBoundingClientRect();
    const top = rect.top - origin.top + rect.height / 2;
    const known = look(o.name);
    const use = { name: o.name, title: known.title, role: o.role, pos: o.pos, status: known.status };
    const knot = byBlock.get(o.blockPos);
    if (knot) knot.uses.push(use);
    else byBlock.set(o.blockPos, { key: String(o.blockPos), top, uses: [use] });
  }
  const knots = [...byBlock.values()].sort((a, b) => a.top - b.top);
  // Notes that would overlap step down, keeping their order.
  for (let i = 1; i < knots.length; i++) {
    const prev = knots[i - 1];
    const here = knots[i];
    if (prev && here && here.top < prev.top + MIN_GAP) here.top = prev.top + MIN_GAP;
  }
  return knots;
}

export function Threads({
  view,
  tick,
  look,
  onOpen,
  onOverview,
  expanded,
}: {
  view: EditorView | null;
  /** Changes when the document has settled. */
  tick: number;
  look: (name: string) => { title: string; status: ThreadStatus };
  onOpen: (pos: number) => void;
  onOverview: () => void;
  expanded: boolean;
}) {
  const [knots, setKnots] = useState<Knot[]>([]);
  const [layout, setLayout] = useState(0);

  useEffect(() => {
    const host = view?.dom.parentElement;
    if (!host || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setLayout((l) => l + 1));
    observer.observe(host);
    return () => observer.disconnect();
  }, [view]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: tick and layout are what say it moved.
  useEffect(() => {
    if (!view) return;
    const frame = requestAnimationFrame(() => setKnots(measure(view, look)));
    return () => cancelAnimationFrame(frame);
  }, [view, tick, layout, look]);

  const uses = useMemo(() => knots.reduce((n, k) => n + k.uses.length, 0), [knots]);
  if (knots.length === 0) return null;
  const first = knots[0]?.top ?? 0;
  const last = knots[knots.length - 1]?.top ?? 0;
  const style = { "--thread-from": `${first}px`, "--thread-to": `${last}px` } as CSSProperties;

  return (
    <nav className="threads" style={style} aria-label={`Skills used here, ${uses} in all`}>
      <span className="threads-line" aria-hidden="true" />
      <ol>
        {knots.map((k) => {
          const gathered = k.uses.length > GATHER_ABOVE;
          const one = k.uses[0];
          if (!one) return null;
          return (
            <li key={k.key} className="thread-note" style={{ top: k.top }}>
              {gathered ? (
                <button type="button" className="thread-item" onClick={onOverview}>
                  <span className="thread-knot is-count" aria-hidden="true">
                    {k.uses.length}
                  </span>
                  <span className="thread-words">
                    <span className="thread-name">{k.uses.length} skills here</span>
                  </span>
                </button>
              ) : (
                k.uses.map((u) => (
                  <button
                    key={u.pos}
                    type="button"
                    className={`thread-item is-${u.status}`}
                    aria-label={`${u.title}, ${roleWords(u.role)}${u.status === "missing" ? ", not found here" : ""}`}
                    onClick={() => onOpen(u.pos)}
                  >
                    <span
                      className="thread-knot"
                      style={u.status === "missing" ? undefined : { background: knotColor(u.name) }}
                      aria-hidden="true"
                    />
                    <span className="thread-words">
                      <span className="thread-name">{u.title}</span>
                      <span className="thread-role">
                        {u.status === "missing" ? "not found here" : roleWords(u.role)}
                      </span>
                    </span>
                  </button>
                ))
              )}
            </li>
          );
        })}
      </ol>
      <button
        type="button"
        className="threads-more"
        style={{ top: last + 34 }}
        aria-expanded={expanded}
        onClick={onOverview}
      >
        {expanded ? "Close the overview" : "See how they fit"}
      </button>
    </nav>
  );
}
