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

/** Weave structures: plain, 2/1 twill, 2/2 twill, basket. */
const STRUCTURES: ((col: number, row: number) => boolean)[] = [
  (c, r) => (c + r) % 2 === 0,
  (c, r) => (c + r) % 3 !== 0,
  (c, r) => (c + r) % 4 < 2,
  (c, r) => (Math.floor(c / 2) + Math.floor(r / 2)) % 2 === 0,
];

/**
 * A small woven swatch. Warp threads carry the dyes given (the libraries
 * that contribute to a project); the weave structure comes from `seed`, so
 * each project keeps its own cloth. Without threads, it is an empty loom.
 */
export function Swatch({
  dyes,
  seed,
  size = 56,
  label,
}: {
  dyes: Dye[];
  seed: string;
  size?: number;
  label?: string;
}) {
  const n = 8;
  const cell = 10;
  const h = hash(seed);
  const over = STRUCTURES[h % STRUCTURES.length] as (c: number, r: number) => boolean;
  const cells = [];
  // Weft rows first, then the warp floats that pass over them.
  for (let r = 0; r < n; r++) {
    cells.push(
      <rect
        key={`w${r}`}
        x="0"
        y={r * cell + 2}
        width={n * cell}
        height={cell - 4}
        rx="3"
        className="swatch-weft"
      />,
    );
  }
  for (let c = 0; c < n; c++) {
    const dye = dyes.length > 0 ? dyes[(c + (h >>> 3)) % dyes.length] : undefined;
    if (!dye) continue;
    for (let r = 0; r < n; r++) {
      if (!over(c, r)) continue;
      cells.push(
        <rect
          key={`${c}-${r}`}
          x={c * cell + 2}
          y={r * cell - 0.5}
          width={cell - 4}
          height={cell + 1}
          rx="3"
          fill={dye.color}
          opacity={dye.community ? 0.72 : undefined}
        />,
      );
    }
  }
  return (
    <svg
      className="swatch"
      width={size}
      height={size}
      viewBox={`0 0 ${n * cell} ${n * cell}`}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : "true"}
      focusable="false"
    >
      {cells}
    </svg>
  );
}

/** The woven edge along the top of a library: its dye, solid or stitched. */
export function Selvedge({ dye }: { dye: Dye }) {
  return (
    <div
      className={`selvedge${dye.community ? " is-community" : ""}`}
      style={{ "--selvedge": dye.color } as CSSProperties}
      aria-hidden="true"
    />
  );
}
