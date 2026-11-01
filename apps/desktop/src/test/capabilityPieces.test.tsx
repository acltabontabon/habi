import { act, fireEvent, render, screen, within } from "@testing-library/react";
import axe from "axe-core";
import { undo } from "prosemirror-history";
import { Schema } from "prosemirror-model";
import { EditorState, TextSelection } from "prosemirror-state";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  CAPABILITY_PIECES,
  insertAuthoredCapability,
  insertCanvasPiece,
  insertCanvasStructure,
  insertionAtSelection,
  openGuidanceChooser,
} from "../views/skills/studio/doc/capabilityPieces";
import { DocEditor, type DocEditorHandle } from "../views/skills/studio/doc/DocEditor";
import { CapabilityForm } from "../views/skills/studio/doc/Pieces";
import { SelectionBar } from "../views/skills/studio/doc/SelectionBar";

const rect = { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) };
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => rect as DOMRect;
Element.prototype.scrollIntoView = () => {};
document.elementFromPoint = () => null;

function mount(source: string) {
  const handle = createRef<DocEditorHandle>();
  const onChoose = vi.fn();
  const result = render(
    <DocEditor
      handle={handle}
      value={source}
      label="Instructions"
      onChange={vi.fn()}
      paths={() => []}
      context={{
        onChoosePiece: onChoose,
        files: () => [{ path: "scripts/check.sh", name: "check.sh", referenced: false }],
      }}
    />,
  );
  const view = handle.current?.view();
  if (!view) throw new Error("Editor did not mount");
  return { ...result, handle, view, onChoose };
}

const choices = () => screen.getByRole("dialog", { name: "Add guidance" });

