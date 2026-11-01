import { history, undo } from "prosemirror-history";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { afterEach, expect, it, vi } from "vitest";
import { canvasConnectionsPlugin, canvasThreads } from "../views/skills/studio/doc/canvasConnections";
import {
  attachGuidanceSkill,
  captureGuidanceTarget,
  guidanceContextPlugin,
} from "../views/skills/studio/doc/guidanceContext";
import { parseBody } from "../views/skills/studio/doc/markdown/parse";
import { write } from "../views/skills/studio/doc/markdown/reconcile";

const views: EditorView[] = [];
afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
});
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, bottom: 0, right: 0 }) as DOMRect;
const source =
  "1. Gather context.\n2. Review. Use [check.py](scripts/check.py) to inspect changed paths. Consult [policy](references/policy.md) to check requirements.\n3. Verify. Use [check.py](scripts/check.py) to verify the result.\n";
const paths = ["scripts/check.py", "references/policy.md"];
it("shows each actual use under its own step, with type and purpose", () => {
  const { doc } = parseBody(source);
  const threads = canvasThreads(doc, paths);
  expect(threads.map((thread) => thread.location)).toEqual(["step 2", "step 3"]);
  expect(threads[0]?.connections.map((c) => [c.kind, c.purpose])).toEqual([
    ["script", "to inspect changed paths"],
    ["reference", "to check requirements"],
  ]);
  expect(threads[1]?.connections[0]?.purpose).toBe("to verify the result");
  expect(canvasThreads(doc, [])[0]?.connections.every((c) => c.missing)).toBe(true);
});
it("keeps the visual threads out of saved source and opens the exact connected use", () => {
  const parsed = parseBody(source);
  const open = vi.fn();
  const view = new EditorView(document.createElement("div"), {
    state: EditorState.create({
      doc: parsed.doc,
      plugins: [
        canvasConnectionsPlugin(
          () => paths,
          () => ({}),
          open,
        ),
      ],
    }),
  });
  views.push(view);
  expect(view.dom.querySelectorAll(".canvas-threads")).toHaveLength(0);
  expect(view.dom.querySelectorAll(".canvas-inline-connection")).toHaveLength(3);
  const cards = view.dom.querySelectorAll<HTMLButtonElement>(".canvas-connection-menu button:first-child");
  expect(cards).toHaveLength(3);
  const toggle = view.dom.querySelectorAll<HTMLButtonElement>(".canvas-connection-toggle")[2];
  toggle?.click();
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  cards[2]?.click();
  expect(open).toHaveBeenCalledWith("scripts/check.py");
  expect(view.state.selection.$from.parent.textContent).toContain("Verify.");
  expect(write(view.state.doc, parsed.baseline).text).toBe(source);
});
it("adds expertise to the same thread and removes its visual connection on undo", () => {
  const parsed = parseBody(source);
  const view = new EditorView(document.createElement("div"), {
    state: EditorState.create({
      doc: parsed.doc,
      plugins: [
        history(),
        guidanceContextPlugin(),
        canvasConnectionsPlugin(
          () => paths,
          () => ({ skillLook: () => ({ title: "Security Review", status: "found", explicit: true }) }),
          () => {},
        ),
      ],
    }),
  });
  views.push(view);
  const thread = canvasThreads(view.state.doc, paths)[0];
  if (!thread) throw new Error("Missing step");
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, thread.from + 1)));
  const target = captureGuidanceTarget(view);
  if (!target) throw new Error("Missing target");
  attachGuidanceSkill(view, target, { name: "security-review" }, "authentication changes");
  const connections = canvasThreads(view.state.doc, paths)[0]?.connections;
  expect(connections?.map((c) => c.kind)).toEqual(["script", "reference", "skill"]);
  expect(connections?.[2]?.purpose).toBe("when authentication changes");
  expect(view.dom.querySelectorAll(".canvas-connection-menu button:first-child")).toHaveLength(4);
  undo(view.state, view.dispatch);
  expect(view.dom.querySelectorAll(".canvas-connection-menu button:first-child")).toHaveLength(3);
  expect(write(view.state.doc, parsed.baseline).text).toBe(source);
});
