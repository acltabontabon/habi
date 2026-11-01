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
import { type Plugin, TextSelection } from "prosemirror-state";
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

/** `**word**` as it's typed, leaving the markers behind. */
function markRule(pattern: RegExp, type: MarkType, attrs?: Record<string, unknown>): InputRule {
  return new InputRule(pattern, (state, match, start, end) => {
    const text = match[1];
    if (!text) return null;
    const $from = state.doc.resolve(start);
    if ($from.parent.type.spec.code) return null;
    const open = match[0].indexOf(text);
    const tr = state.tr;
    tr.replaceWith(start, end, schema.text(text, [...$from.marks(), type.create(attrs)]));
    tr.removeStoredMark(type);
    // Hold the caret after what was marked.
    tr.setSelection(TextSelection.create(tr.doc, start + text.length));
    return open >= 0 ? tr : null;
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

export function editingPlugins(): Plugin[] {
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
        splitListItem(nodes.list_item),
        newlineInCode,
        createParagraphNear,
        liftEmptyBlock,
        splitBlock,
      ),
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