describe("capability authoring", () => {
  it("inserts after the selected instruction even when the toolbar has focus", () => {
    const source = "First instruction\n\nLast instruction\n";
    const { view, handle } = mount(source);
    act(() => view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3))));
    const add = screen.getByRole("button", { name: /Add guidance/ });
    add.focus();
    fireEvent.click(add);
    fireEvent.click(within(choices()).getByRole("button", { name: /^Condition/ }));
    const text = handle.current?.text() ?? "";
    expect(text.indexOf("First instruction")).toBeLessThan(text.indexOf("**Condition:**"));
    expect(text.indexOf("**Condition:**")).toBeLessThan(text.indexOf("Last instruction"));
    expect(text).toContain("Do: Ask one focused question before proceeding.");
    expect(view.state.doc.textBetween(view.state.selection.from, view.state.selection.to)).toBe(
      "the request is ambiguous",
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(view.hasFocus()).toBe(true);
    act(() => view.dispatch(view.state.tr.insertText("authentication changes")));
    expect(handle.current?.text()).toContain("When authentication changes.");
  });

  it.each(CAPABILITY_PIECES.filter((piece) => piece.kind !== undefined))(
    "$label is portable and undoes to the original bytes",
    (piece) => {
      const source = "First   instruction\n\n\n* preserve this\n\n<!-- unknown -->\n";
      const { view, handle } = mount(source);
      act(() => {
        if (!piece.kind) throw new Error("Missing kind");
        expect(
          insertAuthoredCapability(view, view.state.doc.firstChild?.nodeSize ?? 0, piece.kind, {
            content: "Check the result.",
            when: "authentication changes",
            steps: ["Inspect inputs.", "Verify outputs."],
          }),
        ).toBe(true);
      });
      expect(handle.current?.text()).not.toBe(source);
      expect(handle.current?.text()).not.toContain("…");
      expect(handle.current?.text()).toContain("* preserve this\n\n<!-- unknown -->");
      act(() => {
        undo(view.state, view.dispatch);
      });
      expect(handle.current?.text()).toBe(source);
    },
  );

  it("authors procedure steps without Markdown and undoes the whole insertion", () => {
    const source = "First\n\nLast\n";
    const { view, handle } = mount(source);
    render(
      <CapabilityForm
        kind="procedure"
        onSubmit={(values) => insertAuthoredCapability(view, insertionAtSelection(view), "procedure", values)}
      />,
    );
    expect(screen.getByLabelText("Step 1")).toHaveFocus();
    expect(screen.getByRole("button", { name: "Add procedure" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Step 1"), { target: { value: "Inspect changed files." } });
    fireEvent.click(screen.getByRole("button", { name: "Add step" }));
    expect(screen.getByRole("button", { name: "Add procedure" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Step 2"), { target: { value: "Report any findings." } });
    expect(handle.current?.text()).toBe(source);
    fireEvent.click(screen.getByRole("button", { name: "Add procedure" }));
    expect(handle.current?.text()).toContain("1. Inspect changed files.\n2. Report any findings.");
    act(() => {
      undo(view.state, view.dispatch);
    });
    expect(handle.current?.text()).toBe(source);
  });

  it("keeps entered formatting syntax literal and preserves code indentation", () => {
    const { view, handle } = mount("Before\n");
    act(() =>
      insertAuthoredCapability(view, view.state.doc.content.size, "instruction", {
        content: "Keep **these words** literal.",
      }),
    );
    const authored = view.state.doc.lastChild;
    expect(authored?.textContent).toBe("Keep **these words** literal.");
    expect(authored?.firstChild?.marks).toEqual([]);
    act(() =>
      insertAuthoredCapability(view, view.state.doc.content.size, "example", {
        content: "def check():\n    return True\n",
        code: true,
      }),
    );
    expect(view.state.doc.lastChild?.type.name).toBe("code_block");
    expect(view.state.doc.lastChild?.textContent).toBe("def check():\n    return True\n");
    expect(handle.current?.text()).toContain("    return True");
  });

  it("cancels an authored instruction without changing source and keeps textarea navigation native", () => {
    const { view, handle } = mount("Keep this\n");
    const cancel = vi.fn(() => view.focus());
    render(<CapabilityForm kind="instruction" onSubmit={() => false} onCancel={cancel} />);
    const input = screen.getByLabelText("What should the agent do?");
    fireEvent.change(input, { target: { value: "Unsubmitted guidance" } });
    expect(fireEvent.keyDown(input, { key: "ArrowDown" })).toBe(true);
    expect(input).toHaveFocus();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(view.hasFocus()).toBe(true);
    expect(handle.current?.text()).toBe("Keep this\n");
  });

  it("creates the first real instruction and supports keyboard submission", () => {
    const { view, handle } = mount("");
    render(
      <CapabilityForm
        kind="instruction"
        onSubmit={(values) => insertAuthoredCapability(view, 0, "instruction", values)}
      />,
    );
    const input = screen.getByLabelText("What should the agent do?");
    fireEvent.change(input, { target: { value: "Inspect changed files before suggesting a fix." } });
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    expect(handle.current?.text()).toBe("Inspect changed files before suggesting a fix.");
    expect(view.state.doc.childCount).toBe(1);
    act(() => {
      undo(view.state, view.dispatch);
    });
    expect(handle.current?.text()).toBe("");
  });

  it("has accessible condition form fields", async () => {
    const { view, container } = mount("Keep this\n");
    render(
      <CapabilityForm
        kind="condition"
        onSubmit={(values) => insertAuthoredCapability(view, 0, "condition", values)}
      />,
    );
    const result = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(result.violations.map((v) => v.id)).toEqual([]);
  });

  it.each(CAPABILITY_PIECES.filter((piece) => piece.kind !== undefined))(
    "$label lands directly on the canvas, selected for editing, and undoes once",
    (piece) => {
      const source = "Before  this\n\n\n<!-- preserve -->\n";
      const { view, handle } = mount(source);
      act(() => {
        if (!piece.kind) throw new Error("Missing kind");
        expect(insertCanvasPiece(view, view.state.doc.firstChild?.nodeSize ?? 0, piece.kind)).toBe(true);
      });
      expect(view.hasFocus()).toBe(true);
      expect(view.state.selection.empty).toBe(false);
      expect(handle.current?.text()).not.toContain("…");
      expect(handle.current?.text()).toContain("<!-- preserve -->");
      act(() => {
        undo(view.state, view.dispatch);
      });
      expect(handle.current?.text()).toBe(source);
    },
  );

  it("places a piece after a procedure without splitting or changing its steps", () => {
    const source = "1. Gather context.\n2. Do the work.\n3. Verify it.\n\nConclusion\n";
    const { view, handle } = mount(source);
    const procedure = view.state.doc.firstChild;
    if (!procedure) throw new Error("Missing procedure");
    act(() => {
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 25)));
      openGuidanceChooser(view, "constraint");
    });
    expect(view.state.doc.firstChild?.eq(procedure)).toBe(true);
    expect(view.state.doc.child(1).textContent).toBe("Guardrails");
    expect(view.state.doc.child(2).textContent).toMatch(/^Constraint:/);
    expect(view.state.doc.lastChild?.textContent).toBe("Conclusion");
    act(() => {
      undo(view.state, view.dispatch);
    });
    expect(handle.current?.text()).toBe(source);
  });

  it("replaces the empty canvas with a titled sequence", () => {
    const { view, handle } = mount("");
    act(() => openGuidanceChooser(view, "procedure"));
    expect(view.state.doc.childCount).toBe(2);
    expect(view.state.doc.firstChild?.type.name).toBe("heading");
    expect(view.state.doc.child(1).type.name).toBe("ordered_list");
    expect(view.state.doc.child(1).childCount).toBe(3);
    expect(view.state.doc.textBetween(view.state.selection.from, view.state.selection.to)).toBe(
      "How to do it",
    );
    act(() => view.dispatch(view.state.tr.insertText("Review the changes")));
    expect(handle.current?.text()).toContain("## Review the changes");
    expect(handle.current?.text()).toContain("1. Gather the context");
    expect(handle.current?.text()).toContain("2. Work through the task");
  });

  it("opens choices from the keyboard and Escape returns to the instructions", () => {
    const { view, handle } = mount("Keep this\n");
    fireEvent.click(screen.getByRole("button", { name: /Add guidance/ }));
    expect(within(choices()).getByRole("button", { name: /^Instruction/ })).toHaveFocus();
    fireEvent.keyDown(choices(), { key: "ArrowDown" });
    expect(within(choices()).getByRole("button", { name: /^Procedure/ })).toHaveFocus();
    fireEvent.keyDown(choices(), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(view.hasFocus()).toBe(true);
    expect(handle.current?.text()).toBe("Keep this\n");
  });

  it("opens guidance at the caret with the keyboard shortcut", () => {
    const { view } = mount("First\n\nLast\n");
    act(() => {
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)));
      const handled = view.someProp("handleKeyDown", (handler) =>
        handler(view, new KeyboardEvent("keydown", { key: "I", metaKey: true, shiftKey: true })),
      );
      expect(handled).toBe(true);
    });
    expect(choices()).toBeInTheDocument();
  });

  it("dismisses an insertion target after the document changes", () => {
    const { view } = mount("First\n\nLast\n");
    fireEvent.click(screen.getByRole("button", { name: /Add guidance/ }));
    act(() => view.dispatch(view.state.tr.insertText("Changed", 1)));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("attaches an existing script at the retained location", () => {
    const { handle, view } = mount("First\n\nLast\n");
    act(() => view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2))));
    fireEvent.click(screen.getByRole("button", { name: /Add guidance/ }));
    fireEvent.click(within(choices()).getByRole("button", { name: /^Resource/ }));
    fireEvent.click(screen.getByRole("button", { name: "check.sh" }));
    const text = handle.current?.text() ?? "";
    expect(text.indexOf("First")).toBeLessThan(text.indexOf("scripts/check.sh"));
    expect(text.indexOf("scripts/check.sh")).toBeLessThan(text.indexOf("Last"));
  });

  it("opens skill selection without changing the source", () => {
    const { handle, onChoose } = mount("Keep this\n");
    fireEvent.click(screen.getByRole("button", { name: /Add guidance/ }));
    fireEvent.click(within(choices()).getByRole("button", { name: /^Skill reference/ }));
    expect(onChoose).toHaveBeenCalledWith("skill");
    expect(handle.current?.text()).toBe("Keep this\n");
  });

  it("has no accessibility violations with choices open", async () => {
    const { container } = mount("Instructions\n");
    fireEvent.click(screen.getByRole("button", { name: /Add guidance/ }));
    const result = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(result.violations.map((v) => v.id)).toEqual([]);
  });
});

