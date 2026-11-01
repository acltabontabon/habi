/** Everything the editor shows that isn't the document: prompts, marks, invisible characters, the slash menu's state. */
import type { Node as PMNode } from "prosemirror-model";
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import { INVISIBLE } from "./clipboard";

// ----- what the author hasn't written yet

export type PromptFor = (doc: PMNode) => string | null;

/**
 * The one quiet thing a page offers next, in the empty paragraph where the caret
 * is or the document ends. Worked out from the document each time and stored nowhere.
 */
export function promptPlugin(promptFor: () => PromptFor): Plugin {
  return new Plugin({
    props: {
      decorations(state) {
        const { doc, selection } = state;
        const $from = selection.$from;
        const empty = $from.parent.isTextblock && $from.parent.content.size === 0 && $from.depth === 1;
        const docEmpty = doc.childCount === 1 && doc.firstChild?.content.size === 0;
        if (!empty && !docEmpty) return null;
        const pos = docEmpty ? 0 : $from.before(1);
        const node = docEmpty ? doc.firstChild : $from.parent;
        if (!node || node.type.name !== "paragraph") return null;
        const text = promptFor()(doc) ?? (docEmpty ? null : "Keep writing, or pick a piece from below");
        if (!text) return null;
        return DecorationSet.create(doc, [
          Decoration.node(pos, pos + node.nodeSize, { class: "is-prompt", "data-prompt": text }),
        ]);
      },
    },
  });
}

// ----- problems, on the block they're about

export type BlockMark = { pos: number; level: string; message: string };

const markKey = new PluginKey<DecorationSet>("doc-marks");

export function marksPlugin(): Plugin {
  return new Plugin({
    key: markKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, old) {
        const next = tr.getMeta(markKey) as BlockMark[] | undefined;
        if (next) {
          const decos: Decoration[] = [];
          for (const m of next) {
            const node = tr.doc.nodeAt(m.pos);
            if (!node?.isBlock) continue;
            decos.push(
              Decoration.node(m.pos, m.pos + node.nodeSize, {
                class: `has-mark is-${m.level}`,
                "data-note": m.message,
              }),
            );
          }
          return DecorationSet.create(tr.doc, decos);
        }
        return tr.docChanged ? old.map(tr.mapping, tr.doc) : old;
      },
    },
    props: {
      decorations(state) {
        return markKey.getState(state);
      },
    },
  });
}

export function setBlockMarks(view: EditorView, marks: BlockMark[]) {
  view.dispatch(view.state.tr.setMeta(markKey, marks).setMeta("addToHistory", false));
}

const flashKey = new PluginKey<DecorationSet>("doc-flash");

export function flashPlugin(): Plugin {
  return new Plugin({
    key: flashKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, old) {
        const pos = tr.getMeta(flashKey) as number | null | undefined;
        if (pos === null) return DecorationSet.empty;
        if (pos !== undefined) {
          const node = tr.doc.nodeAt(pos);
          if (!node?.isBlock) return DecorationSet.empty;
          return DecorationSet.create(tr.doc, [
            Decoration.node(pos, pos + node.nodeSize, { class: "is-flash" }),
          ]);
        }
        return tr.docChanged ? old.map(tr.mapping, tr.doc) : old;
      },
    },
    props: {
      decorations(state) {
        return flashKey.getState(state);
      },
    },
  });
}

export function flashBlock(view: EditorView, pos: number) {
  view.dispatch(view.state.tr.setMeta(flashKey, pos).setMeta("addToHistory", false));
  window.setTimeout(() => {
    if (!view.isDestroyed)
      view.dispatch(view.state.tr.setMeta(flashKey, null).setMeta("addToHistory", false));
  }, 1400);
}

// ----- characters that don't show

