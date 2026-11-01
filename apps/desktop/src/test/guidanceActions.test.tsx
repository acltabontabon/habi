import { act, fireEvent, render, screen } from "@testing-library/react";
import { history, undo } from "prosemirror-history";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { afterEach, expect, it, vi } from "vitest";
import { GuidanceActions } from "../views/skills/studio/doc/GuidanceActions";
import { guidanceContextPlugin } from "../views/skills/studio/doc/guidanceContext";
import { parseBody } from "../views/skills/studio/doc/markdown/parse";
import { write } from "../views/skills/studio/doc/markdown/reconcile";

Element.prototype.scrollIntoView = () => {};
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, bottom: 0, right: 0 }) as DOMRect;
const views: EditorView[] = [];
afterEach(() => {
  for (const view of views.splice(0)) {
    const root = view.dom.parentElement;
    view.destroy();
    root?.remove();
  }
});
function setup() {
  const source = "Read the notes.\n\nReport the decisions.\n";
  const parsed = parseBody(source);
  const host = document.body.appendChild(document.createElement("div"));
  const view = new EditorView(host, {
    state: EditorState.create({ doc: parsed.doc, plugins: [history(), guidanceContextPlugin()] }),
  });
  views.push(view);
  const support = vi.fn();
  render(<GuidanceActions view={view} onSupport={support} />);
  return { view, support, source, text: () => write(view.state.doc, parsed.baseline).text };
}
it("edits the live canvas without a separate form", () => {
  const { view, source, text } = setup();
  expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Instruction options" }));
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  expect(view.hasFocus()).toBe(true);
  expect(screen.queryByRole("form", { name: "Edit instruction" })).not.toBeInTheDocument();
  expect(text()).toBe(source);
  act(() => {
    view.dispatch(view.state.tr.insertText("First, "));
  });
  expect(text()).toBe(`First, ${source}`);
  act(() => {
    undo(view.state, view.dispatch);
  });
  expect(text()).toBe(source);
});
it("moves the selected unit through visible controls and opens support without mutating source", () => {
  const { view, source, support, text } = setup();
  fireEvent.click(screen.getByRole("button", { name: "Instruction options" }));
  expect(screen.getByRole("button", { name: "Move up" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Add support" }));
  expect(support).toHaveBeenCalledOnce();
  expect(text()).toBe(source);
  fireEvent.click(screen.getByRole("button", { name: "Instruction options" }));
  fireEvent.click(screen.getByRole("button", { name: "Move down" }));
  expect(text()).toBe("Report the decisions.\n\nRead the notes.\n");
  act(() => {
    undo(view.state, view.dispatch);
  });
  expect(text()).toBe(source);
});