it("inserts a palette step between numbered steps and undoes cleanly", () => {
  const { view } = mount("1. First step\n2. Last step\n");
  const before = view.state.doc;
  const list = before.firstChild;
  if (!list?.firstChild) throw new Error("Expected a procedure");
  const insertion = 1 + list.firstChild.nodeSize;
  act(() => {
    expect(insertCanvasPiece(view, insertion, "instruction")).toBe(true);
  });
  expect(view.state.doc.firstChild?.childCount).toBe(3);
  expect(view.state.doc.firstChild?.child(0).textContent).toBe("First step");
  expect(view.state.doc.firstChild?.child(2).textContent).toBe("Last step");
  act(() => {
    undo(view.state, view.dispatch);
  });
  expect(view.state.doc.eq(before)).toBe(true);
});

it("formats at the caret and inserts a link without requiring highlighted text", () => {
  const { view } = mount("Write here.\n");
  act(() => view.focus());
  render(<SelectionBar embedded view={view} tick={0} />);
  const toolbar = within(screen.getByRole("toolbar", { name: "Format your writing" }));
  fireEvent.click(toolbar.getByRole("button", { name: "Bold" }));
  act(() => {
    view.dispatch(view.state.tr.insertText("Bold "));
  });
  expect(view.state.doc.firstChild?.firstChild?.marks.some((mark) => mark.type.name === "strong")).toBe(true);
  fireEvent.click(toolbar.getByRole("button", { name: "Link" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Link address" }), {
    target: { value: "https://example.com" },
  });
  fireEvent.click(toolbar.getByRole("button", { name: "Apply" }));
  expect(view.state.doc.textContent).toContain("https://example.com");
  const link = view.state.schema.marks.link;
  if (!link) throw new Error("Expected link mark");
  expect(view.state.doc.rangeHasMark(1, view.state.doc.content.size, link)).toBe(true);
});

it("shows formatting only for selected text", () => {
  const { view } = mount("Write here.\n");
  act(() => view.focus());
  const { rerender } = render(<SelectionBar atCaret view={view} tick={0} />);
  expect(screen.queryByRole("toolbar", { name: "Format your writing" })).not.toBeInTheDocument();
  act(() => view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 6))));
  rerender(<SelectionBar atCaret view={view} tick={1} />);
  expect(screen.getByRole("toolbar", { name: "Format your writing" })).toBeVisible();
  act(() => view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 6))));
  rerender(<SelectionBar atCaret view={view} tick={2} />);
  expect(screen.queryByRole("toolbar", { name: "Format your writing" })).not.toBeInTheDocument();
});
it.each(["heading", "divider"] as const)("adds a %s after the current piece without replacing it", (kind) => {
  const { view } = mount("First paragraph.\n\nLast paragraph.\n");
  const before = view.state.doc;
  act(() => {
    expect(insertCanvasStructure(view, kind)).toBe(true);
  });
  expect(view.state.doc.firstChild?.textContent).toBe("First paragraph.");
  expect(view.state.doc.child(1).type.name).toBe(kind === "heading" ? "heading" : "horizontal_rule");
  expect(view.state.doc.lastChild?.textContent).toBe("Last paragraph.");
  act(() => {
    undo(view.state, view.dispatch);
  });
  expect(view.state.doc.eq(before)).toBe(true);
});

