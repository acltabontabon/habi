/**
 * The loom: your knowledge, woven through your projects.
 *
 * Warp threads (vertical) are knowledge sources — each library a bundle in
 * its own dye, stitched when it is a community library; your own skills in
 * ink. More skills, more strands. Weft threads (horizontal) are your
 * projects. Where a source's knowledge applies to a project, its thread
 * surfaces over the weft as a float in its dye; elsewhere the weft passes
 * over it. The pattern is the real fit between your team's knowledge and
 * your code. A saffron knot marks a crossing where something learned in that
 * project went back into that library. The last row is unwoven: the next
 * project you open.
 *
 * Rows and sources are real controls (open the project, open the library);
 * pointing at either brings what it is connected to forward. The loom
 * weaves itself once on arrival, then stays still.
 */
import { type CSSProperties, type ReactNode, useLayoutEffect, useRef, useState } from "react";
import type { Dye } from "../lib/dye";

export type LoomSource = {
  id: string;
  name: string;
  dye: Dye;
  kind: "team" | "community" | "mine";
  skills: number;
};

export type LoomProject = {
  id: string;
  name: string;
  /** Sources whose knowledge applies here; `null` until the project is matched. */
  sources: string[] | null;
  /** Sources that something learned in this project was shared back to. */
  sharedTo: string[];
  meta: string;
  when: string;
};

const ROW = 52;
const HEAD = 72;

function strandsFor(skills: number): number {
  return Math.max(1, Math.min(4, Math.ceil(skills / 8)));
}

/** Columns drawn before the rest are summarized as "+N more". */
const MAX_SOURCES = 10;
/** Rows of cloth kept even with few projects, so the loom never thins out. */
const MIN_ROWS = 3;

