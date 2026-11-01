/** Visual anatomy derived entirely from portable instructions. No persisted UI state. */
import type { Node as PMNode } from "prosemirror-model";
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";

export function guidanceKind(node: PMNode): string | null {
  if (node.type.name === "ordered_list") return "Procedure";
  if (node.type.name === "code_block") return "Example";
  if (node.type.name === "opaque") return null;
  if (node.type.name === "heading") return "Section";
  if (node.type.name !== "paragraph" && node.type.name !== "blockquote") return null;
  const text = node.textContent.trim();
  if (/^(?:condition:|when\b|if\b|unless\b)/i.test(text)) return "Condition";
  if (/^(?:constraint:|never\b|do not\b|must not\b)/i.test(text)) return "Constraint";
  if (/^(?:expected result:|expected outcome:|return\b|deliver\b)/i.test(text)) return "Expected result";
  if (/^example:/i.test(text)) return "Example";
  return node.type.name === "paragraph" ? "Instruction" : null;
}

function anatomy(doc: PMNode): DecorationSet {
  const decorations: Decoration[] = [];
  let sectionKind: string | null = null;
  doc.forEach((node, pos) => {
    if (node.type.name === "heading") {
      const title = node.textContent.trim();
      sectionKind = /^(constraints?|rules?|limitations?)$/i.test(title)
        ? "Constraint"
        : /^(expected (results?|outcomes?)|output( format)?)$/i.test(title)
          ? "Expected result"
          : /^(examples?|demonstrations?)$/i.test(title)
            ? "Example"
            : null;
    }
    const inferred = guidanceKind(node);
    const kind = inferred === "Instruction" && sectionKind ? sectionKind : inferred;
    if (!kind || !node.content.size) return;
    decorations.push(
      Decoration.node(pos, pos + node.nodeSize, {
        class: `weave-guidance is-${kind.toLowerCase().replace(/ /g, "-")}`,
        "data-guidance": kind,
      }),
    );
  });
  // Knots inside procedures are just as meaningful as those in top-level prose.
  doc.descendants((node, pos, parent) => {
    if (node.type.name !== "paragraph" || parent === doc) return;
    let linked = false;
    node.forEach((child) => {
      if (child.type.name === "skill_ref" && child.attrs.role !== null) linked = true;
    });
    if (linked)
      decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: "weave-linked-guidance" }));
  });
  return DecorationSet.create(doc, decorations);
}

const key = new PluginKey<DecorationSet>("capability-anatomy");
export function anatomyPlugin(): Plugin {
  return new Plugin({
    key,
    state: {
      init: (_, state) => anatomy(state.doc),
      apply: (tr, old) => (tr.docChanged ? anatomy(tr.doc) : old),
    },
    props: { decorations: (state) => key.getState(state) },
  });
}
