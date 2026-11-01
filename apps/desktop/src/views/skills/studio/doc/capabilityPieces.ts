/** Authoring choices are ordinary Markdown conventions, never a private skill schema. */

import { closeHistory } from "prosemirror-history";
import { Fragment, type Node as PMNode } from "prosemirror-model";
import { TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { parseBody } from "./markdown/parse";
import { schema } from "./markdown/schema";
import { placeBlocks } from "./moves";

export type CapabilityKind = "instruction" | "procedure" | "condition" | "constraint" | "example" | "result";

export type CapabilityPiece = {
  id: string;
  label: string;
  hint: string;
  kind?: CapabilityKind;
  choose?: "skill" | "file";
};

export const CAPABILITY_PIECES: CapabilityPiece[] = [
  { id: "instruction", label: "Instruction", hint: "Tell the agent what to do", kind: "instruction" },
  { id: "procedure", label: "Procedure", hint: "Give it a repeatable approach", kind: "procedure" },
  {
    id: "condition",
    label: "Condition",
    hint: "Explain when guidance applies",
    kind: "condition",
  },
  { id: "constraint", label: "Constraint", hint: "Set a rule or limitation", kind: "constraint" },
  { id: "example", label: "Example", hint: "Show the desired behavior", kind: "example" },
  {
    id: "result",
    label: "Expected result",
    hint: "Describe a successful response",
    kind: "result",
  },
  { id: "resource", label: "Resource", hint: "Attach a script, file or reference", choose: "file" },
  { id: "skill", label: "Skill reference", hint: "Bring in another skill's expertise", choose: "skill" },
];

/** The selection survives focus moving to the chooser. Never infer this from DOM focus. */
export function insertionAtSelection(view: EditorView): number {
  const { $from } = view.state.selection;
  if ($from.depth === 0) return $from.pos;
  return $from.depth === 1 && $from.parent.content.size === 0 ? $from.before(1) : $from.after(1);
}

export function blocksForMarkdown(markdown: string): PMNode[] {
  const blocks: PMNode[] = [];
  parseBody(markdown).doc.forEach((block) => {
    blocks.push(block);
  });
  return blocks;
}

/** Each choice is one undo, with its first prompt ready for the author's words. */
export function insertCapability(view: EditorView, at: number, markdown: string): void {
  view.dispatch(closeHistory(view.state.tr));
  const blocks = blocksForMarkdown(markdown);
  const place = placeBlocks(view, at, blocks);
  let blank: number | null = null;
  const first = view.state.doc.nodeAt(place);
  first?.descendants((node, offset) => {
    if (blank === null && node.isText) {
      const index = (node.text ?? "").indexOf("…");
      if (index >= 0) blank = place + 1 + offset + index;
    }
    return blank === null;
  });
  if (blank !== null) {
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, blank, blank + 1)));
  }
  view.focus();
}

export type AuthoredCapability = { content: string; when?: string; steps?: string[]; code?: boolean };
export const ADD_GUIDANCE = "habi-add-guidance";

/** Open the shared palette, or place a named piece directly on the canvas. */
export function openGuidanceChooser(view: EditorView, kind?: CapabilityKind): void {
  view.dom.dispatchEvent(new CustomEvent(ADD_GUIDANCE, { detail: { kind } }));
}

function literalParagraphs(content: string): PMNode[] {
  return content
    .trim()
    .split(/\r?\n[ \t]*\r?\n/)
    .filter((part) => part.trim())
    .map((part) => {
      const inline: PMNode[] = [];
      part.split(/\r?\n/).forEach((line, index) => {
        if (index) inline.push(schema.nodes.hard_break.create());
        if (line) inline.push(schema.text(line));
      });
      return schema.nodes.paragraph.create(null, inline);
    });
}

