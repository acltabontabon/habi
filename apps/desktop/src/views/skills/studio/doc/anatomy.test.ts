import { EditorState } from "prosemirror-state";
import type { DecorationSet } from "prosemirror-view";
import { describe, expect, it } from "vitest";
import { anatomyPlugin, guidanceKind } from "./anatomy";
import { parseBody } from "./markdown/parse";
import { write } from "./markdown/reconcile";
import { schema } from "./markdown/schema";

describe("capability anatomy", () => {
  it("adds presentation without rewriting unfamiliar source or adding semantic state", () => {
    const body =
      "Review\n======\n\n<!-- keep exactly -->\n\n3. Read  the code.\n4. Check [the guide][guide].\n\n**Condition:** When authentication changes, inspect permissions.\n\n[guide]: references/guide.md 'Guide'\n";
    const parsed = parseBody(body);
    const state = EditorState.create({ doc: parsed.doc, plugins: [anatomyPlugin()] });
    expect(write(state.doc, parsed.baseline).text).toBe(body);
    expect(state.doc.toJSON()).toEqual(parsed.doc.toJSON());
  });

  it("keeps an explicit connection visible inside an ordered procedure", () => {
    const { nodes } = schema;
    const doc = nodes.doc.create(
      null,
      nodes.ordered_list.create(null, [
        nodes.list_item.create(
          null,
          nodes.paragraph.create(null, [
            schema.text("Use "),
            nodes.skill_ref.create({ name: "security-review", role: "when-relevant" }),
          ]),
        ),
        nodes.list_item.create(null, nodes.paragraph.create(null, schema.text("Summarize."))),
      ]),
    );
    const plugin = anatomyPlugin();
    const state = EditorState.create({ doc, plugins: [plugin] });
    const decorations = plugin.props.decorations?.call(plugin, state) as DecorationSet;
    expect(decorations.find()).toHaveLength(2);
  });

  it("recognizes portable guidance conventions and leaves unknown structures alone", () => {
    for (const [text, expected] of [
      ["**Condition:** When relevant, check permissions.", "Condition"],
      ["**Constraint:** Never publish a secret.", "Constraint"],
      ["**Expected result:** A concise report.", "Expected result"],
      ["Read the change.", "Instruction"],
    ]) {
      const block = parseBody(text ?? "").doc.firstChild;
      expect(block && guidanceKind(block)).toBe(expected);
    }
  });
});
