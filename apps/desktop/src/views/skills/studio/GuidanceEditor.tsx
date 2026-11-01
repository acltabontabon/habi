import { TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../../components/ui";
import type { GuidanceTarget } from "./doc/guidanceContext";
import { readGuidanceFields, updateGuidanceFields } from "./doc/guidanceFields";
import "../../../styles/guidance-editor.css";

/** Parent owns the captured target and releases it when closing this editor. */
export function GuidanceEditor({
  view,
  target,
  onClose,
  readOnly = false,
}: {
  view: EditorView;
  target: GuidanceTarget;
  onClose: () => void;
  readOnly?: boolean;
}) {
  const [fields, setFields] = useState(() => readGuidanceFields(view, target));
  const [value, setValue] = useState(fields?.value ?? "");
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const next = readGuidanceFields(view, target);
    setFields(next);
    setValue(next?.value ?? "");
    setError("");
    input.current?.focus();
  }, [view, target]);
  const canvas = () => {
    const selected = target.resolve(view);
    if (selected && !view.isDestroyed)
      view.dispatch(
        view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(selected.from + 1))),
      );
    onClose();
    if (!view.isDestroyed) view.focus();
  };
  return (
    <form
      className="guidance-field-editor"
      aria-label="Edit instruction"
      onSubmit={(event) => {
        event.preventDefault();
        if (!fields || readOnly) return;
        const result = updateGuidanceFields(view, target, fields, value);
        if (result === "saved") {
          onClose();
          view.focus();
        } else
          setError(
            result === "changed"
              ? "This instruction changed while you were editing. Reopen it to use the latest words."
              : result === "multiline"
                ? "Keep this instruction on one line. Use the canvas for several paragraphs."
                : "This instruction is no longer available to edit.",
          );
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
          view.focus();
        }
      }}
    >
      {fields ? (
        <>
          <label>
            {fields.label}
            <input
              ref={input}
              value={value}
              disabled={readOnly}
              onChange={(event) => setValue(event.target.value)}
            />
          </label>
          {fields.hasConnections ? <p>Connected skills and materials stay attached.</p> : null}
          {error ? <p role="alert">{error}</p> : null}
          <div>
            <Button type="submit" size="sm" variant="primary" disabled={readOnly}>
              Save instruction
            </Button>
            <Button size="sm" variant="quiet" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </>
      ) : (
        <>
          <p>
            This instruction includes formatted content. Edit it on the canvas to keep its links and
            formatting.
          </p>
          <Button size="sm" onClick={canvas}>
            Edit on canvas
          </Button>
        </>
      )}
    </form>
  );
}
