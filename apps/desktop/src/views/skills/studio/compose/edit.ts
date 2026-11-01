/** What composing does to the document. Every one is an ordinary, undoable edit to the author's draft and nothing else. */
import { Fragment, type Node as PMNode } from "prosemirror-model";
import { NodeSelection, TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { canonOf } from "../doc/markdown/canon";
import { parseBody } from "../doc/markdown/parse";
import { schema } from "../doc/markdown/schema";
import {
  type ComposeSource,
  matchTemplate,
  mentionOf,
  occurrencesIn,
  type RoleId,
  sentenceFor,
  USED_HERE,
} from "./roles";

const { nodes } = schema;

export type Pick = { name: string; from?: ComposeSource | null };

const fromAttr = (from?: ComposeSource | null) => (from ? JSON.stringify(from) : null);

/** The sentence for a role, as a paragraph whose mention carries that role. */
function sentenceParagraph(role: RoleId, pick: Pick, blank: string | null = null): PMNode {
  const { doc } = parseBody(sentenceFor(role, mentionOf(pick.name), blank));
  const para = doc.firstChild ?? nodes.paragraph.create();
  const kids: PMNode[] = [];
  para.forEach((child) => {
    kids.push(
      child.type === nodes.skill_ref
        ? nodes.skill_ref.create({ ...child.attrs, role, from: fromAttr(pick.from) })
        : child,
    );
  });
  return nodes.paragraph.create(null, kids);
}

/** Selects the `…` a new sentence left for the author, so typing fills it in. */
function selectBlank(view: EditorView, blockPos: number) {
  const block = view.state.doc.nodeAt(blockPos);
  if (!block) return;
  let found: { from: number; to: number } | null = null;
  block.descendants((node, pos) => {
    if (!found && node.isText) {
      const at = (node.text ?? "").indexOf("…");
      if (at >= 0) found = { from: blockPos + 1 + pos + at, to: blockPos + 1 + pos + at + 1 };
    }
    return !found;
  });
  const tr = view.state.tr;
  if (found) {
    const { from, to } = found as { from: number; to: number };
    tr.setSelection(TextSelection.create(tr.doc, from, to));
  } else {
    tr.setSelection(TextSelection.near(tr.doc.resolve(blockPos + block.nodeSize - 1), -1));
  }
  view.dispatch(tr.scrollIntoView());
}

/**
 * Whether a skill belongs in the sentence at the caret. Asked for from inside a
 * sentence (a slash, selected words), yes. From the shelf, only with the caret
 * in the middle of the words; at the end of a block the next thing is a new sentence.
 */
function inSentence(view: EditorView, inline: boolean): boolean {
  const { $from, empty } = view.state.selection;
  if (!$from.parent.isTextblock || $from.parent.type.spec.code || $from.parent.content.size === 0)
    return false;
  if (inline) return true;
  return empty && $from.parentOffset > 0 && $from.parentOffset < $from.parent.content.size;
}

/**
 * A skill at the caret. In a sentence it joins the sentence; on an empty line it
 * brings a sentence of its own, with the part only the author can say selected.
 * Returns where the mention landed.
 */
export function insertSkill(
  view: EditorView,
  pick: Pick,
  { role = "when-relevant", inline = false }: { role?: RoleId; inline?: boolean } = {},
): number | null {
  if (inSentence(view, inline)) {
    const { from, to } = view.state.selection;
    const node = nodes.skill_ref.create({ name: pick.name, role: USED_HERE, from: fromAttr(pick.from) });
    const tr = view.state.tr.replaceRangeWith(from, to, node);
    tr.setSelection(TextSelection.near(tr.doc.resolve(from + node.nodeSize)));
    view.dispatch(tr.scrollIntoView());
    return from;
  }
  const { $from } = view.state.selection;
  const para = sentenceParagraph(role, pick);
  const tr = view.state.tr;
  let blockPos: number;
  if ($from.parent.isTextblock && $from.parent.content.size === 0 && !$from.parent.type.spec.code) {
    blockPos = $from.before();
    tr.replaceWith(blockPos, $from.after(), para);
  } else {
    blockPos = $from.depth > 0 ? $from.after(1) : tr.doc.content.size;
    tr.insert(blockPos, para);
  }
  view.dispatch(tr);
  selectBlank(view, blockPos);
  return firstMention(view.state.doc, blockPos, pick.name);
}

function firstMention(doc: PMNode, blockPos: number, name: string): number | null {
  const hit = occurrencesIn(doc).find((o) => o.blockPos === blockPos && o.name === name);
  return hit?.pos ?? null;
}

/** A skill put down inside a sentence: it joins the words there. */
export function dropSkillInText(view: EditorView, pick: Pick, pos: number): number | null {
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
  return insertSkill(view, pick, { inline: true });
}

/** A skill put down between blocks: it brings its own sentence, with the blank selected. */
export function dropSkillBetween(
  view: EditorView,
  pick: Pick,
  at: number,
  role: RoleId = "when-relevant",
): number | null {
  const para = sentenceParagraph(role, pick);
  view.dispatch(view.state.tr.insert(at, para));
  selectBlank(view, at);
  view.focus();
  return firstMention(view.state.doc, at, pick.name);
}

function chipAt(view: EditorView, pos: number): PMNode | null {
  const node = view.state.doc.nodeAt(pos);
  return node?.type === nodes.skill_ref ? node : null;
}

function blockOf(view: EditorView, pos: number): { block: PMNode; blockPos: number } | null {
  const $pos = view.state.doc.resolve(pos);
  return $pos.parent.isTextblock ? { block: $pos.parent, blockPos: $pos.before() } : null;
}

const mentionFor = (chip: PMNode) =>
  chip.attrs.plugin
    ? `\`${chip.attrs.plugin as string}:${chip.attrs.name as string}\``
    : mentionOf(chip.attrs.name as string);

/** Whether this use still reads as one of Habi's own sentences: only then may a change of role reword it. */
export function canReword(view: EditorView, pos: number): boolean {
  const chip = chipAt(view, pos);
  const at = blockOf(view, pos);
  if (!chip || !at) return false;
  return matchTemplate(canonOf(at.block), mentionFor(chip)) !== null;
}

/** Changes one use's role. The words follow only if they're Habi's own wording: an author's sentence stays theirs. */
export function setRole(view: EditorView, pos: number, role: RoleId): void {
  const chip = chipAt(view, pos);
  const at = blockOf(view, pos);
  if (!chip || !at) return;
  const found = matchTemplate(canonOf(at.block), mentionFor(chip));
  if (!found) {
    view.dispatch(view.state.tr.setNodeAttribute(pos, "role", role));
    return;
  }
  const from = chip.attrs.from ? (JSON.parse(chip.attrs.from as string) as ComposeSource) : null;
  const para = sentenceParagraph(role, { name: chip.attrs.name as string, from }, found.blank);
  view.dispatch(
    view.state.tr.replaceWith(
      at.blockPos + 1,
      at.blockPos + at.block.nodeSize - 1,
      Fragment.from(para.content),
    ),
  );
  if (!found.blank || found.blank === "…") selectBlank(view, at.blockPos);
}

/** Turns a plain mention into a link. */
export function promote(view: EditorView, pos: number, from?: ComposeSource | null): void {
  if (!chipAt(view, pos)) return;
  const tr = view.state.tr.setNodeAttribute(pos, "role", USED_HERE);
  if (from) tr.setNodeAttribute(pos, "from", fromAttr(from));
  view.dispatch(tr);
}

/** Takes one use out. If the sentence was only there for it, the sentence goes too. The other uses are untouched. */
export function removeUse(view: EditorView, pos: number): void {
  const chip = chipAt(view, pos);
  const at = blockOf(view, pos);
  if (!chip || !at) return;
  const tr = view.state.tr;
  if (
    matchTemplate(canonOf(at.block), mentionFor(chip)) &&
    view.state.doc.childCount > 1 &&
    at.blockPos > 0
  ) {
    tr.delete(at.blockPos, at.blockPos + at.block.nodeSize);
  } else {
    tr.delete(pos, pos + chip.nodeSize);
  }
  view.dispatch(tr);
}

/** Points one use at another skill, keeping its role and its sentence. */
export function replaceUse(view: EditorView, pos: number, pick: Pick): void {
  const chip = chipAt(view, pos);
  if (!chip) return;
  view.dispatch(
    view.state.tr.setNodeMarkup(pos, null, {
      ...chip.attrs,
      name: pick.name,
      plugin: null,
      from: fromAttr(pick.from),
    }),
  );
}

/** Points every use of a skill at another. A separate, explicit choice. */
export function replaceAll(view: EditorView, name: string, pick: Pick): void {
  const tr = view.state.tr;
  for (const o of occurrencesIn(view.state.doc)) {
    if (o.name !== name) continue;
    const chip = view.state.doc.nodeAt(o.pos);
    if (chip)
      tr.setNodeMarkup(o.pos, null, {
        ...chip.attrs,
        name: pick.name,
        plugin: null,
        from: fromAttr(pick.from),
      });
  }
  view.dispatch(tr);
}

export function selectUse(view: EditorView, pos: number): void {
  const tr = view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)).scrollIntoView();
  view.dispatch(tr);
  view.focus();
}
