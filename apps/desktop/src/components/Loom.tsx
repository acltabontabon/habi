/**
 * Habi's small loading mark: a few warp threads, and a saffron weft woven
 * across them row after row — over one, under the next — then let go, and
 * woven again. It says "something is being read" in the app's own grammar,
 * and nothing more: it does not pretend to measure progress.
 *
 * Decorative; the words beside it carry the meaning.
 */

const WARPS = 9;
const ROWS = 4;
const X0 = 3;
const DX = 6;
const Y0 = 4;
const DY = 5;
const WIDTH = X0 * 2 + (WARPS - 1) * DX;
const HEIGHT = Y0 * 2 + (ROWS - 1) * DY;

export function Loom({ size = 1 }: { size?: number }) {
  return (
    <svg
      className="loader"
      width={WIDTH * size}
      height={HEIGHT * size}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      aria-hidden="true"
      focusable="false"
    >
      {Array.from({ length: WARPS }, (_, c) => (
        <line
          key={`w${c}`}
          className="loader-warp"
          x1={X0 + c * DX}
          y1={1}
          x2={X0 + c * DX}
          y2={HEIGHT - 1}
        />
      ))}
      {Array.from({ length: ROWS }, (_, r) => {
        const y = Y0 + r * DY;
        return (
          <g key={`r${r}`} className="loader-row" style={{ animationDelay: `${r * 0.22}s` }}>
            <line className="loader-weft" x1={1} y1={y} x2={WIDTH - 1} y2={y} pathLength={1} />
            {/* Where the warp passes over the weft, the weft breaks under it. */}
            {Array.from({ length: WARPS }, (_, c) =>
              (c + r) % 2 === 0 ? (
                <g key={`o${c}`} className="loader-over">
                  <line className="loader-gap" x1={X0 + c * DX} y1={y - 1.8} x2={X0 + c * DX} y2={y + 1.8} />
                  <line
                    className="loader-cross"
                    x1={X0 + c * DX}
                    y1={y - 2.6}
                    x2={X0 + c * DX}
                    y2={y + 2.6}
                  />
                </g>
              ) : null,
            )}
          </g>
        );
      })}
    </svg>
  );
}