it.each(["heading", "divider"] as const)(
  "drops a %s between numbered steps without turning it into a step",
  (kind) => {
    const { view } = mount("1. First step\n2. Second step\n3. Third step\n");
    const before = view.state.doc;
    const first = before.firstChild?.firstChild;
    if (!first) throw new Error("Missing first step");
    act(() => {
      expect(insertCanvasStructure(view, kind, 1 + first.nodeSize)).toBe(true);
    });
    expect(view.state.doc.child(0).textContent).toBe("First step");
    expect(view.state.doc.child(1).type.name).toBe(kind === "heading" ? "heading" : "horizontal_rule");
    expect(view.state.doc.lastChild?.attrs.start).toBe(2);
    expect(view.state.doc.lastChild?.childCount).toBe(2);
    expect(view.state.doc.lastChild?.textContent).toBe("Second stepThird step");
    act(() => {
      undo(view.state, view.dispatch);
    });
    expect(view.state.doc.eq(before)).toBe(true);
  },
);

it.each([
  "instruction",
  "procedure",
  "condition",
  "constraint",
  "example",
  "result",
  "heading",
  "divider",
] as const)("adds %s to an editor whose schema predates a reload", (kind) => {
  const { view } = mount("Existing work.\n");
  const otherSchema = new Schema(view.state.schema.spec);
  act(() =>
    view.updateState(
      EditorState.create({
        doc: otherSchema.nodeFromJSON(view.state.doc.toJSON()),
        plugins: view.state.plugins,
      }),
    ),
  );
  const before = view.state.doc;
  act(() => {
    expect(
      kind === "heading" || kind === "divider"
        ? insertCanvasStructure(view, kind)
        : insertCanvasPiece(view, before.content.size, kind),
    ).toBe(true);
  });
  expect(view.state.doc.childCount).toBeGreaterThan(1);
  expect(view.state.doc.firstChild?.textContent).toBe("Existing work.");
  expect(() => view.state.doc.check()).not.toThrow();
  act(() => {
    undo(view.state, view.dispatch);
  });
  expect(view.state.doc.eq(before)).toBe(true);
});

