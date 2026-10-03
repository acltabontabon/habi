/**
 * Markdown that disappears when it is not needed. The instructions stay
 * Markdown — every character is still there, every shortcut still works —
 * but away from the caret the markup steps aside: headings read as headings,
 * emphasis as emphasis, code as code, and links to the package's own files
 * as references to them (⌘-click opens one). The line being edited shows its
 * markup in full, so nothing is ever hidden while it is being changed.
 */
import { syntaxTree } from "@codemirror/language";
import type { EditorState, Range } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";

export type LivePreviewOptions = {
  /** The package's files, to recognise references to them. */
  paths: () => string[];
  /** A reference was ⌘-clicked. */
  onOpen?: (path: string) => void;
};

class Bullet extends WidgetType {
  override eq() {
    return true;
  }
  override toDOM() {
    const el = document.createElement("span");
    el.className = "cm-lp-bullet";
    el.textContent = "•";
    return el;
  }
}

class FenceLabel extends WidgetType {
  constructor(readonly lang: string) {
    super();
  }
  override eq(other: FenceLabel) {
    return other.lang === this.lang;
  }
  override toDOM() {
    const el = document.createElement("span");
    el.className = "cm-lp-fence-label";
    el.textContent = this.lang;
    return el;
  }
}

const hide = Decoration.replace({});
const bullet = Decoration.replace({ widget: new Bullet() });

/** Lines the selection touches show their markup. */
function activeLines(state: EditorState): Set<number> {
  const lines = new Set<number>();
  for (const r of state.selection.ranges) {
    const from = state.doc.lineAt(r.from).number;
    const to = state.doc.lineAt(r.to).number;
    for (let n = from; n <= to; n++) lines.add(n);
  }
  return lines;
}

