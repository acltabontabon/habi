import { CanvasToolMenu } from "./CanvasToolMenu";
import type { CapabilityKind } from "./capabilityPieces";

const pieces: { kind: CapabilityKind; title: string; hint: string; glyph: string }[] = [
  { kind: "instruction", title: "An instruction", hint: "Give your agent a guiding thought", glyph: "✳" },
  { kind: "procedure", title: "A sequence", hint: "A heading and three editable steps", glyph: "≋" },
  { kind: "condition", title: "A decision", hint: "Teach it when to take another path", glyph: "◇" },
  { kind: "constraint", title: "A boundary", hint: "A heading and a rule to build on", glyph: "⌁" },
  { kind: "example", title: "An example", hint: "A heading and an example to make yours", glyph: "❞" },
  { kind: "result", title: "The result", hint: "Give good work a clear shape", glyph: "↗" },
];

function PieceSketch({ kind }: { kind: CapabilityKind }) {
  return (
    <div className={`canvas-piece-sketch is-${kind}`} aria-hidden="true">
      {kind === "procedure" ? (
        <>
          <span>
            <i>1</i> Gather
          </span>
          <span>
            <i>2</i> Make sense
          </span>
          <span>
            <i>3</i> Deliver
          </span>
        </>
      ) : kind === "condition" ? (
        <>
          <span className="sketch-when">When this happens</span>
          <span className="sketch-branch">↳</span>
          <span className="sketch-then">Take this path</span>
        </>
      ) : kind === "instruction" ? (
        <>
          <span className="sketch-star">✳</span>
          <span>
            Make the complex
            <br />
            <em>feel simple.</em>
          </span>
        </>
      ) : kind === "constraint" ? (
        <span className="sketch-boundary">
          Keep it
          <br />
          <em>within bounds.</em>
        </span>
      ) : kind === "example" ? (
        <>
          <span className="sketch-quote">“</span>
          <span>A little like this.</span>
          <span className="sketch-line" />
        </>
      ) : (
        <>
          <span className="sketch-sheet">
            <i />
            <i />
            <i />
            <b>✓</b>
          </span>
          <span className="sketch-result">Ready to use.</span>
        </>
      )}
    </div>
  );
}

export function CanvasPalette({
  empty,
  ready,
  onPick,
  embedded = false,
  onLift,
}: {
  embedded?: boolean;
  onLift?: (kind: CapabilityKind, event: PointerEvent) => void;
  empty: boolean;
  ready: boolean;
  onPick: (kind: CapabilityKind) => void;
}) {
  if (!empty) {
    const options = (
      <>
        {" "}
        <p className="canvas-tool-heading">What comes next?</p>
        <div className="canvas-step-options">
          {pieces.map((piece, index) => (
            <button
              type="button"
              key={piece.kind}
              disabled={!ready}
              onPointerDown={(event) => onLift?.(piece.kind, event.nativeEvent)}
              title="Drag onto the canvas, or click to add"
              className={`canvas-step-option is-${piece.kind}`}
              onClick={(event) => {
                const menu = event.currentTarget.closest("details");
                if (menu) menu.open = false;
                onPick(piece.kind);
              }}
            >
              <span className="canvas-piece-glyph" aria-hidden="true">
                {piece.glyph}
              </span>
              <span>
                <strong>
                  {
                    [
                      "A simple step",
                      "A few steps",
                      "A choice",
                      "A guardrail",
                      "An example",
                      "A finished result",
                    ][index]
                  }
                </strong>
                <small>{piece.hint}</small>
              </span>
            </button>
          ))}
        </div>
      </>
    );
    return embedded ? (
      options
    ) : (
      <CanvasToolMenu label="Add a step" glyph="✳">
        {options}
      </CanvasToolMenu>
    );
  }
  return (
    <section
      className={`canvas-palette${empty ? " is-start" : " is-dock"}`}
      aria-label={empty ? "Start your skill" : "Add to your skill"}
    >
      {empty ? (
        <header className="canvas-invitation">
          <div>
            <span className="canvas-kicker">A LITTLE KNOW-HOW GOES A LONG WAY</span>
            <h2>
              What will you teach
              <br />
              your agent?
            </h2>
            <p>Start with a piece. Shape it right on the canvas.</p>
          </div>
          <svg className="canvas-thread-art" viewBox="0 0 240 160" fill="none" aria-hidden="true">
            <path d="M10 90C55 90 45 25 95 25S130 135 180 135S210 80 235 80" />
            <path d="M10 110C65 110 50 45 95 45S130 115 180 115S210 60 235 60" />
            <path d="M10 130C75 130 55 65 95 65S130 95 180 95S210 40 235 40" />
          </svg>
        </header>
      ) : (
        <span className="canvas-dock-label">Add a piece</span>
      )}
      <div className="canvas-pieces">
        {pieces.map((piece) => (
          <button
            type="button"
            key={piece.kind}
            className={`canvas-piece is-${piece.kind}`}
            disabled={!ready}
            onClick={(event) => {
              const menu = event.currentTarget.closest("details");
              if (menu) menu.open = false;
              onPick(piece.kind);
            }}
            aria-label={`Add ${piece.title.toLowerCase()}`}
          >
            {empty ? (
              <PieceSketch kind={piece.kind} />
            ) : (
              <span className="canvas-piece-glyph" aria-hidden="true">
                {piece.glyph}
              </span>
            )}
            <span className="canvas-piece-caption">
              <strong>{piece.title}</strong>
              {empty && <small>{piece.hint}</small>}
            </span>
            {empty && (
              <span className="canvas-piece-add" aria-hidden="true">
                +
              </span>
            )}
          </button>
        ))}
      </div>
    </section>
  );
}
