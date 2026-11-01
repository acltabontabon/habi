import { act, fireEvent, render, screen } from "@testing-library/react";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { expect, it, vi } from "vitest";
import { guidanceContextPlugin } from "../views/skills/studio/doc/guidanceContext";
import { parseBody } from "../views/skills/studio/doc/markdown/parse";
import { StudioPalette } from "../views/skills/studio/doc/StudioPalette";

it("follows canvas context, preserves it in the palette, and returns to steps on empty canvas", () => {
  const stage = document.body.appendChild(document.createElement("div"));
  stage.className = "sk-stage";
  const host = stage.appendChild(document.createElement("div"));
  const view = new EditorView(host, {
    state: EditorState.create({
      doc: parseBody("Read the notes.\n").doc,
      plugins: [guidanceContextPlugin(false)],
    }),
  });
  const { unmount } = render(
    <StudioPalette
      view={view}
      steps={<button type="button">Add a choice</button>}
      support={<button type="button">Connect a skill</button>}
    />,
  );
  expect(screen.getByRole("button", { name: "Add a choice" })).toBeVisible();
  act(() => view.focus());
  expect(screen.getByRole("button", { name: "Connect a skill" })).toBeVisible();
  fireEvent.pointerDown(screen.getByRole("button", { name: "Connect a skill" }));
  expect(screen.getByRole("button", { name: "Support" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getByRole("button", { name: "Collapse palette" }));
  fireEvent.click(screen.getByRole("button", { name: "Expand palette" }));
  expect(screen.getByRole("button", { name: "Connect a skill" })).toBeVisible();
  fireEvent.pointerDown(stage);
  expect(screen.getByRole("button", { name: "Add a choice" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Support" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Edit words" })).not.toBeInTheDocument();
  unmount();
  view.destroy();
  stage.remove();
});

it("shows Steps on an empty paragraph even with other instructions on the canvas", () => {
  const host = document.body.appendChild(document.createElement("div"));
  const doc = parseBody("Read the notes.\n").doc;
  const blank = doc.type.schema.nodes.paragraph!.create();
  const view = new EditorView(host, {
    state: EditorState.create({
      doc: doc.type.create(null, [doc.firstChild!, blank]),
      plugins: [guidanceContextPlugin(false)],
    }),
  });
  const { unmount } = render(
    <StudioPalette view={view} steps={<span>Add steps</span>} support={<span>Add support</span>} />,
  );
  act(() => view.focus());
  expect(screen.getByRole("button", { name: "Support" })).toHaveAttribute("aria-pressed", "true");
  act(() =>
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, doc.firstChild!.nodeSize + 1)),
    ),
  );
  expect(screen.getByRole("button", { name: "Steps" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.queryByText("Add support")).not.toBeInTheDocument();
  unmount();
  view.destroy();
  host.remove();
});

it("captures support targets in an editor that survived a module reload", async () => {
  const host = document.body.appendChild(document.createElement("div"));
  const view = new EditorView(host, {
    state: EditorState.create({
      doc: parseBody("Read the notes.\n").doc,
      plugins: [guidanceContextPlugin(false)],
    }),
  });
  vi.resetModules();
  const { captureGuidanceTarget } = await import("../views/skills/studio/doc/guidanceContext");
  const target = captureGuidanceTarget(view);
  expect(target?.resolve(view)?.label).toBe("Read the notes.");
  target?.release(view);
  expect(target?.resolve(view)).toBeNull();
  view.destroy();
  host.remove();
});
