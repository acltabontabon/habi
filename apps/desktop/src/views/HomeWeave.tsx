/**
 * The home weave: what Habi does, drawn from your own data.
 *
 * Vertical threads are knowledge sources — each library a bundle in its own
 * dye (stitched when it is a community library), your own skills in ink.
 * More skills, more strands. Horizontal threads are skills crossing them;
 * the saffron one is Habi's. Below, every thread converges into the action
 * that opens a repository: the knowledge arrives where the code is.
 *
 * Hovering or focusing a source names it in one quiet caption; choosing it
 * opens the library. Pointing past the weave along a row names its skill. Given `focus`, the weave resolves to the sources that
 * fit one project. It draws itself once, then stays still.
 */
import { type KeyboardEvent, useLayoutEffect, useRef, useState } from "react";
import type { Dye } from "../lib/dye";

export type WeaveSource = {
  id: string;
  name: string;
  dye: Dye;
  /** "team", "community" or "mine" (My skills). */
  kind: "team" | "community" | "mine";
  skills: number;
  /** How many of your projects it fits (from their last overview). */
  fits: number;
};

export type WeaveSkill = { title: string; sourceId: string; sourceName: string };

const TOP = 0;
const ROW_GAP = 25;
const FIRST_ROW = 40;
const CONVERGE = 112;
/** The share of the width the weave may take; the caption keeps the rest. */
const SPAN = 0.6;

function strandsFor(skills: number): number {
  return Math.max(1, Math.min(4, Math.ceil(skills / 8)));
}

type Strand = { x: number; source: WeaveSource | null; bundle: number };

function layout(sources: WeaveSource[], width: number): Strand[] {
  const room = Math.max(160, width * SPAN);
  if (sources.length === 0) {
    // A bare loom: neutral threads, nothing to name yet.
    const gap = Math.min(18, room / 12);
    return Array.from({ length: 12 }, (_, i) => ({ x: 6 + i * gap, source: null, bundle: i }));
  }
  // Strands sit one unit apart; bundles three units apart.
  const counts = sources.map((s) => strandsFor(s.skills));
  const units = counts.reduce((a, b) => a + b, 0) - sources.length + (sources.length - 1) * 3;
  const unit = Math.max(8, Math.min(15, room / Math.max(units, 1)));
  const strands: Strand[] = [];
  let x = 6;
  sources.forEach((source, b) => {
    for (let i = 0; i < (counts[b] ?? 1); i++) {
      strands.push({ x, source, bundle: b });
      if (i < (counts[b] ?? 1) - 1) x += unit;
    }
    x += unit * 3;
  });
  return strands;
}

function caption(source: WeaveSource): [string, string] {
  const kind = source.kind === "mine" ? "yours" : source.kind;
  const fits = source.fits > 0 ? ` · fits ${source.fits} ${source.fits === 1 ? "project" : "projects"}` : "";
  return [source.name, `${kind} · ${source.skills} ${source.skills === 1 ? "skill" : "skills"}${fits}`];
}

