import { EditorState, TextSelection } from "prosemirror-state";
import type { DecorationSet } from "prosemirror-view";
import { describe, expect, it } from "vitest";
import { fileRefsPlugin } from "./fileRefs";
import { schema } from "./markdown/schema";
import { composedUseIn, usesPlugin } from "./uses";

const { nodes, marks } = schema;
const chip = (role: string | null) => nodes.skill_ref.create({ name: "security-review", role });
const para = (...inline: Parameters<typeof nodes.paragraph.create>[1][]) =>
  nodes.paragraph.create(null, inline.flat() as never);

function classesOf(state: EditorState, plugin: { props: { decorations?: unknown } }): string[] {
  const set = (plugin.props.decorations as (s: EditorState) => DecorationSet).call(plugin, state);
  return set.find().map((d) => (d as unknown as { type: { attrs: { class: string } } }).type.attrs.class);
}

describe("a sentence that uses a skill", () => {
  it("is a tile only when the skill is deliberately part of this one", () => {
    const doc = nodes.doc.create(null, [
      para(schema.text("Use the "), chip("when-relevant")),
      para(schema.text("Mentions "), chip(null)),
      para(schema.text("Plain words.")),
    ]);
    const plugin = usesPlugin();
    expect(classesOf(EditorState.create({ doc, plugins: [plugin] }), plugin)).toEqual(["doc-use"]);
  });

  it("finds the skill to pick up, past the words before it", () => {
    const block = para(schema.text("Use "), chip("after"));
    expect(composedUseIn(block)).toEqual({ offset: 4, name: "security-review" });
    expect(composedUseIn(para(schema.text("Use "), chip(null)))).toBeNull();
  });
});

describe("a file named in the words", () => {
  const code = schema.text("scripts/run.sh", [marks.code.create()]);
  const doc = nodes.doc.create(null, [para(schema.text("Run "), code), para(schema.text("Then stop."))]);
  const plugin = fileRefsPlugin(() => ["scripts/run.sh"]);

  it("reads as its name, with the folder out of sight", () => {
    const state = EditorState.create({
      doc,
      plugins: [plugin],
      selection: TextSelection.create(doc, doc.content.size - 1),
    });
    expect(classesOf(state, plugin)).toEqual(["doc-file-dir", "doc-file"]);
  });

  it("shows its folder again while the caret is in it, to edit", () => {
    const away = EditorState.create({
      doc,
      plugins: [plugin],
      selection: TextSelection.create(doc, doc.content.size - 1),
    });
    const inside = away.apply(away.tr.setSelection(TextSelection.create(doc, 8)));
    expect(classesOf(inside, plugin)).toEqual(["doc-file"]);
  });
});