/** Kept, never removed on their own: but marked, so the author can see what's there and decide. */
export function invisiblesPlugin(): Plugin {
  const key = new PluginKey<DecorationSet>("doc-invisibles");
  const find = (doc: PMNode) => {
    const decos: Decoration[] = [];
    doc.descendants((node, pos) => {
      if (!node.isText) return true;
      const text = node.text ?? "";
      INVISIBLE.lastIndex = 0;
      if (!INVISIBLE.test(text)) return false;
      INVISIBLE.lastIndex = 0;
      for (const m of text.matchAll(INVISIBLE)) {
        const at = pos + m.index;
        decos.push(
          Decoration.inline(at, at + m[0].length, {
            class: "doc-invisible",
            "data-invisible": `U+${(m[0].codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`,
            title: "A hidden character. It's kept as is, and a person reading this wouldn't see it.",
          }),
        );
      }
      return false;
    });
    return DecorationSet.create(doc, decos);
  };
  return new Plugin({
    key,
    state: {
      init: (_c, state) => find(state.doc),
      apply: (tr, old) => (tr.docChanged ? find(tr.doc) : old),
    },
    props: {
      decorations(state) {
        return key.getState(state);
      },
    },
  });
}

/** How many hidden characters a document holds, and the first one's place. */
export function countInvisibles(doc: PMNode): { count: number; first: number | null } {
  let count = 0;
  let first: number | null = null;
  doc.descendants((node, pos) => {
    if (!node.isText) return true;
    for (const m of (node.text ?? "").matchAll(INVISIBLE)) {
      count++;
      if (first === null) first = pos + m.index;
    }
    return false;
  });
  return { count, first };
}

export function removeInvisibles(view: EditorView) {
  const ranges: { from: number; to: number }[] = [];
  view.state.doc.descendants((node, pos) => {
    if (!node.isText) return true;
    for (const m of (node.text ?? "").matchAll(INVISIBLE)) {
      ranges.push({ from: pos + m.index, to: pos + m.index + m[0].length });
    }
    return false;
  });
  const tr = view.state.tr;
  for (const r of ranges.reverse()) tr.delete(r.from, r.to);
  view.dispatch(tr);
}

// ----- the slash menu

export type SlashState = { from: number; to: number; query: string } | null;

export const slashKey = new PluginKey<SlashState & { dismissedAt?: number }>("doc-slash");

const TRIGGER = /(?:^|\s)\/((?:skill |file )?[\p{L}\p{N} -]*)$/u;

type SlashCallbacks = {
  onChange: (state: SlashState) => void;
  onKey: (event: KeyboardEvent) => boolean;
};

export function slashPlugin(callbacks: () => SlashCallbacks): Plugin<SlashState> {
  const key = slashKey as unknown as PluginKey<SlashState>;
  let dismissedAt: number | null = null;
  return new Plugin<SlashState>({
    key,
    state: {
      init: () => null,
      apply(tr, _old, _oldState, state) {
        if (tr.getMeta(key) === "dismiss") {
          dismissedAt = state.selection.from;
          return null;
        }
        const { $from, empty } = state.selection;
        if (!empty || !$from.parent.isTextblock || $from.parent.type.spec.code) return null;
        const before = $from.parent.textBetween(0, $from.parentOffset, undefined, "￼");
        if (before.length > 80 + $from.parentOffset) return null;
        const m = TRIGGER.exec(before);
        if (!m) {
          dismissedAt = null;
          return null;
        }
        if (dismissedAt !== null && Math.abs(dismissedAt - state.selection.from) < (m[1]?.length ?? 0) + 2) {
          return null;
        }
        const query = m[1] ?? "";
        if (query.length > 40) return null;
        return { from: $from.pos - query.length - 1, to: $from.pos, query };
      },
    },
    view() {
      let last: SlashState = null;
      return {
        update(view) {
          const now = key.getState(view.state) ?? null;
          if (now !== last && (now?.query !== last?.query || now?.from !== last?.from)) {
            last = now;
            callbacks().onChange(now);
          }
        },
        destroy() {
          callbacks().onChange(null);
        },
      };
    },
    props: {
      handleKeyDown(view, event) {
        if (!key.getState(view.state)) return false;
        if (event.key === "Escape") {
          view.dispatch(view.state.tr.setMeta(key, "dismiss"));
          return true;
        }
        if (["ArrowUp", "ArrowDown", "Enter", "Tab"].includes(event.key)) return callbacks().onKey(event);
        return false;
      },
    },
  });
}

export function dismissSlash(view: EditorView) {
  view.dispatch(view.state.tr.setMeta(slashKey, "dismiss"));
}
