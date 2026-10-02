/**
 * A loom that weaves while something is being read: warp threads stand, a
 * saffron weft is drawn across row after row, going over and under. Rows
 * finish at staggered moments, so the cloth is always growing and dissolving
 * somewhere: a held breath, not a progress bar.
 *
 * It does not measure anything. The only real number beside it is the time
 * that has passed, because the core cannot say how far along a fetch is, and
 * a made-up percentage would be a lie.
 *
 * Three shapes (and a waiting loom that can fill any height): the default cloth, a wide band for a page's foot, and a slim
 * band where the foot has little room.
 */
import { type CSSProperties, type ReactNode, useEffect, useState } from "react";

type Shape = { columns: number; rows: number; stoppedAt: number };

const CLOTH: Shape = { columns: 22, rows: 8, stoppedAt: 3 };
const BAND: Shape = { columns: 52, rows: 5, stoppedAt: 2 };
const SLIM: Shape = { columns: 52, rows: 3, stoppedAt: 1 };

const X0 = 18;
const DX = 14;
const Y0 = 20;
const DY = 13;

function geometry(shape: Shape) {
  const width = X0 * 2 + (shape.columns - 1) * DX;
  const height = Y0 * 2 + (shape.rows - 1) * DY;
  // A weft runs a little past the first and last warp thread.
  const weft = width - 2 * (X0 - 8);
  return { width, height, weft };
}

/** Seconds since this mounted. */
function useElapsed(): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const tick = window.setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(tick);
  }, []);
  return seconds;
}

function Warp({ shape }: { shape: Shape }) {
  const { height } = geometry(shape);
  return Array.from({ length: shape.columns }, (_, c) => (
    <line key={c} className="weaving-warp" x1={X0 + c * DX} y1={6} x2={X0 + c * DX} y2={height - 6} />
  ));
}

export function Weaving({
  label,
  hint,
  onCancel,
  stopped,
  wide,
  slim,
  children,
}: {
  /** What is being read. */
  label: string;
  /** A quiet second line, shown once the wait has been long enough to deserve one. */
  hint?: string;
  onCancel?: () => void;
  /** The weaving was cancelled, or the thread snapped: the cloth stays as it was, mid-row, with a loose end. */
  stopped?: "cancelled" | "failed";
  /** The wide band, for the foot of a page. */
  wide?: boolean;
  /** A band with fewer rows, for a foot with little room. */
  slim?: boolean;
  /** What to do next, under the cloth. */
  children?: ReactNode;
}) {
  const seconds = useElapsed();
  const shape = slim ? SLIM : wide ? BAND : CLOTH;
  const { width, height, weft } = geometry(shape);
  const rows = Array.from({ length: shape.rows }, (_, r) => r);
  const columns = Array.from({ length: shape.columns }, (_, c) => c);
  const rowState = (r: number) =>
    stopped ? (r < shape.stoppedAt ? " is-done" : r === shape.stoppedAt ? " is-half" : " is-none") : "";
  return (
    <div
      className={`weaving${wide || slim ? " is-wide" : ""}${stopped ? ` is-stopped is-${stopped}` : ""}`}
      role="status"
      aria-live="polite"
    >
      <svg
        className="weaving-cloth"
        viewBox={`0 0 ${width} ${height}`}
        // A slim band fills the width and loses a little off its top and bottom, whatever height it is given.
        preserveAspectRatio={slim ? "xMidYMid slice" : undefined}
        style={{ "--weft": weft } as CSSProperties}
        aria-hidden="true"
        focusable="false"
      >
        <Warp shape={shape} />
        {rows.map((r) => (
          <g
            key={r}
            className={`weaving-row${r % 2 === 0 ? " is-saffron" : ""}${rowState(r)}`}
            style={{ "--r": r } as CSSProperties}
          >
            <line
              className="weaving-weft"
              x1={X0 - 8}
              y1={Y0 + r * DY}
              x2={width - X0 + 8}
              y2={Y0 + r * DY}
            />
            {/* Where the warp passes over the weft: plain weave. */}
            {columns
              .filter((c) => (c + r) % 2 === 0)
              .map((c) => (
                <rect
                  key={c}
                  className="weaving-over"
                  x={X0 + c * DX - 1.6}
                  y={Y0 + r * DY - 5}
                  width={3.2}
                  height={10}
                  rx={1.6}
                />
              ))}
          </g>
        ))}
        {stopped ? (
          <path
            className="weaving-loose"
            d={`M${X0 - 8 + weft / 2} ${Y0 + shape.stoppedAt * DY} q 9 3 7 15 t -3 15 t 4 12`}
          />
        ) : null}
      </svg>
      <p className="weaving-label">
        {label}
        {stopped ? null : <span className="weaving-time mono"> · {seconds} s</span>}
      </p>
      {!stopped && seconds >= 12 && hint ? <p className="weaving-hint">{hint}</p> : null}
      {!stopped && onCancel ? (
        <button type="button" className="link-quiet weaving-cancel" onClick={onCancel}>
          Cancel
        </button>
      ) : null}
      {children}
    </div>
  );
}

/**
 * The same loom, waiting: warp threads stand, no weft yet. It sits on a
 * library's page before it is connected, so pressing Connect starts the
 * weaving on a cloth that was already there.
 */
export function WaitingLoom({ wide, slim, fill }: { wide?: boolean; slim?: boolean; fill?: boolean }) {
  const shape = slim ? SLIM : wide ? BAND : CLOTH;
  const { width, height } = geometry(shape);
  return (
    <div
      className={`weaving is-waiting${wide || slim ? " is-wide" : ""}${fill ? " is-fill" : ""}`}
      aria-hidden="true"
    >
      <svg
        className="weaving-cloth"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio={fill ? "none" : slim ? "xMidYMid slice" : undefined}
        aria-hidden="true"
        focusable="false"
      >
        <Warp shape={shape} />
      </svg>
    </div>
  );
}