it("adds a heading with a new sequence, selects its title, and undoes it together", () => {
  const { view } = mount("Existing work.\n");
  const before = view.state.doc;
  act(() => {
    expect(insertCanvasPiece(view, before.content.size, "procedure")).toBe(true);
  });
  expect(view.state.doc.child(1).type.name).toBe("heading");
  expect(view.state.doc.child(1).attrs.level).toBe(2);
  expect(view.state.doc.child(2).type.name).toBe("ordered_list");
  expect(view.state.doc.child(2).childCount).toBe(3);
  expect(view.state.doc.textBetween(view.state.selection.from, view.state.selection.to)).toBe("How to do it");
  act(() => {
    undo(view.state, view.dispatch);
  });
  expect(view.state.doc.eq(before)).toBe(true);
});

it.each([
  ["constraint", "Guardrails"],
  ["example", "Examples"],
] as const)("gives %s a ready-to-rename section without losing its content", (kind, title) => {
  const { view } = mount("Existing work.\n");
  const before = view.state.doc;
  act(() => {
    expect(insertCanvasPiece(view, before.content.size, kind)).toBe(true);
  });
  expect(view.state.doc.child(1).type.name).toBe("heading");
  expect(view.state.doc.child(1).textContent).toBe(title);
  expect(view.state.doc.child(2).textContent.length).toBeGreaterThan(10);
  expect(view.state.doc.textBetween(view.state.selection.from, view.state.selection.to)).toBe(title);
  act(() => {
    undo(view.state, view.dispatch);
  });
  expect(view.state.doc.eq(before)).toBe(true);
});