export function HomeWeave({
  sources,
  skills,
  focus,
  summary,
  ctaWidth,
  onOpenSource,
}: {
  sources: WeaveSource[];
  skills: WeaveSkill[];
  /** Source ids to keep; the rest recede. `null`: show everything. */
  focus: { label: [string, string]; sources: string[] } | null;
  /** The caption when nothing is pointed at. */
  summary: [string, string] | null;
  /** Width of the action the threads converge into. */
  ctaWidth: number;
  onOpenSource: (id: string) => void;
}) {
  const host = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(560);
  const [hover, setHover] = useState<{ source?: WeaveSource; skill?: WeaveSkill } | null>(null);

  useLayoutEffect(() => {
    const el = host.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(280, Math.round(entry.contentRect.width)));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const strands = layout(sources, width);
  const rows = skills.slice(0, 6);
  const rowCount = Math.max(rows.length, 4);
  const clothEnd = FIRST_ROW + (rowCount - 1) * ROW_GAP + 26;
  const height = clothEnd + CONVERGE;
  const weaveRight = (strands.at(-1)?.x ?? 0) + 30;
  const n = strands.length;
  const target = (i: number) => 18 + (n === 1 ? 0 : (i / (n - 1)) * Math.max(0, ctaWidth - 36));

  const kept = (sourceId: string | undefined) =>
    !focus || (sourceId !== undefined && focus.sources.includes(sourceId));
  const lit = (s: Strand) =>
    hover?.source
      ? s.source?.id === hover.source.id
      : hover?.skill
        ? s.source?.id === hover.skill.sourceId
        : kept(s.source?.id);

  const shown: [string, string] | null = hover?.source
    ? caption(hover.source)
    : hover?.skill
      ? [hover.skill.title, hover.skill.sourceName]
      : (focus?.label ?? summary);

  const bundles = sources.map((source, b) => {
    const xs = strands.filter((s) => s.bundle === b).map((s) => s.x);
    return { source, x0: Math.min(...xs) - 6, x1: Math.max(...xs) + 6 };
  });

  const onKey = (e: KeyboardEvent<SVGGElement>, id: string) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onOpenSource(id);
    }
  };

  return (
    <nav
      className={`home-weave${focus || hover ? " is-resolving" : ""}`}
      ref={host}
      aria-label="Your knowledge sources"
    >
      <p className="home-weave-caption" aria-live="polite">
        {shown ? (
          <>
            <span className="home-weave-caption-title">{shown[0]}</span>
            <span className="home-weave-caption-meta">{shown[1]}</span>
          </>
        ) : null}
      </p>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="home-weave-svg">
        {/* Warp: one strand per thread of each source. */}
        <g className="weave-warp">
          {strands.map((s, i) => (
            <path
              key={`w${s.x}`}
              d={`M ${s.x} ${TOP} L ${s.x} ${clothEnd} C ${s.x} ${clothEnd + CONVERGE * 0.55}, ${target(i)} ${height - CONVERGE * 0.45}, ${target(i)} ${height}`}
              className={`weave-strand${lit(s) ? "" : " is-dim"}`}
              style={s.source ? { stroke: s.source.dye.color } : undefined}
              strokeDasharray={s.source?.dye.community ? "6 4" : undefined}
            />
          ))}
        </g>

        {/* Weft: skills crossing the sources; the saffron row is Habi's. */}
        <g className="weave-weft">
          {Array.from({ length: rowCount }, (_, r) => {
            const y = FIRST_ROW + r * ROW_GAP;
            const skill = rows[r];
            const accent = r === Math.min(1, rowCount - 1);
            const dim = skill
              ? !(hover ? hover.skill === skill || hover.source?.id === skill.sourceId : kept(skill.sourceId))
              : Boolean(focus || hover);
            return (
              <g key={`r${y}`} className={dim ? "is-dim" : undefined}>
                <path
                  d={`M 0 ${y} L ${weaveRight} ${y}`}
                  className={`weave-row${accent ? " is-accent" : ""}`}
                />
                {strands.map((s, i) =>
                  (i + r) % 2 === 0 ? (
                    <path
                      key={s.x}
                      d={`M ${s.x} ${y - 4.5} L ${s.x} ${y + 4.5}`}
                      className={`weave-strand weave-over${lit(s) ? "" : " is-dim"}`}
                      style={s.source ? { stroke: s.source.dye.color } : undefined}
                    />
                  ) : null,
                )}
                {skill ? (
                  // biome-ignore lint/a11y/noStaticElementInteractions: hover-only detail; the same names are in each library.
                  <path
                    d={`M ${weaveRight} ${y} L ${width} ${y}`}
                    className="weave-hit"
                    onMouseEnter={() => setHover({ skill })}
                    onMouseLeave={() => setHover(null)}
                  />
                ) : null}
              </g>
            );
          })}
        </g>

        {/* A source is one focusable target; choosing it opens the library. */}
        {bundles.map(({ source, x0, x1 }) => (
          // biome-ignore lint/a11y/useSemanticElements: an SVG region has no link element; it behaves as one.
          <g
            key={source.id}
            role="link"
            tabIndex={0}
            aria-label={`${source.name}: ${caption(source)[1]}`}
            className="weave-source"
            onMouseEnter={() => setHover({ source })}
            onMouseLeave={() => setHover(null)}
            onFocus={() => setHover({ source })}
            onBlur={() => setHover(null)}
            onClick={() => onOpenSource(source.id)}
            onKeyDown={(e) => onKey(e, source.id)}
          >
            <rect x={x0} y={TOP} width={x1 - x0} height={clothEnd} className="weave-source-hit" />
          </g>
        ))}
      </svg>
    </nav>
  );
}