function normalise(target: string): string {
  return target.replace(/^\.\//, "").replace(/[#?].*$/, "");
}

function build(view: EditorView, options: LivePreviewOptions, focused: boolean): DecorationSet {
  const { state } = view;
  const active = focused ? activeLines(state) : new Set<number>();
  const paths = new Set(options.paths());
  const out: Range<Decoration>[] = [];
  const lineOf = (pos: number) => state.doc.lineAt(pos).number;
  const isActive = (from: number, to = from) => {
    for (let n = lineOf(from); n <= lineOf(to); n++) if (active.has(n)) return true;
    return false;
  };

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name;
        const heading = /^ATXHeading(\d)$/.exec(name);
        if (heading) {
          const line = state.doc.lineAt(node.from);
          out.push(Decoration.line({ class: `cm-lp-h cm-lp-h${heading[1]}` }).range(line.from));
          return;
        }
        if (name === "HeaderMark") {
          if (
            isActive(node.from) ||
            node.matchContext(["SetextHeading1"]) ||
            node.matchContext(["SetextHeading2"])
          )
            return;
          const next = state.sliceDoc(node.to, node.to + 1);
          out.push(hide.range(node.from, next === " " ? node.to + 1 : node.to));
          return;
        }
        if (name === "EmphasisMark" || name === "StrikethroughMark") {
          if (!isActive(node.from)) out.push(hide.range(node.from, node.to));
          return;
        }
        if (name === "InlineCode") {
          const inner = state.sliceDoc(node.from, node.to).replace(/^`+|`+$/g, "");
          const ref = paths.has(normalise(inner));
          out.push(
            Decoration.mark({
              class: ref ? "cm-lp-code cm-lp-ref" : "cm-lp-code",
              attributes: ref ? { "data-path": normalise(inner), title: "⌘-click to open" } : undefined,
            }).range(node.from, node.to),
          );
          if (!isActive(node.from)) {
            const c = node.node.cursor();
            if (c.firstChild()) {
              do {
                if (c.name === "CodeMark") out.push(hide.range(c.from, c.to));
              } while (c.nextSibling());
            }
          }
          return false;
        }
        if (name === "Link") {
          const c = node.node.cursor();
          let url = "";
          const marks: [number, number][] = [];
          let textFrom = -1;
          let textTo = -1;
          if (c.firstChild()) {
            do {
              if (c.name === "LinkMark") {
                const mark = state.sliceDoc(c.from, c.to);
                if (mark === "[") textFrom = c.to;
                if (mark === "]") textTo = c.from;
                marks.push([c.from, c.to]);
              } else if (c.name === "URL") {
                url = state.sliceDoc(c.from, c.to);
                marks.push([c.from, c.to]);
              } else if (c.name === "LinkTitle") {
                marks.push([c.from, c.to]);
              }
            } while (c.nextSibling());
          }
          if (textFrom < 0 || textTo <= textFrom) return false;
          const target = normalise(url);
          const ref = paths.has(target);
          out.push(
            Decoration.mark({
              class: ref ? "cm-lp-link cm-lp-ref" : "cm-lp-link",
              attributes: ref
                ? { "data-path": target, title: `${target} — ⌘-click to open` }
                : { title: url },
            }).range(textFrom, textTo),
          );
          if (!isActive(node.from, node.to)) {
            // Hide "[" and everything from "]" to the closing ")".
            out.push(hide.range(node.from, textFrom));
            out.push(hide.range(textTo, node.to));
          }
          return false;
        }
        if (name === "QuoteMark") {
          const line = state.doc.lineAt(node.from);
          out.push(Decoration.line({ class: "cm-lp-quote" }).range(line.from));
          if (!isActive(node.from)) {
            const next = state.sliceDoc(node.to, node.to + 1);
            out.push(hide.range(node.from, next === " " ? node.to + 1 : node.to));
          }
          return;
        }
        if (name === "ListMark" && node.matchContext(["BulletList", "ListItem"])) {
          if (!isActive(node.from)) out.push(bullet.range(node.from, node.to));
          return;
        }
        if (name === "HorizontalRule") {
          const line = state.doc.lineAt(node.from);
          out.push(Decoration.line({ class: "cm-lp-hr" }).range(line.from));
          if (!isActive(node.from)) out.push(hide.range(node.from, node.to));
          return;
        }
        if (name === "FencedCode") {
          const first = state.doc.lineAt(node.from);
          const last = state.doc.lineAt(node.to);
          const open = isActive(node.from, node.to);
          for (let n = first.number; n <= last.number; n++) {
            const line = state.doc.line(n);
            const cls = [
              "cm-lp-block",
              n === first.number ? "cm-lp-block-first" : "",
              n === last.number ? "cm-lp-block-last" : "",
              !open && (n === first.number || n === last.number) ? "cm-lp-fence" : "",
            ]
              .filter(Boolean)
              .join(" ");
            out.push(Decoration.line({ class: cls }).range(line.from));
          }
          if (!open) {
            const c = node.node.cursor();
            let lang = "";
            if (c.firstChild()) {
              do {
                if (c.name === "CodeInfo") lang = state.sliceDoc(c.from, c.to).trim();
              } while (c.nextSibling());
            }
            // The opening fence becomes a quiet label; the closing one, nothing.
            const firstText = first.text;
            const lead = firstText.length - firstText.trimStart().length;
            if (first.length > lead) {
              out.push(
                Decoration.replace({ widget: new FenceLabel(lang) }).range(first.from + lead, first.to),
              );
            }
            if (last.number !== first.number && /^\s*(`{3,}|~{3,})\s*$/.test(last.text)) {
              const l2 = last.text.length - last.text.trimStart().length;
              out.push(hide.range(last.from + l2, last.to));
            }
          }
          return false;
        }
        return;
      },
    });
  }
  return Decoration.set(out, true);
}

export function livePreview(options: LivePreviewOptions) {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view, options, view.hasFocus);
      }
      update(u: ViewUpdate) {
        if (
          u.docChanged ||
          u.viewportChanged ||
          u.selectionSet ||
          u.focusChanged ||
          syntaxTree(u.startState) !== syntaxTree(u.state)
        ) {
          this.decorations = build(u.view, options, u.view.hasFocus);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
  const open = EditorView.domEventHandlers({
    mousedown: (event) => {
      if (!(event.metaKey || event.ctrlKey) || !options.onOpen) return false;
      const ref = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-path]");
      const path = ref?.dataset.path;
      if (!path) return false;
      event.preventDefault();
      options.onOpen(path);
      return true;
    },
  });
  return [plugin, open];
}