function labeled(label: string, content: string): PMNode[] {
  const paragraphs = literalParagraphs(content);
  const first = paragraphs[0];
  if (!first) return [];
  return [
    schema.nodes.paragraph.create(null, [
      schema.text(`${label}:`, [schema.marks.strong.create()]),
      schema.text(" "),
      ...Array.from({ length: first.childCount }, (_, index) => first.child(index)),
    ]),
    ...paragraphs.slice(1),
  ];
}

/** Plain fields become portable document nodes; entered Markdown is always literal text. */
export function authoredCapabilityBlocks(kind: CapabilityKind, input: AuthoredCapability): PMNode[] {
  if (kind === "procedure") {
    const steps = input.steps ?? [];
    if (!steps.length || steps.some((step) => !step.trim())) return [];
    return [
      schema.nodes.ordered_list.create(
        null,
        steps.map((step) => schema.nodes.list_item.create(null, literalParagraphs(step))),
      ),
    ];
  }
  if (!input.content.trim()) return [];
  if (kind === "condition") {
    const when = input.when
      ?.replace(/\s+/g, " ")
      .trim()
      .replace(/^when\s+/i, "");
    if (!when) return [];
    const action = input.content.replace(/\s+/g, " ").trim();
    return labeled("Condition", `When ${when}, ${action}${/[.!?]$/.test(action) ? "" : "."}`);
  }
  if (kind === "example" && input.code)
    return [schema.nodes.code_block.create(null, schema.text(input.content.replace(/\r\n/g, "\n")))];
  if (kind === "instruction") return literalParagraphs(input.content);
  return labeled(
    kind === "constraint" ? "Constraint" : kind === "example" ? "Example" : "Expected result",
    input.content,
  );
}

export function insertAuthoredCapability(
  view: EditorView,
  at: number,
  kind: CapabilityKind,
  input: AuthoredCapability,
): boolean {
  if (!view.editable || !Number.isInteger(at) || at < 0 || at > view.state.doc.content.size) return false;
  const blocks = authoredCapabilityBlocks(kind, input);
  if (!blocks.length) return false;
  view.dispatch(closeHistory(view.state.tr));
  placeBlocks(view, at, blocks);
  return true;
}

const CANVAS_STARTERS: Record<CapabilityKind, { values: AuthoredCapability; selected: string }> = {
  instruction: {
    values: { content: "Understand the request and identify what a successful outcome looks like." },
    selected: "Understand the request and identify what a successful outcome looks like.",
  },
  procedure: {
    values: {
      content: "",
      steps: [
        "Gather the context needed to understand the task.",
        "Work through the task using the relevant tools and references.",
        "Verify the result and explain any remaining limitations.",
      ],
    },
    selected: "Gather the context needed to understand the task.",
  },
  condition: {
    values: { content: "When the request is ambiguous.\nDo: Ask one focused question before proceeding." },
    selected: "the request is ambiguous",
  },
  constraint: {
    values: { content: "Preserve the user's existing work and ask before making irreversible changes." },
    selected: "Preserve the user's existing work and ask before making irreversible changes.",
  },
  example: {
    values: {
      content: 'Instead of "Something failed," explain what failed, why it matters, and the next action.',
    },
    selected: 'Instead of "Something failed," explain what failed, why it matters, and the next action.',
  },
  result: {
    values: { content: "Return the completed work, a concise explanation, and any next steps." },
    selected: "Return the completed work, a concise explanation, and any next steps.",
  },
};

