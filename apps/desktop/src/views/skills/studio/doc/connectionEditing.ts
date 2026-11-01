import { closeHistory } from "prosemirror-history";
import { Fragment, type Node as PMNode } from "prosemirror-model";
import { TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import type { Pick } from "../compose/edit";
import type { CanvasConnection } from "./canvasConnections";
import { attachGuidanceMaterial, attachGuidanceSkill, captureGuidanceTarget } from "./guidanceContext";
import { detachMaterialUse, listMaterialUses } from "./materialUses";

export function instructionTargets(doc: PMNode) {
  const targets: { from: number; to: number; label: string }[] = [];
  doc.descendants((node, from) => {
    if (node.type.name !== "paragraph") return true;
    const $pos = doc.resolve(from + 1);
    let prefix = "Instruction";
    for (let d = $pos.depth; d > 0; d--)
      if ($pos.node(d).type.name === "list_item" && $pos.node(d - 1).type.name === "ordered_list") {
        prefix = `Step ${Number($pos.node(d - 1).attrs.start) + $pos.index(d - 1)}`;
        break;
      }
    targets.push({
      from,
      to: from + node.nodeSize,
      label: `${prefix}: ${node.textContent.slice(0, 65) || "Empty instruction"}`,
    });
    return false;
  });
  return targets;
}

function currentUse(view: EditorView, connection: CanvasConnection) {
  const node = view.state.doc.nodeAt(connection.pos);
  if (connection.skill)
    return node?.type.name === "skill_ref" && node.attrs.name === connection.skill
      ? { from: connection.pos, to: connection.pos + node.nodeSize }
      : null;
  return (
    listMaterialUses(view.state.doc, connection.path ? [connection.path] : []).find(
      (use) => use.from === connection.pos && use.path === connection.path,
    ) ?? null
  );
}

/** Only remove a whole sentence when it matches Habi's explicit attachment grammar. */
function attachmentRange(doc: PMNode, from: number, to: number) {
  const $pos = doc.resolve(from);
  const before = doc.textBetween($pos.start(), from, "\n", "\ufffc");
  const prefix = /(?:^|[.!?:;]\s+)(Use |Consult |Consult the )$/.exec(before)?.[1];
  const after = doc.textBetween(to, $pos.end(), "\n", "\ufffc");
  const suffix = /^ (?:to|when) [^\n\ufffc]*?(?:[.!?](?=\s|$)|$)/.exec(after)?.[0];
  if (!prefix || !suffix) return null;
  return { from: from - prefix.length, to: to + suffix.length };
}

export function disconnectConnection(view: EditorView, connection: CanvasConnection): boolean {
  if (!view.editable) return false;
  const use = currentUse(view, connection);
  if (!use) return false;
  const range = attachmentRange(view.state.doc, use.from, use.to);
  if (range) {
    const $pos = view.state.doc.resolve(range.from);
    const from =
      range.from > $pos.start() && view.state.doc.textBetween(range.from - 1, range.from) === " "
        ? range.from - 1
        : range.from;
    view.dispatch(closeHistory(view.state.tr).delete(from, range.to).scrollIntoView());
  } else if (connection.path && "path" in use) return detachMaterialUse(view, use);
  else
    view.dispatch(
      closeHistory(view.state.tr)
        .replaceWith(use.from, use.to, view.state.schema.text(connection.name))
        .scrollIntoView(),
    );
  view.focus();
  return true;
}

export function moveConnection(view: EditorView, connection: CanvasConnection, destination: number): boolean {
  if (!view.editable) return false;
  const use = currentUse(view, connection);
  const target = view.state.doc.nodeAt(destination);
  if (!use || target?.type.name !== "paragraph" || view.state.doc.resolve(use.from).before() === destination)
    return false;
  const range = attachmentRange(view.state.doc, use.from, use.to);
  const content = view.state.doc.slice(range?.from ?? use.from, range?.to ?? use.to).content;
  const tr = closeHistory(view.state.tr);
  if (range) {
    const $pos = view.state.doc.resolve(range.from);
    const from =
      range.from > $pos.start() && view.state.doc.textBetween(range.from - 1, range.from) === " "
        ? range.from - 1
        : range.from;
    tr.delete(from, range.to);
  } else if (connection.skill) tr.replaceWith(use.from, use.to, view.state.schema.text(connection.name));
  else if ("kind" in use && use.kind !== "image") {
    tr.removeMark(use.from, use.to, view.state.schema.marks.link);
    tr.removeMark(use.from, use.to, view.state.schema.marks.code);
  } else tr.replaceWith(use.from, use.to, view.state.schema.text(connection.name));
  const at = tr.mapping.map(destination + target.nodeSize - 1);
  const existing = target.textContent.trim();
  const separator = existing ? (/[.!?:;]$/.test(existing) ? " " : ". ") : "";
  const insert = separator ? Fragment.from(view.state.schema.text(separator)).append(content) : content;
  tr.insert(at, insert).setSelection(TextSelection.near(tr.doc.resolve(at + insert.size)));
  view.dispatch(tr.scrollIntoView());
  view.focus();
  return true;
}

/** Shelf and material drags share the same exact instruction destination. */
export function connectToInstruction(
  view: EditorView,
  from: number,
  contribution: { path: string } | { skill: Pick; condition?: string },
) {
  if (!view.editable || view.state.doc.nodeAt(from)?.type.name !== "paragraph") return false;
  view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(from + 1))));
  const target = captureGuidanceTarget(view);
  if (!target) return false;
  const added =
    "path" in contribution
      ? attachGuidanceMaterial(view, target, contribution.path)
      : attachGuidanceSkill(view, target, contribution.skill, contribution.condition);
  target.release(view);
  return added;
}
