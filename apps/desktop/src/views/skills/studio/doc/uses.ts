/**
 * A sentence that deliberately uses another skill is a piece of the skill, not a
 * line of text, so it's drawn as one: a tile with a knot, tied to the next when they
 * follow each other. Only a decoration: the words underneath are what's saved.
 */
import type { Node as PMNode } from "prosemirror-model";
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";

/** Where the first skill a block deliberately uses sits inside it, and its name. */
export function composedUseIn(block: PMNode): { offset: number; name: string } | null {
  if (block.type.name !== "paragraph") return null;
  let found: { offset: number; name: string } | null = null;
  block.forEach((child, offset) => {
    if (!found && child.type.name === "skill_ref" && child.attrs.role !== null) {
      found = { offset, name: child.attrs.name as string };
    }
  });
  return found;
}

function decorate(doc: PMNode): DecorationSet {
  const decos: Decoration[] = [];
  doc.forEach((block, pos) => {
    const use = composedUseIn(block);
    if (use) {
      decos.push(Decoration.node(pos, pos + block.nodeSize, { class: "doc-use" }));
    }
  });
  return DecorationSet.create(doc, decos);
}

const key = new PluginKey<DecorationSet>("doc-uses");

export function usesPlugin(): Plugin {
  return new Plugin({
    key,
    state: {
      init: (_c, state) => decorate(state.doc),
      apply: (tr, old) => (tr.docChanged ? decorate(tr.doc) : old),
    },
    props: {
      decorations(state) {
        return key.getState(state);
      },
    },
  });
}
