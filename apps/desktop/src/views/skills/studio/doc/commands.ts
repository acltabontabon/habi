/** What the author can do to a document, whichever way they asked: key, menu, toolbar or drag. */
import { chainCommands, joinBackward, lift, setBlockType, toggleMark, wrapIn } from "prosemirror-commands";
import type { MarkType, NodeType, Node as PMNode, ResolvedPos } from "prosemirror-model";
import { Fragment, Slice } from "prosemirror-model";
import { liftListItem, sinkListItem, wrapInList } from "prosemirror-schema-list";
import {
  type Command,
  type EditorState,
  NodeSelection,
  TextSelection,
  type Transaction,
} from "prosemirror-state";
import { addColumnAfter, addRowAfter, deleteColumn, deleteRow } from "prosemirror-tables";
import { parseBody } from "./markdown/parse";
import { schema } from "./markdown/schema";

const { nodes, marks } = schema;

export function markActive(state: EditorState, type: MarkType): boolean {
  const { from, $from, to, empty } = state.selection;
  if (empty) return Boolean(type.isInSet(state.storedMarks ?? $from.marks()));
  return state.doc.rangeHasMark(from, to, type);
}

/** The block the caret is in, at the deepest level that can move on its own. */
function movableAt($pos: ResolvedPos): { depth: number; node: PMNode } | null {
  for (let d = $pos.depth; d > 0; d--) {
    const node = $pos.node(d);
    const parent = $pos.node(d - 1);
    if (node.type === nodes.list_item) return { depth: d, node };
    if (parent.type === nodes.doc) return { depth: d, node };
  }
  return null;
}

/** Moves the block with the caret one place up or down: the keyboard's way to drag. */
export function moveBlock(direction: -1 | 1): Command {
  return (state, dispatch) => {
    const sel = state.selection;
    const $from = sel.$from;
    let depth: number;
    let node: PMNode;
    if (sel instanceof NodeSelection && sel.node.isBlock) {
      depth = $from.depth + 1;
      node = sel.node;
    } else {
      const found = movableAt($from);
      if (!found) return false;
      depth = found.depth;
      node = found.node;
    }
    const parentDepth = depth - 1;
    const parent = $from.node(parentDepth);
    const index = sel instanceof NodeSelection ? $from.index(parentDepth) : $from.index(parentDepth);
    const target = index + direction;
    if (target < 0 || target >= parent.childCount) return false;
    if (dispatch) {
      const start = sel instanceof NodeSelection ? sel.from : $from.before(depth);
      const end = start + node.nodeSize;
      const other = parent.child(target);
      const tr = state.tr;
      const offset = sel.from - start;
      if (direction === -1) {
        const to = start - other.nodeSize;
        tr.delete(start, end).insert(to, node);
        place(tr, sel instanceof NodeSelection, to, offset);
      } else {
        const to = start + other.nodeSize;
        tr.delete(start, end).insert(to, node);
        place(tr, sel instanceof NodeSelection, to, offset);
      }
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

function place(tr: Transaction, asNode: boolean, at: number, offset: number) {
  if (asNode) tr.setSelection(NodeSelection.create(tr.doc, at));
  else tr.setSelection(TextSelection.near(tr.doc.resolve(at + offset)));
}

/** Turns the blocks in the selection into a heading of `level`, or back to a paragraph. */
export function setHeading(level: number): Command {
  return (state, dispatch) => {
    const { $from } = state.selection;
    const current = $from.parent;
    if (current.type === nodes.heading && current.attrs.level === level) {
      return setBlockType(nodes.paragraph)(state, dispatch);
    }
    return setBlockType(nodes.heading, { level })(state, dispatch);
  };
}

export const setParagraph: Command = (state, dispatch) => setBlockType(nodes.paragraph)(state, dispatch);

function inside(state: EditorState, type: NodeType): number | null {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) if ($from.node(d).type === type) return d;
  return null;
}

/** A list on or off, or changed to the other kind. */
export function toggleList(type: NodeType): Command {
  return (state, dispatch) => {
    const other = type === nodes.bullet_list ? nodes.ordered_list : nodes.bullet_list;
    const here = inside(state, type);
    if (here !== null) return liftListItem(nodes.list_item)(state, dispatch);
    const there = inside(state, other);
    if (there !== null) {
      if (dispatch) {
        const start = state.selection.$from.before(there);
        dispatch(state.tr.setNodeMarkup(start, type));
      }
      return true;
    }
    return wrapInList(type)(state, dispatch);
  };
}

export const toggleQuote: Command = (state, dispatch) =>
  inside(state, nodes.blockquote) !== null
    ? lift(state, dispatch)
    : wrapIn(nodes.blockquote)(state, dispatch);

export function setCallout(kind: string): Command {
  return (state, dispatch) => {
    const d = inside(state, nodes.blockquote);
    if (d !== null) {
      if (dispatch)
        dispatch(state.tr.setNodeMarkup(state.selection.$from.before(d), null, { callout: kind }));
      return true;
    }
    return wrapIn(nodes.blockquote, { callout: kind })(state, dispatch);
  };
}

export const setCodeBlock: Command = (state, dispatch) => setBlockType(nodes.code_block)(state, dispatch);

/** Replaces the current empty block, or adds after it, and puts the caret inside. */
export function insertBlock(node: PMNode): Command {
  return (state, dispatch) => {
    const { $from } = state.selection;
    if (dispatch) {
      const tr = state.tr;
      const empty = $from.depth >= 1 && $from.parent.isTextblock && $from.parent.content.size === 0;
      if (empty && $from.depth === 1) tr.replaceRangeWith($from.before(1), $from.after(1), node);
      else tr.insert($from.after(1), node);
      const at = tr.mapping.map($from.before(1)) + (empty ? 1 : $from.node(1).nodeSize + 1);
      tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(at, tr.doc.content.size))));
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

export function insertTable(rows = 3, cols = 3): Command {
  const cell = (header: boolean) => (header ? nodes.table_header : nodes.table_cell).create();
  const row = (header: boolean) =>
    nodes.table_row.create(
      null,
      Array.from({ length: cols }, () => cell(header)),
    );
  return insertBlock(
    nodes.table.create(null, [row(true), ...Array.from({ length: rows - 1 }, () => row(false))]),
  );
}

export const insertRule: Command = (state, dispatch) => {
  if (!dispatch) return true;
  const { $from } = state.selection;
  const empty = $from.depth === 1 && $from.parent.content.size === 0;
  const rule = nodes.horizontal_rule.create();
  const tr = state.tr;
  if (empty) tr.replaceRangeWith($from.before(1), $from.after(1), rule);
  else tr.insert($from.after(1), rule);
  const end = tr.mapping.map($from.after(1));
  if (end >= tr.doc.content.size || !tr.doc.resolve(end).nodeAfter?.isTextblock) {
    tr.insert(end, nodes.paragraph.create());
  }
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(end + 1, tr.doc.content.size))));
  dispatch(tr.scrollIntoView());
  return true;
};

