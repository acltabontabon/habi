/** Where dragged things end up. Each is one undoable edit, and a move keeps the author's bytes. */
import { Fragment, type Node as PMNode } from "prosemirror-model";
import { TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { schema } from "./markdown/schema";

const { nodes } = schema;

/** A heading and everything under it, up to the next heading of its rank or higher. */
export function sectionRange(doc: PMNode, headingPos: number): { from: number; to: number } | null {
  const heading = doc.nodeAt(headingPos);
  if (heading?.type !== nodes.heading) return null;
  const level = heading.attrs.level as number;
  let to = doc.content.size;
  let past = false;
  doc.forEach((node, pos) => {
    if (past) {
      if (node.type === nodes.heading && (node.attrs.level as number) <= level && to === doc.content.size)
        to = pos;
    } else if (pos === headingPos) past = true;
  });
  return { from: headingPos, to };
}

/** The top-level block holding a position. */
export function topBlockAt(doc: PMNode, pos: number): { from: number; to: number } | null {
  const $pos = doc.resolve(pos);
  if ($pos.depth === 0) return null;
  return { from: $pos.before(1), to: $pos.after(1) };
}

/** Moves a stretch of top-level blocks to a place between blocks. */
export function moveBlocks(view: EditorView, from: number, to: number, at: number): number | null {
  if (at >= from && at <= to) return null;
  const content = view.state.doc.slice(from, to).content;
  const tr = view.state.tr.delete(from, to);
  const place = tr.mapping.map(at);
  tr.insert(place, content);
  if (tr.doc.childCount === 0) tr.insert(0, nodes.paragraph.create());
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(place + 1, tr.doc.content.size))));
  view.dispatch(tr);
  return place;
}

/** Moves a list item, into any list. */
export function moveItem(view: EditorView, from: number, to: number, at: number): number | null {
  if (at >= from && at <= to) return null;
  const item = view.state.doc.nodeAt(from);
  if (!item) return null;
  const $from = view.state.doc.resolve(from);
  const tr = view.state.tr;
  const list = $from.parent;
  // An only item takes its list with it, rather than leaving an empty one.
  if (list.childCount === 1) tr.delete($from.before(), $from.after());
  else tr.delete(from, to);
  const place = tr.mapping.map(at);
  tr.insert(place, item);
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(place + 2, tr.doc.content.size))));
  view.dispatch(tr);
  return place;
}

/** New content between blocks, with the caret in it. An empty line at the spot is replaced. */
export function placeBlocks(view: EditorView, at: number, content: PMNode[]): number {
  const tr = view.state.tr;
  const after = tr.doc.nodeAt(at);
  const before = at > 0 ? tr.doc.resolve(at).nodeBefore : null;
  const docEmpty = tr.doc.childCount === 1 && tr.doc.firstChild?.content.size === 0;
  let place = at;
  if (docEmpty) {
    tr.replaceWith(0, tr.doc.content.size, content);
    place = 0;
  } else if (after?.type === nodes.paragraph && after.content.size === 0) {
    tr.replaceWith(at, at + after.nodeSize, content);
  } else if (before?.type === nodes.paragraph && before.content.size === 0) {
    place = at - before.nodeSize;
    tr.replaceWith(place, at, content);
  } else {
    tr.insert(at, Fragment.fromArray(content));
  }
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(place + 1, tr.doc.content.size))));
  view.dispatch(tr.scrollIntoView());
  view.focus();
  return place;
}
