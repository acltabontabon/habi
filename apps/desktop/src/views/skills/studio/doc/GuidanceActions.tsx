import { closeHistory } from "prosemirror-history";
import { TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { useEffect } from "react";
import { openGuidanceChooser } from "./capabilityPieces";
import { moveBlock } from "./commands";
import { selectedGuidance } from "./guidanceContext";

/** Controls act on the live piece; writing stays on the canvas. */
export function GuidanceActions({ view, onSupport }: { view: EditorView | null; onSupport: () => void }) {
  useEffect(() => {
    if (!view) return;
    const act = (event: Event) => {
      if (!view.editable) return;
      const action = (event as CustomEvent<string>).detail;
      if (action === "edit") {
        const selected = selectedGuidance(view.state);
        if (selected) {
          view.dispatch(
            view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(selected.from + 1))),
          );
          view.focus();
        }
      } else if (action === "support") onSupport();
      else if (action === "add") openGuidanceChooser(view);
      else if (action === "up" || action === "down") {
        view.dispatch(closeHistory(view.state.tr));
        moveBlock(action === "up" ? -1 : 1)(view.state, (tr) => view.dispatch(tr));
        view.focus();
      }
    };
    view.dom.addEventListener("habi-guidance-action", act);
    return () => view.dom.removeEventListener("habi-guidance-action", act);
  }, [view, onSupport]);
  return null;
}
