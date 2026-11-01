import { fireEvent, render, screen } from "@testing-library/react";
import { history, undo } from "prosemirror-history";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachGuidanceMaterial,
  attachGuidanceSkill,
  captureGuidanceTarget,
  guidanceContextPlugin,
} from "../views/skills/studio/doc/guidanceContext";
import { readGuidanceFields, updateGuidanceFields } from "../views/skills/studio/doc/guidanceFields";
import { parseBody } from "../views/skills/studio/doc/markdown/parse";
import { write } from "../views/skills/studio/doc/markdown/reconcile";
import { GuidanceEditor } from "../views/skills/studio/GuidanceEditor";

const views: EditorView[] = [];
afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
});
Element.prototype.scrollIntoView = () => {};
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, bottom: 0, right: 0 }) as DOMRect;
function open(source: string, selected = "") {
  const parsed = parseBody(source);
  const view = new EditorView(document.createElement("div"), {
    state: EditorState.create({ doc: parsed.doc, plugins: [history(), guidanceContextPlugin()] }),
  });
  views.push(view);
  let at = 1;
  view.state.doc.descendants((node, pos) => {
    if (node.isText && selected && node.text?.includes(selected)) at = pos;
  });
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)));
  const target = captureGuidanceTarget(view);
  if (!target) throw new Error("Missing target");
  return { view, target, text: () => write(view.state.doc, parsed.baseline).text };
}

describe("literal instruction fields", () => {
  it.each(["Condition", "Constraint", "Expected result"])(
    "edits %s without changing its Markdown prefix or neighboring bytes",
    (kind) => {
      const source = `Keep  spaces.\n\n**${kind}:** Do the work.\n\n<!-- exact -->\n`;
      const { view, target, text } = open(source, "Do the work");
      const fields = readGuidanceFields(view, target);
      if (!fields) throw new Error("Missing fields");
      expect(fields.label).toBe(kind);
      expect(updateGuidanceFields(view, target, fields, "Review the work.")).toBe("saved");
      expect(text()).toBe(source.replace("Do the work.", "Review the work."));
      undo(view.state, view.dispatch);
      expect(text()).toBe(source);
    },
  );

  it("edits the retained repeated instruction after preceding edits and another selection", () => {
    const { view, target, text } = open("1. Check.\n2. Check.\n3. Check.\n", "Check");
    const fields = readGuidanceFields(view, target);
    if (!fields) throw new Error("Missing fields");
    view.dispatch(view.state.tr.insertText("First ", 3));
    view.dispatch(view.state.tr.setSelection(TextSelection.atStart(view.state.doc)));
    expect(updateGuidanceFields(view, target, fields, "Third check.")).toBe("saved");
    expect(text()).toBe("1. First Check.\n2. Check.\n3. Third check.\n");
  });

  it("preserves connected script and skill nodes while editing only base guidance", () => {
    const { view, target, text } = open("**Condition:** When files change, inspect them.\n");
    attachGuidanceMaterial(view, target, "scripts/check files.py", "inspect files");
    attachGuidanceSkill(view, target, { name: "review" }, "review is needed");
    const original = text();
    const fields = readGuidanceFields(view, target);
    if (!fields) throw new Error("Missing fields");
    expect(fields.value).toBe("When files change, inspect them.");
    expect(fields.hasConnections).toBe(true);
    const suffix = fields.paragraph.content.cut(fields.end);
    expect(updateGuidanceFields(view, target, fields, "When code changes, inspect it.")).toBe("saved");
    const selection = target.resolve(view);
    const updated = selection && view.state.doc.nodeAt(selection.from);
    expect(updated?.content.cut(fields.start + "When code changes, inspect it.".length).eq(suffix)).toBe(
      true,
    );
    expect(text()).toBe(
      original.replace("When files change, inspect them.", "When code changes, inspect it."),
    );
    undo(view.state, view.dispatch);
    expect(text()).toBe(original);
  });

  it.each([
    "Review **important** changes.\n",
    "Read [policy](references/policy.md).\n",
    "Use `code` carefully.\n",
    "![diagram](assets/map.png)\n",
  ])("does not flatten unsupported rich content: %s", (source) => {
    const { view, target, text } = open(source);
    expect(readGuidanceFields(view, target)).toBeNull();
    render(<GuidanceEditor view={view} target={target} onClose={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Edit on canvas" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save instruction" })).not.toBeInTheDocument();
    expect(text()).toBe(source);
  });

  it("refuses stale content, removed targets and read-only changes", () => {
    const { view, target, text } = open("First.\n\nLast.\n");
    const fields = readGuidanceFields(view, target);
    if (!fields) throw new Error("Missing fields");
    view.dispatch(view.state.tr.insertText("Updated ", 1));
    expect(updateGuidanceFields(view, target, fields, "Overwrite.")).toBe("changed");
    expect(text()).toContain("Updated First.");
    const selected = target.resolve(view);
    if (!selected) throw new Error("Missing target");
    view.dispatch(view.state.tr.delete(selected.from, selected.to));
    expect(updateGuidanceFields(view, target, fields, "Overwrite.")).toBe("unavailable");
    expect(text()).toBe("Last.\n");
    view.setProps({ editable: () => false });
    expect(updateGuidanceFields(view, target, fields, "Overwrite.")).toBe("unavailable");
  });

  it("saves literal text through a labeled field with one undo step", () => {
    const { view, target, text } = open("Review the changes.\n");
    const onClose = vi.fn();
    render(<GuidanceEditor view={view} target={target} onClose={onClose} />);
    expect(screen.getByLabelText("Instruction")).toHaveFocus();
    fireEvent.change(screen.getByLabelText("Instruction"), {
      target: { value: "Review [all](unsafe) changes." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save instruction" }));
    expect(view.state.doc.firstChild?.childCount).toBe(1);
    expect(view.state.doc.firstChild?.firstChild?.marks).toHaveLength(0);
    expect(onClose).toHaveBeenCalledOnce();
    undo(view.state, view.dispatch);
    expect(text()).toBe("Review the changes.\n");
  });
});
