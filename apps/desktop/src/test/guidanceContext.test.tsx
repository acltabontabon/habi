import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { history, undo } from "prosemirror-history";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { occurrencesIn } from "../views/skills/studio/compose/roles";
import {
  attachGuidanceMaterial,
  attachGuidanceSkill,
  captureGuidanceTarget,
  type GuidanceTarget,
  guidanceContextPlugin,
  selectedGuidance,
} from "../views/skills/studio/doc/guidanceContext";
import { GuidanceContext } from "../views/skills/studio/doc/InstructionSupport";
import { parseBody } from "../views/skills/studio/doc/markdown/parse";
import { write } from "../views/skills/studio/doc/markdown/reconcile";
import { listMaterialUses } from "../views/skills/studio/doc/materialUses";
import { WeaveBar } from "../views/skills/studio/doc/WeaveBar";

const views: EditorView[] = [];
afterEach(() => {
  views.splice(0).forEach((view) => {
    view.destroy();
  });
});
function open(source: string, selectedText = "") {
  const parsed = parseBody(source);
  const view = new EditorView(document.createElement("div"), {
    state: EditorState.create({ doc: parsed.doc, plugins: [history(), guidanceContextPlugin()] }),
  });
  views.push(view);
  let at = 1;
  view.state.doc.descendants((node, pos) => {
    if (node.isText && selectedText && node.text?.includes(selectedText)) at = pos + 1;
  });
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)));
  return { view, text: () => write(view.state.doc, parsed.baseline).text };
}
function targetFor(view: EditorView): GuidanceTarget {
  const target = captureGuidanceTarget(view);
  if (!target) throw new Error("No selected instruction");
  return target;
}
const source =
  "Start with context.\n\n1. Inspect the change.\n2. Review authentication.\n3. Report findings.\n\n<!-- preserve -->\n";

describe("support at an exact instruction", () => {
  it("enriches the middle procedure item with a script, without touching the other items", () => {
    const { view, text } = open(source, "Review authentication");
    const target = targetFor(view);
    expect(target.location).toBe("Procedure · step 2");
    expect(
      attachGuidanceMaterial(view, target, "scripts/check auth.py", "inspect changed authentication files"),
    ).toBe(true);
    expect(text()).toBe(
      source.replace(
        "2. Review authentication.",
        "2. Review authentication. Use [check auth.py](scripts/check%20auth.py) to inspect changed authentication files.",
      ),
    );
    expect(listMaterialUses(view.state.doc, ["scripts/check auth.py"])).toHaveLength(1);
    undo(view.state, view.dispatch);
    expect(text()).toBe(source);
  });

  it("retains the instruction across another selection and edits before it", () => {
    const { view, text } = open(source, "Review authentication");
    const target = targetFor(view);
    view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)));
    view.dispatch(view.state.tr.insertText("New context. ", 1));
    expect(
      attachGuidanceMaterial(view, target, "references/security.md", "check authentication policy"),
    ).toBe(true);
    expect(text()).toContain(
      "2. Review authentication. Consult [security.md](references/security.md) to check authentication policy.",
    );
    expect(text()).toContain("New context. Start with context.");
    expect(text()).toContain("3. Report findings.");
  });

  it("refuses to redirect an async attachment after the original instruction was deleted", () => {
    const { view, text } = open(source, "Review authentication");
    const target = targetFor(view);
    const original = target.resolve(view);
    if (!original) throw new Error("No target");
    const $at = view.state.doc.resolve(original.from);
    view.dispatch(view.state.tr.delete($at.before(), $at.after()));
    const afterDeletion = text();
    expect(attachGuidanceMaterial(view, target, "scripts/check.py", "check files")).toBe(false);
    expect(text()).toBe(afterDeletion);
  });

  it("keeps script purpose literal, without turning it into Markdown behavior", () => {
    const { view } = open("Inspect the change.\n");
    const target = targetFor(view);
    attachGuidanceMaterial(
      view,
      target,
      "scripts/check.py",
      "check [all](https://unexpected.example) and `code`",
    );
    expect(listMaterialUses(view.state.doc, ["scripts/check.py"])).toHaveLength(1);
    const links: string[] = [];
    view.state.doc.descendants((node) => {
      node.marks.forEach((mark) => {
        if (mark.type.name === "link") links.push(String(mark.attrs.href));
      });
    });
    expect(links).toEqual(["scripts/check.py"]);
    expect(view.state.doc.textContent).toContain("[all](https://unexpected.example)");
  });

  it("weaves expertise into the same procedure instruction with portable intent and provenance", () => {
    const { view, text } = open(source, "Review authentication");
    const target = targetFor(view);
    const from = { library: "https://example.com/security.git", id: "security-review" };
    expect(
      attachGuidanceSkill(view, target, { name: "security-review", from }, "authentication changes"),
    ).toBe(true);
    expect(text()).toBe(
      source.replace(
        "2. Review authentication.",
        "2. Review authentication. Consult the `security-review` skill when authentication changes.",
      ),
    );
    const occurrences = occurrencesIn(view.state.doc);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]?.role).toBe("when-relevant");
    expect(occurrences[0]?.from).toEqual(from);
    undo(view.state, view.dispatch);
    expect(text()).toBe(source);
  });

  it("selects the missing intent and releases temporary targets without changing source", () => {
    const { view, text } = open("Inspect the change.\n");
    const target = targetFor(view);
    expect(text()).toBe("Inspect the change.\n");
    attachGuidanceMaterial(view, target, "scripts/check.py");
    expect(view.state.doc.textBetween(view.state.selection.from, view.state.selection.to)).toBe("…");
    target.release(view);
    expect(target.resolve(view)).toBeNull();
    expect(text()).toBe("Inspect the change. Use [check.py](scripts/check.py) to ….\n");
  });
});

