/** The keyboard and typed shortcuts: `#`, `-`, `1.`, `>`, fences and the usual modifier keys. */
import {
  baseKeymap,
  chainCommands,
  createParagraphNear,
  liftEmptyBlock,
  newlineInCode,
  splitBlock,
} from "prosemirror-commands";
import { history, redo, undo } from "prosemirror-history";
import {
  InputRule,
  inputRules,
  textblockTypeInputRule,
  undoInputRule,
  wrappingInputRule,
} from "prosemirror-inputrules";
import { keymap } from "prosemirror-keymap";
import type { MarkType, Node as PMNode } from "prosemirror-model";
import { splitListItem } from "prosemirror-schema-list";
import { type Command, type Plugin, TextSelection } from "prosemirror-state";
import { goToNextCell } from "prosemirror-tables";
import {
  codeEnter,
  codeTab,
  indent,
  insertRule,
  joinOrBackspace,
  moveBlock,
  outdent,
  setCodeBlock,
  setHeading,
  setParagraph,
  toggleBold,
  toggleCode,
  toggleItalic,
  toggleList,
  toggleQuote,
  toggleStrike,
} from "./commands";
import { schema } from "./markdown/schema";

const { nodes, marks } = schema;

/** `**word**` as it's typed, leaving the markers behind and what comes before them alone. */
function markRule(pattern: RegExp, type: MarkType, attrs?: Record<string, unknown>): InputRule {
  return new InputRule(pattern, (state, match, start, end) => {
    const text = match[1];
    if (!text) return null;
    const $from = state.doc.resolve(start);
    if ($from.parent.type.spec.code) return null;
    const lead = /^[\s(]/.test(match[0]) ? 1 : 0;
    const from = start + lead;
    const tr = state.tr.replaceWith(from, end, schema.text(text, [...$from.marks(), type.create(attrs)]));
    // Hold the caret after what was marked, and stop marking there.
    tr.setSelection(TextSelection.create(tr.doc, from + text.length));
    tr.removeStoredMark(type);
    return tr;
  });
}

function rules(): Plugin {
  return inputRules({
    rules: [
      textblockTypeInputRule(/^(#{1,6})\s$/, nodes.heading, (m) => ({ level: m[1]?.length ?? 1 })),
      wrappingInputRule(/^\s*([-+*])\s$/, nodes.bullet_list),
      wrappingInputRule(
        /^(\d+)\.\s$/,
        nodes.ordered_list,
        (m) => ({ start: Number(m[1]) || 1 }),
        (m, node: PMNode) => node.childCount + (node.attrs.start as number) === Number(m[1]),
      ),
      wrappingInputRule(/^\s*>\s$/, nodes.blockquote),
      textblockTypeInputRule(/^```([\w+-]*)\s$/, nodes.code_block, (m) => ({ info: m[1] ?? "" })),
      new InputRule(/^---$/, (state, _m, start, end) => {
        const $start = state.doc.resolve(start);
        if ($start.depth !== 1 || $start.parent.type !== nodes.paragraph) return null;
        const tr = state.tr.replaceRangeWith(
          $start.before(1),
          Math.min($start.after(1), end + 1),
          nodes.horizontal_rule.create(),
        );
        const after = tr.mapping.map($start.before(1)) + 1;
        if (after >= tr.doc.content.size) tr.insert(tr.doc.content.size, nodes.paragraph.create());
        tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(after + 1, tr.doc.content.size))));
        return tr;
      }),
      markRule(/(?:^|[\s(])\*\*([^\s*](?:[^*]*[^\s*])?)\*\*$/, marks.strong),
      markRule(/(?:^|[\s(])\*([^\s*](?:[^*]*[^\s*])?)\*$/, marks.em),
      markRule(/(?:^|[\s(])`([^`\s](?:[^`]*[^`\s])?)`$/, marks.code),
    ],
  });
}

/** Keep a visual instruction together while its author continues on another line. */
const insertLineBreak: Command = (state, dispatch) => {
  const { $from, $to } = state.selection;
  const br = state.schema.nodes.hard_break;
  if (!br || !$from.sameParent($to) || !$from.parent.canReplaceWith($from.index(), $to.index(), br))
    return false;
  dispatch?.(state.tr.replaceSelectionWith(br.create()).scrollIntoView());
  return true;
};

export function editingPlugins(studio = false): Plugin[] {
  return [
    history({ depth: 300, newGroupDelay: 600 }),
    rules(),
    keymap({
      "Mod-z": undo,
      "Mod-y": redo,
      "Shift-Mod-z": redo,
      Backspace: chainCommands(undoInputRule, joinOrBackspace),
      Enter: chainCommands(
        codeEnter,
        (state, dispatch) =>
          studio &&
          state.selection.$from.depth === 1 &&
          state.selection.$from.parent.type.name === "paragraph" &&
          state.selection.$from.parent.content.size > 0
            ? insertLineBreak(state, dispatch)
            : false,
        splitListItem(nodes.list_item),
        newlineInCode,
        createParagraphNear,
        liftEmptyBlock,
        splitBlock,
      ),
      "Shift-Enter": chainCommands(newlineInCode, insertLineBreak),
      Tab: chainCommands(codeTab, goToNextCell(1), indent),
      "Shift-Tab": chainCommands(goToNextCell(-1), outdent),
      "Mod-b": toggleBold,
      "Mod-i": toggleItalic,
      "Mod-e": toggleCode,
      "Mod-Shift-x": toggleStrike,
      "Mod-Shift-7": toggleList(nodes.ordered_list),
      "Mod-Shift-8": toggleList(nodes.bullet_list),
      "Mod-Shift-9": toggleQuote,
      "Mod-Alt-0": setParagraph,
      "Mod-Alt-1": setHeading(1),
      "Mod-Alt-2": setHeading(2),
      "Mod-Alt-3": setHeading(3),
      "Mod-Alt-c": setCodeBlock,
      "Mod-Alt-h": insertRule,
      // The keyboard's way to do what the block handle's drag does.
      "Alt-ArrowUp": moveBlock(-1),
      "Alt-ArrowDown": moveBlock(1),
    }),
    keymap(baseKeymap),
  ];
}
