/**
 * The weave: Habi's visual language. A library is a warp thread in its own
 * dye; a project is where threads are woven together. Team libraries are
 * solid threads; community libraries are stitched (dashed), because their
 * content has not been reviewed by the team.
 *
 * All of these are decorative: the library's name is always next to them.
 */
import type { CSSProperties } from "react";
import type { Dye } from "../lib/dye";
import { stackDye } from "../lib/stackDye";
import { tagLabel } from "../lib/tags";

/** A short length of one library's thread, crossing a weft. */
export function Strand({ dye, size = 16 }: { dye: Dye; size?: number }) {
  const w = Math.round(size * 0.625);
  return (
    <svg className="strand" width={w} height={size} viewBox="0 0 10 16" aria-hidden="true" focusable="false">
      <line x1="0" y1="8" x2="10" y2="8" className="strand-weft" />
      {dye.community ? (
        <line
          x1="5"
          y1="1.5"
          x2="5"
          y2="14.5"
          stroke={dye.color}
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeDasharray="2.6 2.4"
        />
      ) : (
        <>
          <line x1="5" y1="1.5" x2="5" y2="5.6" stroke={dye.color} strokeWidth="2.6" strokeLinecap="round" />
          <line
            x1="5"
            y1="10.4"
            x2="5"
            y2="14.5"
            stroke={dye.color}
            strokeWidth="2.6"
            strokeLinecap="round"
          />
          <rect x="3.7" y="5.6" width="2.6" height="4.8" fill={dye.color} opacity="0.45" />
        </>
      )}
    </svg>
  );
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** The swatch's drawing space; threads keep this far from its edge. */
const BOX = 80;
const MARGIN = 7;
/** Warp threads shown at most: more libraries than this share the cloth by turns. */
const MAX_WARP = 5;
/** Weft threads: the project's own colors, a few passes across. */
const WEFTS = 3;
const THREAD = 2.4;

/**
 * A small woven swatch, kept quiet so the initials read. A few warp threads
 * run top to bottom in the dyes given (the libraries that contribute to a
 * project); a few weft passes cross them in `weft` colors (the project's own
 * stack) and interlace at the crossings, over one thread and under the next.
 * Where each thread sits comes from `seed`, so each project keeps its own
 * cloth. Without dyes or weft it is an empty loom: two undyed passes.
 */
export function Swatch({
  dyes,
  seed,
  size = 56,
  label,
  weft = [],
  initials,
}: {
  dyes: Dye[];
  seed: string;
  size?: number;
  label?: string;
  weft?: string[];
  /** Letters set plainly on the cloth, in ink with a paper halo. */
  initials?: string;
}) {
  const h = hash(seed);
  // A small, seeded drift keeps two projects' cloths from lining up.
  const drift = (k: number, span: number) => ((((h >>> (k * 5)) & 31) / 31) * 2 - 1) * span;
  const warps = dyes.slice(0, MAX_WARP).map((dye, i, all) => ({
    dye,
    x: Math.round((BOX * (i + 1)) / (all.length + 1) + drift(i, 3)),
  }));
  const dyed = weft.length > 0;
  const passes = dyed ? WEFTS : 2;
  const wefts = Array.from({ length: passes }, (_, j) => ({
    color: dyed ? (weft[(j + (h >>> 3)) % weft.length] as string) : undefined,
    y: Math.round((BOX * (j + 1)) / (passes + 1) + drift(j + 7, 4)),
  }));
  return (
    <svg
      className="swatch"
      width={size}
      height={size}
      viewBox={`0 0 ${BOX} ${BOX}`}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : "true"}
      focusable="false"
    >
      {/* Wefts first, under everything. */}
      {wefts.map((w, j) => (
        <line
          key={`weft-${j}`}
          x1={MARGIN}
          y1={w.y}
          x2={BOX - MARGIN}
          y2={w.y}
          className={w.color ? "swatch-weft is-dyed" : "swatch-weft"}
          style={w.color ? { stroke: w.color } : undefined}
          strokeWidth={THREAD}
          strokeLinecap="round"
        />
      ))}
      {/* Warps over them, stitched for a community library. */}
      {warps.map((w, i) => (
        <line
          key={`warp-${i}`}
          x1={w.x}
          y1={MARGIN}
          x2={w.x}
          y2={BOX - MARGIN}
          stroke={w.dye.color}
          strokeWidth={THREAD}
          strokeLinecap="round"
          strokeDasharray={w.dye.community ? "3.2 3" : undefined}
          opacity={w.dye.community ? 0.85 : undefined}
        />
      ))}
      {/* Then the weft back over every other crossing: a plain weave. */}
      {wefts.flatMap((w, j) =>
        warps
          .filter((_, i) => (i + j + (h & 1)) % 2 === 0)
          .map((warp, i) => (
            <line
              key={`over-${j}-${i}`}
              x1={warp.x - THREAD * 1.1}
              y1={w.y}
              x2={warp.x + THREAD * 1.1}
              y2={w.y}
              className={w.color ? "swatch-weft is-dyed" : "swatch-weft"}
              style={w.color ? { stroke: w.color } : undefined}
              strokeWidth={THREAD}
              strokeLinecap="butt"
            />
          )),
      )}
      {initials ? (
        <text
          x={BOX / 2}
          y={BOX / 2 + 1}
          textAnchor="middle"
          dominantBaseline="central"
          className="swatch-initials"
        >
          {initials}
        </text>
      ) : null}
    </svg>
  );
}

/** "draft-canvas" → "DC", "habi" → "HA", "myProject" → "MP". */
export function initialsOf(name: string): string {
  const words = name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  const letters =
    words.length >= 2 ? `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}` : (words[0] ?? name).slice(0, 2);
  return letters.toUpperCase();
}

/**
 * A project's mark where its woven avatar would be too small to read (the
 * sidebar): its initials on a tile in its main language's dye.
 */
export function ProjectMark({ name, languages }: { name: string; languages: string[] }) {
  // The first language that has a dye (SQL or shell scripts do not).
  const dye = languages.map((l) => stackDye(tagLabel(l))).find(Boolean) ?? "var(--ink-muted)";
  return (
    <span className="project-mark" style={{ "--dye": dye } as CSSProperties} aria-hidden="true">
      {initialsOf(name)}
    </span>
  );
}
