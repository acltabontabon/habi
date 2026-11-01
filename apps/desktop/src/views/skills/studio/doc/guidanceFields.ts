/** Small, literal fields over conventional guidance; connected material stays in the document. */
import { closeHistory } from "prosemirror-history";
import type { Node as PMNode } from "prosemirror-model";
import { TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import type { GuidanceTarget } from "./guidanceContext";

export type GuidanceFields = {
  label: "Instruction" | "Condition" | "Constraint" | "Expected result";
  value: string;
  /** Untouched connected guidance follows this field. */
  hasConnections: boolean;
  paragraph: PMNode;
  start: number;
  end: number;
};

export function readGuidanceFields(view: EditorView, target: GuidanceTarget): GuidanceFields | null {
  const selected = target.resolve(view);
  const paragraph = selected && view.state.doc.nodeAt(selected.from);
  if (paragraph?.type.name !== "paragraph") return null;
  const text = paragraph.textContent;
  const prefix = /^(Condition:|Constraint:|Expected result:|Expected outcome:)\s*/i.exec(text);
  const start = prefix?.[0].length ?? 0;
  const label = !prefix
    ? "Instruction"
    : /^condition/i.test(prefix[1] ?? "")
      ? "Condition"
      : /^constraint/i.test(prefix[1] ?? "")
        ? "Constraint"
        : "Expected result";
  let end = paragraph.content.size;
  let plain = "";
  let supported = true;
  let tail = false;
  paragraph.forEach((child, offset, index) => {
    if (tail || !supported) return;
    const prefixOnly = child.isText && offset + child.nodeSize <= start;
    if (
      child.isText &&
      (child.marks.length === 0 || (prefixOnly && child.marks.every((m) => m.type.name === "strong")))
    ) {
      plain += child.text;
      return;
    }
    // Only the exact attachment sentence produced by the composition controls may
    // follow the field. Keep its original nodes, marks, paths, roles and spelling.
    const link = child.isText && child.marks.length === 1 && child.marks[0]?.type.name === "link";
    const skill = child.type.name === "skill_ref";
    const next = paragraph.maybeChild(index + 1);
    const suffix = link
      ? /(?:^|[.!?:;]\s+)(Use |Consult )$/.exec(plain)
      : skill
        ? /(?:^|[.!?:;]\s+)(Consult the )$/.exec(plain)
        : null;
    if (
      !suffix ||
      !next?.isText ||
      next.marks.length ||
      !(link ? /^ to / : /^ when /).test(next.text ?? "")
    ) {
      supported = false;
      return;
    }
    const sentenceStart = plain.length - (suffix[1]?.length ?? 0);
    end = plain.slice(0, sentenceStart).trimEnd().length;
    tail = true;
  });
  if (!supported || end < start || (tail && end === start)) return null;
  if (/[\r\n]/.test(paragraph.textBetween(start, end))) return null;
  return { label, value: paragraph.textBetween(start, end), hasConnections: tail, paragraph, start, end };
}

export type GuidanceEditResult = "saved" | "changed" | "unavailable" | "multiline";
export function updateGuidanceFields(
  view: EditorView,
  target: GuidanceTarget,
  fields: GuidanceFields,
  value: string,
): GuidanceEditResult {
  if (view.isDestroyed || !view.editable) return "unavailable";
  if (/[\r\n]/.test(value)) return "multiline";
  const selected = target.resolve(view);
  if (!selected) return "unavailable";
  if (!view.state.doc.nodeAt(selected.from)?.eq(fields.paragraph)) return "changed";
  if (value === fields.value) return "saved";
  let prefix = 0;
  while (prefix < value.length && prefix < fields.value.length && value[prefix] === fields.value[prefix])
    prefix++;
  let suffix = 0;
  while (
    suffix < value.length - prefix &&
    suffix < fields.value.length - prefix &&
    value[value.length - suffix - 1] === fields.value[fields.value.length - suffix - 1]
  )
    suffix++;
  const from = selected.from + 1 + fields.start + prefix;
  const to = selected.from + 1 + fields.end - suffix;
  const replacement = value.slice(prefix, value.length - suffix);
  const tr = closeHistory(view.state.tr);
  if (replacement) tr.replaceWith(from, to, view.state.schema.text(replacement));
  else tr.delete(from, to);
  tr.setSelection(TextSelection.near(tr.doc.resolve(from + replacement.length)));
  view.dispatch(tr.scrollIntoView());
  return "saved";
}
