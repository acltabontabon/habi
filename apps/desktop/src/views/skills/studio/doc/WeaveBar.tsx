import { TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { useEffect, useReducer } from "react";
import { CanvasToolMenu } from "./CanvasToolMenu";
import { armDrag, ghostLabel } from "./drag";
import { selectedGuidance, subscribeGuidance } from "./guidanceContext";

export type WeaveKind = "skill" | "script" | "reference" | "existing";

/** Every contribution joins a selected instruction through the same retained target. */
export function WeaveBar({
  view,
  onWeave,
  embedded = false,
}: {
  view: EditorView | null;
  onWeave: (kind: WeaveKind) => void;
  embedded?: boolean;
}) {
  const [, refresh] = useReducer((value: number) => value + 1, 0);
  useEffect(() => (view ? subscribeGuidance(view, refresh) : undefined), [view]);
  const selected = view ? selectedGuidance(view.state) : null;
  const ready = !!selected && selected.label !== "New instruction";
  const options = (
    <>
      {" "}
      <p className="canvas-tool-heading">What would help this step?</p>
      <div className="canvas-support-options">
        {(
          [
            ["skill", "⌁", "Another skill", "Borrow expertise you already have", "Skill"],
            ["script", "▷", "A tool for the job", "Give it a repeatable task", "Script"],
            ["reference", "▤", "Something to read", "Bring a guide, example, or notes", "Reference"],
          ] as const
        ).map(([kind, glyph, label, hint, type]) => (
          <button
            type="button"
            key={kind}
            disabled={!ready}
            className={`weave-choice is-${kind}`}
            title="Drag onto a step, or click to choose"
            onPointerDown={(event) => {
              if (!view?.editable) return;
              armDrag(event.nativeEvent, () => {
                const source = view.state.doc;
                return {
                  view,
                  ghost: ghostLabel(label),
                  instructions: true,
                  instructionsOnly: true,
                  onLand: (landing) => {
                    if (landing.type !== "instruction" || view.state.doc !== source) return;
                    view.dispatch(
                      view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(landing.pos + 1))),
                    );
                    onWeave(kind);
                  },
                };
              });
            }}
            onClick={(event) => {
              const menu = event.currentTarget.closest("details");
              if (menu) menu.open = false;
              onWeave(kind);
            }}
          >
            <span className="weave-choice-glyph" aria-hidden="true">
              {glyph}
            </span>
            <span>
              <strong>{label}</strong>
              <small>{hint}</small>
            </span>
            <span className="canvas-choice-type">{type}</span>
          </button>
        ))}
      </div>
    </>
  );
  return (
    <div className="canvas-support-tool">
      {embedded ? (
        options
      ) : (
        <CanvasToolMenu label="Give it support" glyph="⌁">
          {options}
        </CanvasToolMenu>
      )}
      {!embedded ? (
        <span className="canvas-support-target">
          {ready ? `For ${selected.location.toLowerCase()}` : "Select a step on the canvas"}
        </span>
      ) : null}
    </div>
  );
}
