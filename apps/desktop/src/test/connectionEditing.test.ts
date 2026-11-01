import { history, undo } from "prosemirror-history";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { afterEach, expect, it } from "vitest";
import { canvasThreads } from "../views/skills/studio/doc/canvasConnections";
import {
  connectToInstruction,
  disconnectConnection,
  instructionTargets,
  moveConnection,
} from "../views/skills/studio/doc/connectionEditing";
import { guidanceContextPlugin } from "../views/skills/studio/doc/guidanceContext";
import { parseBody } from "../views/skills/studio/doc/markdown/parse";
import { write } from "../views/skills/studio/doc/markdown/reconcile";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing test fixture value");
  return value;
}
const views: EditorView[] = [];
afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
});
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, bottom: 0, right: 0 }) as DOMRect;
const paths = ["scripts/check.py", "references/policy.md"];
const source =
  "1. Gather.\n2. Review. Use [check.py](scripts/check.py) to inspect changes. Consult [policy](references/policy.md) to check requirements.\n3. Verify.\n\n<!-- keep -->\n";
function open(text = source) {
  const parsed = parseBody(text);
  const view = new EditorView(document.createElement("div"), {
    state: EditorState.create({ doc: parsed.doc, plugins: [history(), guidanceContextPlugin()] }),
  });
  views.push(view);
  return { view, text: () => write(view.state.doc, parsed.baseline).text };
}
it.each([0, 2])("moves only a material and its purpose to step index %s in one undo", (index) => {
  const { view, text } = open();
  const connection = canvasThreads(view.state.doc, paths)[0]?.connections[0];
  if (!connection) throw new Error("Missing connection");
  expect(moveConnection(view, connection, required(instructionTargets(view.state.doc)[index]).from)).toBe(
    true,
  );
  const threads = canvasThreads(view.state.doc, paths);
  expect(threads.find((t) => t.location === `step ${index + 1}`)?.connections[0]?.path).toBe(
    "scripts/check.py",
  );
  expect(threads.find((t) => t.location === "step 2")?.connections[0]?.path).toBe("references/policy.md");
  expect(text()).toContain("2. Review. Consult [policy]");
  expect(text()).toContain("<!-- keep -->");
  undo(view.state, view.dispatch);
  expect(text()).toBe(source);
});
it("disconnects only one use and restores its sentence with undo", () => {
  const { view, text } = open();
  const connection = required(required(canvasThreads(view.state.doc, paths)[0]).connections[1]);
  expect(disconnectConnection(view, connection)).toBe(true);
  expect(text()).toBe(source.replace(" Consult [policy](references/policy.md) to check requirements.", ""));
  undo(view.state, view.dispatch);
  expect(text()).toBe(source);
});
it("connects a skill to a step, moves its metadata and purpose, then disconnects it", () => {
  const { view, text } = open();
  const step2 = required(instructionTargets(view.state.doc)[1]).from;
  expect(connectToInstruction(view, step2, { skill: { name: "security-review" } })).toBe(true);
  const attached = text();
  const connection = required(
    required(canvasThreads(view.state.doc, paths)[0]).connections.find((c) => c.skill),
  );
  expect(moveConnection(view, connection, required(instructionTargets(view.state.doc)[2]).from)).toBe(true);
  const moved = required(
    required(canvasThreads(view.state.doc, paths).find((t) => t.location === "step 3")).connections[0],
  );
  expect(view.state.doc.nodeAt(moved.pos)?.attrs.role).toBe("when-relevant");
  undo(view.state, view.dispatch);
  expect(text()).toBe(attached);
  const current = required(
    required(canvasThreads(view.state.doc, paths)[0]).connections.find((c) => c.skill),
  );
  expect(disconnectConnection(view, current)).toBe(true);
  expect(
    canvasThreads(view.state.doc, paths)
      .flatMap((t) => t.connections)
      .some((c) => c.skill),
  ).toBe(false);
});
it("preserves hand-written prose when moving an inline reference", () => {
  const { view, text } = open("Read [policy](references/policy.md) carefully.\n\nReview the result.\n");
  const connection = required(required(canvasThreads(view.state.doc, paths)[0]).connections[0]);
  expect(moveConnection(view, connection, required(instructionTargets(view.state.doc)[1]).from)).toBe(true);
  expect(text()).toContain("Read policy carefully.");
  expect(text()).toContain("Review the result. [policy](references/policy.md)");
});
it("rejects read-only, stale and same-step moves without changing source", () => {
  const { view, text } = open();
  const connection = required(required(canvasThreads(view.state.doc, paths)[0]).connections[0]);
  expect(moveConnection(view, connection, required(instructionTargets(view.state.doc)[1]).from)).toBe(false);
  expect(disconnectConnection(view, { ...connection, pos: 0 })).toBe(false);
  view.setProps({ editable: () => false });
  expect(disconnectConnection(view, connection)).toBe(false);
  expect(moveConnection(view, connection, 0)).toBe(false);
  expect(text()).toBe(source);
});

it.each(paths)("attaches %s to the exact step and disconnects without changing the other steps", (path) => {
  const initial = "1. Gather.\n2. Review.\n3. Verify.\n";
  const { view, text } = open(initial);
  expect(connectToInstruction(view, required(instructionTargets(view.state.doc)[1]).from, { path })).toBe(
    true,
  );
  const thread = required(canvasThreads(view.state.doc, paths)[0]);
  expect(thread.location).toBe("step 2");
  expect(required(thread.connections[0]).path).toBe(path);
  expect(text()).toContain("1. Gather.");
  expect(text()).toContain("3. Verify.");
  expect(disconnectConnection(view, required(thread.connections[0]))).toBe(true);
  expect(text()).toBe(initial);
});

it("keeps the shelf condition when dropping expertise onto a different step", () => {
  const { view } = open();
  expect(
    connectToInstruction(view, required(instructionTargets(view.state.doc)[2]).from, {
      skill: { name: "security-review" },
      condition: "permissions change",
    }),
  ).toBe(true);
  const thread = required(canvasThreads(view.state.doc, paths).find((t) => t.location === "step 3"));
  expect(required(thread.connections[0]).purpose).toBe("when permissions change");
});