export const tableCommands = { addRowAfter, addColumnAfter, deleteRow, deleteColumn };

/** Enter in a code block is a new line; twice at the end leaves it. */
export const codeEnter: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!$from.parent.type.spec.code || !empty) return false;
  const text = $from.parent.textContent;
  const atEnd = $from.parentOffset === $from.parent.content.size;
  if (atEnd && text.endsWith("\n\n")) {
    if (dispatch) {
      const tr = state.tr.delete($from.pos - 2, $from.pos);
      const after = tr.mapping.map($from.after());
      tr.insert(after, nodes.paragraph.create());
      tr.setSelection(TextSelection.near(tr.doc.resolve(after + 1)));
      dispatch(tr.scrollIntoView());
    }
    return true;
  }
  if (dispatch) dispatch(state.tr.insertText("\n").scrollIntoView());
  return true;
};

export const codeTab: Command = (state, dispatch) => {
  if (!state.selection.$from.parent.type.spec.code) return false;
  if (dispatch) dispatch(state.tr.insertText("  ").scrollIntoView());
  return true;
};

/** Backspace at the very start of a heading, quote or code block turns it back into text. */
export const backspaceToParagraph: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.parentOffset !== 0) return false;
  const parent = $from.parent;
  if (parent.type === nodes.heading || (parent.type === nodes.code_block && parent.content.size === 0)) {
    return setBlockType(nodes.paragraph)(state, dispatch);
  }
  return false;
};

export const indent = sinkListItem(nodes.list_item);
export const outdent = liftListItem(nodes.list_item);

export const toggleBold = toggleMark(marks.strong);
export const toggleItalic = toggleMark(marks.em);
export const toggleCode = toggleMark(marks.code);
export const toggleStrike = toggleMark(marks.strike);

export function setLink(href: string | null): Command {
  return (state, dispatch) => {
    const { from, to, empty } = state.selection;
    if (dispatch) {
      const tr = state.tr;
      if (empty) {
        const $at = state.selection.$from;
        const here = $at.marks().find((m) => m.type === marks.link);
        if (!here) return false;
        // The whole link around the caret.
        let start = $at.pos;
        let end = $at.pos;
        while (start > $at.start() && state.doc.rangeHasMark(start - 1, start, marks.link)) start--;
        while (end < $at.end() && state.doc.rangeHasMark(end, end + 1, marks.link)) end++;
        tr.removeMark(start, end, marks.link);
        if (href) tr.addMark(start, end, marks.link.create({ href }));
      } else {
        tr.removeMark(from, to, marks.link);
        if (href) tr.addMark(from, to, marks.link.create({ href }));
      }
      dispatch(tr);
    }
    return true;
  };
}

export const joinOrBackspace = chainCommands(backspaceToParagraph, joinBackward);

/** Markdown as content to insert: a slice that pastes into the line when it's only one paragraph. */
export function sliceFromMarkdown(markdown: string): Slice {
  const { doc } = parseBody(markdown);
  const single = doc.childCount === 1 && doc.firstChild?.type === nodes.paragraph;
  if (single) return new Slice(Fragment.from(doc.firstChild), 1, 1);
  return new Slice(doc.content, 0, 0);
}

/** Inserts a skill mention at the caret, with any role it carries. */
export function insertSkillRef(name: string, role: string | null, plugin: string | null = null): Command {
  return (state, dispatch) => {
    if (dispatch) {
      const node = nodes.skill_ref.create({ name, plugin, role });
      dispatch(state.tr.replaceSelectionWith(node, false).scrollIntoView());
    }
    return true;
  };
}

/** Ticks or unticks the list item at a position. */
export function toggleTask(pos: number): Command {
  return (state, dispatch) => {
    const item = state.doc.nodeAt(pos);
    if (item?.type !== nodes.list_item || item.attrs.checked === null) return false;
    if (dispatch) dispatch(state.tr.setNodeAttribute(pos, "checked", !item.attrs.checked));
    return true;
  };
}

/** A checklist at the caret. */
export const insertChecklist: Command = (state, dispatch) => {
  const para = nodes.paragraph.create();
  const list = nodes.bullet_list.create(null, nodes.list_item.create({ checked: false }, para));
  return insertBlock(list)(state, dispatch);
};
