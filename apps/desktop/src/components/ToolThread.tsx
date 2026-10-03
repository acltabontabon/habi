/**
 * A tool, as a thread and a needle. Found: the saffron thread runs through the
 * needle's eye and ends in a knot. Missing: the thread stops short and frays,
 * and a faint guide shows where it would go. It is drawn from whether the tool
 * is really on this machine, the tool's name is always beside it, and it
 * stretches to the room it is given.
 */
import type { CSSProperties } from "react";

/** The needle's eye. When threaded, the thread passes through and the near wall crosses over it. */
function Eye({ threaded }: { threaded: boolean }) {
  return (
    <svg className="tt-eye" viewBox="0 0 16 32" width="16" height="32" aria-hidden="true" focusable="false">
      <ellipse className="tt-eye-ring" cx="8" cy="16" rx="6" ry="11" />
      {threaded ? (
        <>
          <line className="tt-eye-thread" x1="0" y1="16" x2="16" y2="16" />
          <path className="tt-eye-halo" d="M8 5a6 11 0 010 22" />
          <path className="tt-eye-front" d="M8 5a6 11 0 010 22" />
        </>
      ) : null}
    </svg>
  );
}

export function ToolThread({
  found,
  required,
  index = 0,
}: {
  found: boolean;
  /** A missing required tool frays in the warning color, an optional one quietly. */
  required: boolean;
  /** Position in the list, so threads are drawn one after another. */
  index?: number;
}) {
  return (
    <div
      className={`tool-thread ${found ? "is-found" : required ? "is-missing is-required" : "is-missing"}`}
      style={{ "--i": index } as CSSProperties}
      aria-hidden="true"
    >
      {found ? (
        <>
          <span className="tt-run tt-in" />
          <Eye threaded />
          <span className="tt-run tt-out" />
          <span className="tt-knot" />
        </>
      ) : (
        <>
          <span className="tt-run tt-short" />
          <svg
            className="tt-fray"
            viewBox="0 0 12 32"
            width="12"
            height="32"
            aria-hidden="true"
            focusable="false"
          >
            <path d="M0 16l8-6M0 16l9 .5M0 16l7.5 6.5" />
          </svg>
          <span className="tt-guide tt-in" />
          <Eye threaded={false} />
          <span className="tt-guide tt-out" />
        </>
      )}
    </div>
  );
}
