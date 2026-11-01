import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { afterEach, expect, it, vi } from "vitest";
import { armDrag, ghostLabel } from "../views/skills/studio/doc/drag";
import { parseBody } from "../views/skills/studio/doc/markdown/parse";

let view: EditorView | undefined;
afterEach(() => {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  view?.destroy();
  document.body.replaceChildren();
  vi.useRealTimers();
});
function pointer(type: string, x: number, y: number) {
  return new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true }) as PointerEvent;
}
function start(instructionsOnly = false) {
  view?.destroy();
  vi.useFakeTimers();
  const parent = document.createElement("div");
  document.body.append(parent);
  view = new EditorView(parent, { state: EditorState.create({ doc: parseBody("First.\n\nSecond.\n").doc }) });
  view.dom.className = "doc-page";
  vi.spyOn(view.dom, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 100, 400, 250));
  for (const [index, el] of [...view.dom.children].entries()) {
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 150 + index * 100, 400, 30));
  }
  const onLand = vi.fn();
  const editor = view;
  armDrag(pointer("pointerdown", 600, 200), () => ({
    view: editor,
    ghost: ghostLabel("A contribution"),
    instructions: true,
    instructionsOnly,
    onLand,
  }));
  window.dispatchEvent(pointer("pointermove", 550, 200));
  vi.advanceTimersByTime(20);
  return onLand;
}
it("keeps steps stationary while crossing a gap, then lands on the exact paragraph", () => {
  const onLand = start();
  window.dispatchEvent(pointer("pointermove", 300, 210));
  vi.advanceTimersByTime(20);
  expect(
    [...document.head.querySelectorAll("style")].some((s) =>
      s.textContent?.includes("transform: translateY"),
    ),
  ).toBe(false);
  window.dispatchEvent(pointer("pointerup", 300, 260));
  expect(onLand).toHaveBeenCalledWith(expect.objectContaining({ type: "instruction", pos: 8 }));
  expect(document.querySelector(".doc-step-target")).toBeNull();
});
it("cancels a shelf drop outside the canvas", () => {
  const onLand = start();
  window.dispatchEvent(pointer("pointerup", 600, 260));
  expect(onLand).not.toHaveBeenCalled();
});
it("cancels an existing connection dropped in a gap or with Escape", () => {
  const onLand = start(true);
  window.dispatchEvent(pointer("pointerup", 300, 210));
  expect(onLand).not.toHaveBeenCalled();
  const escaped = start(true);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  window.dispatchEvent(pointer("pointerup", 300, 260));
  expect(escaped).not.toHaveBeenCalled();
  expect(document.querySelector(".doc-ghost")).toBeNull();
});
