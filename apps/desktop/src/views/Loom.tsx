/**
 * The loom: your libraries across your projects, as one piece of cloth.
 *
 * Warp threads (vertical) are libraries, each in its own dye, stitched when it
 * is a community library; your own skills in ink. Weft threads (horizontal)
 * are your projects. Where a library meets a project, every one of its skills
 * that belongs there is a thread of its own: pulled taut when it is installed,
 * left slack when it fits and nothing has tied it in yet. So a well-served
 * project reads as dense, even cloth, and one with work to do hangs loose, all
 * from real counts. A saffron knot marks a crossing where something learned in
 * that project went back into that library.
 *
 * A project's thread runs on into the margin and ends in a knot when something
 * waits on it, so what to do next is read on the cloth, beside what it is about.
 * The last row is unwoven: the next project you open.
 *
 * Rows and sources are real controls (open the project, open the library);
 * pointing at either brings what it is connected to forward. The loom
 * weaves itself once on arrival, then stays still. In a tall window the warp
 * hangs on below the last row and fades out, so the room is the loom's.
 */
import { type CSSProperties, type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { tip } from "../components/Tooltips";
import type { Dye } from "../lib/dye";
import { plural } from "../lib/format";

export type LoomSource = {
  id: string;
  name: string;
  dye: Dye;
  kind: "team" | "community" | "mine";
  skills: number;
};

/** Something that waits on the person, and the way to it. */
export type LoomNote = { key: string; name: string; detail: string; go: () => void };

export type LoomProject = {
  id: string;
  name: string;
  /** Sources whose knowledge applies here; `null` until the project is matched. */
  sources: string[] | null;
  /** Sources that something learned in this project was shared back to. */
  sharedTo: string[];
  /**
   * Per library: how many of its skills fit, and the titles of those installed here. Absent
   * until the project has been looked at with a version of Habi that keeps it.
   */
  tally?: { sourceId: string; fits: number; described: number; installed: string[] }[];
  meta: string;
  when: string;
  /** What waits on this project, at the end of its thread. */
  note?: LoomNote;
};

/** "a", "a and b", "a, b and 2 more". */
function names(list: string[]): string {
  if (list.length <= 1) return list[0] ?? "";
  if (list.length <= 3) return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
  return `${list.slice(0, 2).join(", ")} and ${list.length - 2} more`;
}

/** Rows are at least this tall, and grow into a tall window up to the most, threads with them. */
const MIN_ROW = 46;
const MAX_ROW = 72;
const NARROW = 700;
/** Room above the rows: more when the libraries' names have to lean. */
const HEAD = 44;
const HEAD_TILTED = 72;

/** Threads drawn at one crossing; past this the tooltip has the count. */
const MAX_THREADS = 7;

/** A thread nothing has pulled tight yet: it wanders, a little differently each time. */
function slack(x: number, y: number, k: number, half = 8): string {
  const lean = (k % 2 === 0 ? 1 : -1) * half * 0.22;
  return `M${x} ${y - half}C${x + lean} ${y - half * 0.4} ${x - lean} ${y + half * 0.4} ${x} ${y + half}`;
}

/** Columns drawn before the rest are summarized as "+N more". */
const MAX_SOURCES = 10;

/** How to read the cloth, drawn with its own threads; only the marks it is showing. */
export function LoomKey({ community, shared }: { community: boolean; shared: boolean }) {
  const mark = (children: ReactNode) => (
    <svg className="loom-key-mark" width="16" height="22" viewBox="0 0 16 22" aria-hidden="true">
      {children}
    </svg>
  );
  return (
    <ul className="loom-key" aria-label="How to read the loom">
      <li>
        {mark(
          <>
            <line x1="5.5" y1="3" x2="5.5" y2="19" className="loom-float is-woven" />
            <line x1="10.5" y1="3" x2="10.5" y2="19" className="loom-float is-woven" />
          </>,
        )}
        Taut: installed
      </li>
      <li>
        {mark(
          <>
            <path d={slack(5.5, 11, 0)} className="loom-float is-loose" />
            <path d={slack(10.5, 11, 1)} className="loom-float is-loose" />
          </>,
        )}
        Slack: fits, not installed
      </li>
      {community ? (
        <li>
          {mark(<line x1="8" y1="1" x2="8" y2="21" className="loom-key-warp" strokeDasharray="4 4" />)}
          Stitched: community
        </li>
      ) : null}
      {shared ? (
        <li>
          {mark(<circle cx="8" cy="11" r="5.5" className="loom-knot" />)}
          Knot: shared back
        </li>
      ) : null}
      <li>One thread, one skill. One colour, one library.</li>
    </ul>
  );
}

export function Loom({
  sources: allSources,
  projects,
  moreProjects = 0,
  elsewhere = [],
  newRow,
  onOpenProject,
  onOpenSource,
}: {
  sources: LoomSource[];
  projects: LoomProject[];
  /** Projects not shown as rows. */
  moreProjects?: number;
  /** What waits but belongs to no row here. */
  elsewhere?: LoomNote[];
  /** The unwoven last row: the action that adds a project. */
  newRow: ReactNode;
  onOpenProject: (id: string) => void;
  onOpenSource: (id: string) => void;
}) {
  const field = useRef<HTMLDivElement>(null);
  const room = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [roomSize, setRoomSize] = useState({ width: 0, height: 0 });
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

  // The cloth is cut to the room it has. The room's size does not depend on the rows: no feedback.
  useLayoutEffect(() => {
    const el = room.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry)
        setRoomSize({
          width: Math.round(entry.contentRect.width),
          height: Math.round(entry.contentRect.height),
        });
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
  const lines = projects.length;
  const bare = sources.length === 0;
  const columns = bare ? 9 : sources.length;
  const tilted = width / Math.max(columns, 1) < 104;
  const head = tilted ? HEAD_TILTED : HEAD;
  // A little of the warp always hangs below the last row.
  // Too narrow for a margin the loom sits in the flow and sets the room's height, so it stays at its least.
  const narrow = roomSize.width > 0 && roomSize.width < NARROW;
  const rowHeight = narrow
    ? MIN_ROW
    : Math.round(Math.max(MIN_ROW, Math.min(MAX_ROW, (roomSize.height - head) / (lines + 1 + 0.6))));
  const height = head + (lines + 1) * rowHeight;
  const y = (i: number) => head + i * rowHeight + rowHeight / 2;
  const tautHalf = rowHeight * 0.29;
  const slackHalf = rowHeight * 0.36;
  const threadGap = Math.min(7, rowHeight * 0.115);
  const center = (j: number) => (width * (j + 0.5)) / columns;
  // A bare loom still has colour: undyed threads waiting for libraries.
  const strands = bare
    ? Array.from({ length: 9 }, (_, j) => ({
        x: center(j),
        source: null as LoomSource | null,
        tint: `var(--dye-${j % 8})`,
      }))
    : sources.map((source, j) => ({
        x: center(j),
        source: source as LoomSource | null,
        tint: null as string | null,
      }));

  const hot = row ? projects.find((p) => p.id === row) : undefined;
  const fits = (p: LoomProject, id: string) => p.sources?.includes(id) ?? false;
  const tallyOf = (p: LoomProject, id: string) => p.tally?.find((t) => t.sourceId === id);
  const installedFrom = (p: LoomProject, id: string) => (tallyOf(p, id)?.installed.length ?? 0) > 0;
  /** A crossing worth drawing: the library's skills fit the project, or one is installed there. */
  const crosses = (p: LoomProject, id: string) => fits(p, id) || installedFrom(p, id);
  /** The threads at a crossing: its installed skills taut, then what fits and is not installed slack. */
  const threadsAt = (p: LoomProject, s: LoomSource, j: number, i: number) => {
    const t = tallyOf(p, s.id);
    const taut = t ? t.installed.length : 1;
    const hanging = t ? Math.max(0, t.fits + t.described - t.installed.length) : 0;
    const shownTaut = Math.min(taut, MAX_THREADS);
    const shownSlack = Math.min(hanging, MAX_THREADS - shownTaut);
    const n = shownTaut + shownSlack;
    return Array.from({ length: n }, (_, k) => {
      const x = center(j) + (k - (n - 1) / 2) * threadGap;
      return k < shownTaut ? (
        <line
          key={k}
          x1={x}
          y1={y(i) - tautHalf}
          x2={x}
          y2={y(i) + tautHalf}
          className={`loom-float is-woven${sourceLit(s.id) ? "" : " is-dim"}`}
          style={{ stroke: s.dye.color }}
        />
      ) : (
        <path
          key={k}
          d={slack(x, y(i), k, slackHalf)}
          className={`loom-float is-loose${sourceLit(s.id) ? "" : " is-dim"}`}
          style={{ stroke: s.dye.color }}
        />
      );
    });
  };
  /** What a crossing holds, in words, for screen readers. */
  const crossLabel = (p: LoomProject, s: LoomSource) => {
    const t = tallyOf(p, s.id);
    const installed = t?.installed ?? [];
    const parts = [
      installed.length > 0 ? `installed: ${names(installed)}` : null,
      t && t.fits > 0 ? `${plural(t.fits, "skill")} ${t.fits === 1 ? "fits" : "fit"}` : null,
      t && t.described > 0
        ? `${plural(t.described, "skill")} from ${t.described === 1 ? "its" : "their"} description`
        : null,
    ].filter(Boolean);
    return `${s.name} in ${p.name}${parts.length > 0 ? `: ${parts.join(", ")}` : ""}`;
  };
  /** What a crossing holds, for its tooltip. */
  const crossTip = (p: LoomProject, s: LoomSource) => {
    const t = tallyOf(p, s.id);
    const installed = t?.installed ?? [];
    const fitting = t?.fits ?? 0;
    const described = t?.described ?? 0;
    return tip({
      title: s.name,
      mark: s.dye.color,
      stitched: s.dye.community,
      lines: [
        { text: `in ${p.name}`, mono: true },
        ...(installed.length > 0 ? [{ text: `Installed: ${names(installed)}` }] : []),
        ...(fitting > 0
          ? [{ text: `${plural(fitting, "skill")} ${fitting === 1 ? "fits" : "fit"} this project` }]
          : []),
        // Habi's reading of a skill's description, never counted as a declared fit.
        ...(described > 0
          ? [
              {
                text: `${plural(described, "skill")} ${described === 1 ? "fits" : "fit"} by ${
                  described === 1 ? "its" : "their"
                } description`,
              },
            ]
          : []),
      ],
      note: !p.tally
        ? { text: "Its skills fit this project", tone: "muted" }
        : installed.length > 0
          ? { text: "Woven in: installed here", tone: "ok" }
          : { text: "A loose thread: it fits, nothing installed yet", tone: "muted" },
    });
  };
  const sourceLit = (id: string | undefined) => !id || (col ? col === id : hot ? fits(hot, id) : true);
  const rowLit = (p: LoomProject) => (row ? row === p.id : col ? fits(p, col) : true);

  const noted = projects.filter((p) => p.note);
  const waits = noted.length > 0 || elsewhere.length > 0;
  const noteButton = (n: LoomNote, onRow: boolean) => (
    <button type="button" className="loom-note-go" onClick={n.go}>
      <span className={onRow ? "loom-note-name is-row" : "loom-note-name"}>{n.name}</span>{" "}
      <span className="loom-note-detail">{n.detail}</span>
    </button>
  );

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
    <div className="loom-room" ref={room} style={{ minHeight: head + (lines + 1) * MIN_ROW }}>
      <div
        className={`loom${row || col ? " is-pointing" : ""}${lines === 0 ? " is-unwritten" : ""}${waits ? " has-margin" : ""}${narrow ? " is-narrow" : ""}`}
        style={{ "--loom-head": `${head}px`, "--loom-row": `${rowHeight}px` } as CSSProperties}
      >
        <div className="loom-labels">
          <div className="loom-head-cell" />
          {projects.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`loom-row-label${rowLit(p) ? "" : " is-dim"}`}
              // The weave says what fits; the counts and when it was opened are a look away.
              title={`${p.meta} — opened ${p.when}`}
              onClick={() => onOpenProject(p.id)}
              {...point.row(p.id)}
            >
              {p.name}
            </button>
          ))}
          <div className="loom-new">{newRow}</div>
        </div>

        <div className="loom-field" ref={field}>
          {bare ? (
            <p className="loom-bare">libraries you connect appear here</p>
          ) : (
            <nav className="loom-sources" aria-label="Libraries">
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
                  y1={head - 8}
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
                  {sources.map((s, j) => (crosses(p, s.id) ? threadsAt(p, s, j, i) : null))}
                  {sources.map((s, j) =>
                    p.sharedTo.includes(s.id) ? (
                      <circle key={`k${s.id}`} cx={center(j)} cy={y(i)} r={12} className="loom-knot" />
                    ) : null,
                  )}
                </g>
              ))}
              <line x1={0} y1={y(lines)} x2={width} y2={y(lines)} className="loom-pick is-new" />
            </g>
          </svg>
          {moreProjects > 0 ? (
            <span className="loom-more-projects" style={{ top: y(lines) }}>
              +{moreProjects} more in the sidebar
            </span>
          ) : null}
          {/* Each crossing says what it holds when pointed at, and brings its row and column forward. */}
          {projects.map((p, i) =>
            sources.map((s, j) =>
              crosses(p, s.id) ? (
                <span
                  key={`x${p.id}${s.id}`}
                  className="loom-cross"
                  style={{ left: center(j), top: y(i) }}
                  role="img"
                  aria-label={crossLabel(p, s)}
                  data-tip-side="top"
                  {...crossTip(p, s)}
                  onMouseEnter={() => {
                    setRow(p.id);
                    setCol(s.id);
                  }}
                  onMouseLeave={() => {
                    setRow(null);
                    setCol(null);
                  }}
                />
              ) : null,
            ),
          )}
          {/* Where the window is taller than the weave, the warp hangs on and fades out. */}
          <svg
            className="loom-tail"
            style={{ top: height - 4, height: `calc(100% - ${height - 4}px)` }}
            aria-hidden="true"
            focusable="false"
          >
            {strands.map((s, i) => (
              <line
                key={`t${i}`}
                x1={s.x}
                y1={0}
                x2={s.x}
                y2="100%"
                className={`loom-strand${s.tint ? " is-bare" : ""}${sourceLit(s.source?.id) ? "" : " is-dim"}`}
                style={s.source ? { stroke: s.source.dye.color } : s.tint ? { stroke: s.tint } : undefined}
                strokeDasharray={s.source?.dye.community ? "4 4" : undefined}
              />
            ))}
          </svg>
        </div>

        {waits ? (
          <section className="loom-margin" aria-label="Waiting for you">
            <div className="loom-margin-head">
              <span className="kicker">Waiting for you</span>
            </div>
            {projects.map((p) => (
              <div
                key={p.id}
                className={`loom-note${p.note ? " has-note" : ""}${rowLit(p) ? "" : " is-dim"}`}
                {...point.row(p.id)}
              >
                {p.note ? noteButton(p.note, true) : null}
              </div>
            ))}
            <div className="loom-note is-new" />
            {elsewhere.length > 0 ? (
              <ul className="loom-elsewhere">
                {elsewhere.map((n) => (
                  <li key={n.key}>{noteButton(n, false)}</li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}
      </div>
    </div>
  );
}