describe("selected instruction support rail", () => {
  it("tracks keyboard selection, shows existing support, and captures the clicked instruction", () => {
    const { view } = open("Inspect with [check](scripts/check.py).\n\nReview authentication.\n", "Inspect");
    const create = vi.fn();
    render(
      <GuidanceContext
        view={view}
        paths={["scripts/check.py"]}
        onCreateScript={create}
        onCreateReference={vi.fn()}
        onChooseMaterial={vi.fn()}
        onWeaveSkill={vi.fn()}
        onInspectMaterial={vi.fn()}
        onInspectSkill={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /script.*scripts\/check.py/ })).toBeInTheDocument();
    act(() => view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc))));
    expect(screen.queryByRole("button", { name: /script.*scripts\/check.py/ })).toBeNull();
    expect(screen.getByText("Review authentication.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add script" }));
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]?.[0].resolve(view)?.label).toBe("Review authentication.");
    expect(selectedGuidance(view.state)?.label).toBe("Review authentication.");
  });

  it("opens compact support from the keyboard and Escape restores toggle focus", async () => {
    const user = userEvent.setup();
    const { view } = open(source, "Review authentication");
    const { container } = render(
      <GuidanceContext
        view={view}
        paths={[]}
        onCreateScript={vi.fn()}
        onCreateReference={vi.fn()}
        onChooseMaterial={vi.fn()}
        onWeaveSkill={vi.fn()}
        onInspectMaterial={vi.fn()}
        onInspectSkill={vi.fn()}
      />,
    );
    const button = screen.getByRole("button", { name: /Support this instruction.*Procedure · step 2/ });
    expect(button).toHaveAttribute("aria-expanded", "false");
    const contentId = button.getAttribute("aria-controls");
    expect(contentId).toBeTruthy();
    expect(container.querySelector(".guidance-context-content")?.id).toBe(contentId);
    button.focus();
    await user.keyboard("{Enter}");
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(container.querySelector(".guidance-context")).toHaveClass("is-expanded");
    screen.getByRole("button", { name: "Add script" }).focus();
    await user.keyboard("{Escape}");
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(button).toHaveFocus();
    expect(container.querySelector(".guidance-context")).not.toHaveClass("is-expanded");
  });

  it("has no accessibility violations", async () => {
    const { view } = open("Inspect the change.\n");
    const { container } = render(
      <GuidanceContext
        view={view}
        paths={[]}
        onCreateScript={vi.fn()}
        onCreateReference={vi.fn()}
        onChooseMaterial={vi.fn()}
        onWeaveSkill={vi.fn()}
        onInspectMaterial={vi.fn()}
        onInspectSkill={vi.fn()}
      />,
    );
    expect(
      within(container).getByRole("complementary", { name: "Support this instruction" }),
    ).toBeInTheDocument();
    const report = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(report.violations.map((issue) => issue.id)).toEqual([]);
  });
});

it("keeps skill, script and reference weaving on the same selected step", () => {
  const { view, text } = open(source, "Review authentication");
  const onWeave = vi.fn();
  render(<WeaveBar view={view} onWeave={onWeave} />);
  expect(screen.getByText("For procedure · step 2")).toBeInTheDocument();
  fireEvent.click(screen.getByText("Give it support"));
  fireEvent.click(screen.getByRole("button", { name: /Another skill/ }));
  fireEvent.click(screen.getByText("Give it support"));
  fireEvent.click(screen.getByRole("button", { name: /A tool for the job/ }));
  fireEvent.click(screen.getByText("Give it support"));
  fireEvent.click(screen.getByRole("button", { name: /Something to read/ }));
  expect(screen.getByText("Give it support").closest("details")).not.toHaveAttribute("open");
  expect(onWeave.mock.calls.map(([kind]) => kind)).toEqual(["skill", "script", "reference"]);
  expect(selectedGuidance(view.state)?.location).toBe("Procedure · step 2");
  expect(text()).toBe(source);
});