export function Loom({
  sources: allSources,
  projects,
  moreProjects = 0,
  newRow,
  onOpenProject,
  onOpenSource,
}: {
  sources: LoomSource[];
  projects: LoomProject[];
  /** Projects not shown as rows. */
  moreProjects?: number;
  /** The unwoven last row: the action that adds a project. */
  newRow: ReactNode;
  onOpenProject: (id: string) => void;
  onOpenSource: (id: string) => void;
}) {
  const field = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [row, setRow] = useState<string | null>(null);
  const [col, setCol] = useState<string | null>(null);

  useLayoutEffect(() => {
    const el = field.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(96, Math.round(entry.contentRect.width)));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Team libraries first, then community, then yours; the rest summarized.
  const rank = { team: 0, community: 1, mine: 2 } as const;
  const ordered = [...allSources].sort((a, b) => rank[a.kind] - rank[b.kind]);
  const sources =
    ordered.length > MAX_SOURCES
      ? [
          ...ordered.filter((s) => s.kind !== "mine").slice(0, MAX_SOURCES - 1),
          ...ordered.filter((s) => s.kind === "mine"),
        ]
      : ordered;
  const hidden = allSources.length - sources.length;
  // Faint, unlabeled rows of cloth above the next project when there are few.
  const ghosts = Math.max(0, MIN_ROWS - projects.length);
  const lines = projects.length + ghosts;
  const height = HEAD + (lines + 1) * ROW;
  const y = (i: number) => HEAD + i * ROW + ROW / 2;
  const bare = sources.length === 0;
  const columns = bare ? 9 : sources.length;
  const center = (j: number) => (width * (j + 0.5)) / columns;
  // A bare loom still has colour: undyed threads waiting for sources.
  const strands = bare
    ? Array.from({ length: 9 }, (_, j) => ({
        x: center(j),
        source: null as LoomSource | null,
        tint: `var(--dye-${j % 8})`,
      }))
    : sources.flatMap((source, j) => {
        const k = strandsFor(source.skills);
        return Array.from({ length: k }, (_, s) => ({
          x: center(j) + (s - (k - 1) / 2) * 5,
          source: source as LoomSource | null,
          tint: null as string | null,
        }));
      });

  const hot = row ? projects.find((p) => p.id === row) : undefined;
  const fits = (p: LoomProject, id: string) => p.sources?.includes(id) ?? false;
  const sourceLit = (id: string | undefined) => !id || (col ? col === id : hot ? fits(hot, id) : true);
  const rowLit = (p: LoomProject) => (row ? row === p.id : col ? fits(p, col) : true);
  const tilted = width / Math.max(columns, 1) < 104;

  const point = {
    row: (id: string | null) => ({
      onMouseEnter: () => setRow(id),
      onMouseLeave: () => setRow(null),
      onFocus: () => setRow(id),
      onBlur: () => setRow(null),
    }),
    col: (id: string | null) => ({
      onMouseEnter: () => setCol(id),
      onMouseLeave: () => setCol(null),
      onFocus: () => setCol(id),
      onBlur: () => setCol(null),
    }),
  };

  return (
    <div
      className={`loom${row || col ? " is-pointing" : ""}`}
      style={{ "--loom-head": `${HEAD}px`, "--loom-row": `${ROW}px` } as CSSProperties}
    >
      <div className="loom-labels">
        <div className="loom-head-cell kicker">Projects</div>
        {projects.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`loom-row-label${rowLit(p) ? "" : " is-dim"}`}
            onClick={() => onOpenProject(p.id)}
            {...point.row(p.id)}
          >
            {p.name}
          </button>
        ))}
        {Array.from({ length: ghosts }, (_, i) => (
          <div key={`g${i}`} className="loom-ghost-cell" aria-hidden="true" />
        ))}
        <div className="loom-new">{newRow}</div>
      </div>

      <div className="loom-field" ref={field}>
        {bare ? (
          <p className="loom-bare">libraries you connect become threads here</p>
        ) : (
          <nav className="loom-sources" aria-label="Knowledge sources">
            {sources.map((s, j) => (
              <button
                key={s.id}
                type="button"
                className={`loom-source${tilted ? " is-tilted" : ""}${sourceLit(s.id) ? "" : " is-dim"}`}
                style={{ left: center(j), "--dye": s.dye.color } as CSSProperties}
                title={`${s.name} · ${s.kind === "mine" ? "yours" : s.kind} · ${s.skills} ${s.skills === 1 ? "skill" : "skills"}`}
                onClick={() => onOpenSource(s.id)}
                {...point.col(s.id)}
              >
                <span className="loom-source-name">{s.name}</span>
                <span className="loom-source-count">{s.skills}</span>
              </button>
            ))}
            {hidden > 0 ? <span className="loom-more">+{hidden} more</span> : null}
          </nav>
        )}
        <svg
          className="loom-svg"
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          aria-hidden="true"
          focusable="false"
        >
          <g className="loom-warp">
            {strands.map((s, i) => (
              <line
                key={`w${i}`}
                x1={s.x}
                y1={HEAD - 8}
                x2={s.x}
                y2={height - 4}
                className={`loom-strand${s.tint ? " is-bare" : ""}${sourceLit(s.source?.id) ? "" : " is-dim"}`}
                style={s.source ? { stroke: s.source.dye.color } : s.tint ? { stroke: s.tint } : undefined}
                strokeDasharray={s.source?.dye.community ? "4 4" : undefined}
              />
            ))}
          </g>
          <g className="loom-weft">
            {projects.map((p, i) => (
              <g key={p.id} className={rowLit(p) ? undefined : "is-dim"}>
                {/* The halo parts the warp where the weft passes over it. */}
                <line x1={0} y1={y(i)} x2={width} y2={y(i)} className="loom-halo" />
                <line
                  x1={0}
                  y1={y(i)}
                  x2={width}
                  y2={y(i)}
                  className={`loom-pick${p.sources ? "" : " is-unmatched"}${row === p.id ? " is-hot" : ""}`}
                />
                {strands.map((s, k) =>
                  s.source && fits(p, s.source.id) ? (
                    <line
                      key={`f${k}`}
                      x1={s.x}
                      y1={y(i) - 13}
                      x2={s.x}
                      y2={y(i) + 13}
                      className={`loom-float${sourceLit(s.source.id) ? "" : " is-dim"}`}
                      style={{ stroke: s.source.dye.color }}
                    />
                  ) : null,
                )}
                {sources.map((s, j) =>
                  p.sharedTo.includes(s.id) ? (
                    <circle key={`k${s.id}`} cx={center(j)} cy={y(i)} r={12} className="loom-knot" />
                  ) : null,
                )}
              </g>
            ))}
            {Array.from({ length: ghosts }, (_, g) => (
              <g key={`g${g}`}>
                <line
                  x1={0}
                  y1={y(projects.length + g)}
                  x2={width}
                  y2={y(projects.length + g)}
                  className="loom-pick is-ghost"
                />
                {/* Empty cloth keeps a faint twill, so the loom never looks blank. */}
                {bare
                  ? strands.map((s, j) =>
                      (j + g) % 3 === 0 ? (
                        <line
                          key={`t${j}`}
                          x1={s.x}
                          y1={y(projects.length + g) - 11}
                          x2={s.x}
                          y2={y(projects.length + g) + 11}
                          className="loom-float is-bare"
                          style={{ stroke: s.tint ?? undefined }}
                        />
                      ) : null,
                    )
                  : null}
              </g>
            ))}
            <line x1={0} y1={y(lines)} x2={width} y2={y(lines)} className="loom-pick is-new" />
          </g>
        </svg>
      </div>

      <div className="loom-meta">
        <div className="loom-head-cell" />
        {projects.map((p) => (
          <div key={p.id} className={`loom-meta-cell${rowLit(p) ? "" : " is-dim"}`}>
            <span>{p.meta}</span>
            <span className="loom-when">{p.when}</span>
          </div>
        ))}
        {Array.from({ length: ghosts }, (_, i) => (
          <div key={`g${i}`} className="loom-ghost-cell" aria-hidden="true" />
        ))}
        <div className="loom-meta-cell">
          {moreProjects > 0 ? <span>+{moreProjects} more in the sidebar</span> : null}
        </div>
      </div>
    </div>
  );
}