/** Place editable starter guidance in the actual document, with no intermediate form. */
export function insertCanvasPiece(view: EditorView, at: number, kind: CapabilityKind): boolean {
  if (!view.editable || !Number.isInteger(at) || at < 0 || at > view.state.doc.content.size) return false;
  const live = view.state.schema as typeof schema;
  const parent = view.state.doc.resolve(at).parent;
  const inList = parent.type === live.nodes.ordered_list || parent.type === live.nodes.bullet_list;
  if (parent.type !== live.nodes.doc && !inList) return false;
  const starter = CANVAS_STARTERS[kind];
  let blocks =
    kind === "condition"
      ? labeled("Condition", starter.values.content)
      : authoredCapabilityBlocks(kind, starter.values);
  blocks = blocks.map((block) => live.nodeFromJSON(block.toJSON()));
  const first = blocks[0];
  if (!first) return false;
  if (inList)
    blocks =
      kind === "procedure"
        ? Array.from({ length: first.childCount }, (_, index) => first.child(index))
        : [live.nodes.list_item.create(null, blocks)];
  const sectionTitles: Partial<Record<CapabilityKind, string>> = {
    procedure: "How to do it",
    constraint: "Guardrails",
    example: "Examples",
  };
  const sectionTitle = !inList ? sectionTitles[kind] : undefined;
  const withHeading = Boolean(sectionTitle);
  const selectedText = sectionTitle ?? starter.selected;
  if (withHeading) blocks.unshift(live.nodes.heading.create({ level: 2 }, live.text(selectedText)));
  view.dispatch(closeHistory(view.state.tr));
  const place = placeBlocks(view, at, blocks);
  let selected: { from: number; to: number } | null = null;
  view.state.doc.nodeAt(place)?.descendants((node, offset) => {
    if (selected || !node.isText) return !selected;
    const index = (node.text ?? "").indexOf(selectedText);
    if (index >= 0) {
      const from = place + 1 + offset + index;
      selected = { from, to: from + selectedText.length };
    }
    return !selected;
  });
  if (selected) {
    const { from, to } = selected;
    view.dispatch(closeHistory(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to))));
  }
  view.focus();
  return true;
}

/** Section structure is inserted between canvas pieces, preserving existing prose. */
export function insertCanvasStructure(
  view: EditorView,
  kind: "heading" | "divider",
  at = insertionAtSelection(view),
): boolean {
  if (!view.editable || !Number.isInteger(at) || at < 0 || at > view.state.doc.content.size) return false;
  const live = view.state.schema as typeof schema;
  const $at = view.state.doc.resolve(at);
  const list = $at.parent;
  const inList = list.type === live.nodes.ordered_list || list.type === live.nodes.bullet_list;
  if ($at.depth !== 0 && !inList) return false;
  const blocks =
    kind === "heading"
      ? [live.nodes.heading.create({ level: 2 }, live.text("New section"))]
      : [
          live.nodes.horizontal_rule.create(),
          ...(at === view.state.doc.content.size ? [live.nodes.paragraph.create()] : []),
        ];
  view.dispatch(closeHistory(view.state.tr));
  let pos: number;
  if (inList) {
    const index = $at.index();
    const before = index ? list.copy(list.content.cut(0, $at.parentOffset)) : null;
    const after =
      index < list.childCount
        ? list.type.create(
            {
              ...list.attrs,
              ...(list.type === live.nodes.ordered_list ? { start: Number(list.attrs.start) + index } : {}),
            },
            list.content.cut($at.parentOffset),
          )
        : null;
    const start = $at.before();
    const replacement = [...(before ? [before] : []), ...blocks, ...(after ? [after] : [])];
    const parent = $at.node($at.depth - 1);
    if (
      !parent.canReplace(
        $at.index($at.depth - 1),
        $at.index($at.depth - 1) + 1,
        Fragment.fromArray(replacement),
      )
    )
      return false;
    view.dispatch(view.state.tr.replaceWith(start, $at.after(), replacement));
    pos = start + (before?.nodeSize ?? 0);
  } else pos = placeBlocks(view, at, blocks);
  const selection =
    kind === "heading"
      ? TextSelection.create(view.state.doc, pos + 1, pos + 12)
      : TextSelection.near(view.state.doc.resolve(pos + 1));
  view.dispatch(closeHistory(view.state.tr.setSelection(selection).scrollIntoView()));
  view.focus();
  return true;
}
