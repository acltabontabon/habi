/**
 * Markdown source editor (CodeMirror 6): soft wrapping, undo history,
 * Markdown-aware highlighting and a few formatting shortcuts. Tab moves
 * focus, as everywhere else, so the editor is never a keyboard trap.
 */
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, placeholder as placeholderExtension } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { useEffect, useRef } from "react";

const highlight = HighlightStyle.define([
  { tag: tags.heading, fontWeight: "600", color: "var(--ink)" },
  { tag: tags.strong, fontWeight: "600" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: [tags.link, tags.url], color: "var(--thread-strong)" },
  { tag: tags.monospace, color: "var(--unknown-ink)" },
  { tag: [tags.processingInstruction, tags.meta, tags.quote], color: "var(--ink-muted)" },
]);

const theme = EditorView.theme({
  "&": { color: "var(--ink)", backgroundColor: "transparent", fontSize: "13.5px" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--font-mono)",
    lineHeight: "1.65",
    overflow: "auto",
  },
  ".cm-content": { padding: "14px 0 48px", caretColor: "var(--ink)" },
  ".cm-line": { padding: "0 18px" },
  ".cm-cursor": { borderLeftColor: "var(--ink)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--thread-wash) !important",
  },
  ".cm-placeholder": { color: "var(--ink-muted)", fontStyle: "normal" },
});

/** Wraps the selection in `mark` (or removes it when already wrapped). */
function toggleWrap(mark: string) {
  return (view: EditorView): boolean => {
    const changes = view.state.changeByRange((range) => {
      const text = view.state.sliceDoc(range.from, range.to);
      const wrapped = text.startsWith(mark) && text.endsWith(mark) && text.length >= mark.length * 2;
      const insert = wrapped ? text.slice(mark.length, -mark.length) : `${mark}${text}${mark}`;
      const shift = wrapped ? -mark.length : mark.length;
      return {
        changes: { from: range.from, to: range.to, insert },
        range: range.empty
          ? EditorSelection.cursor(range.from + mark.length)
          : EditorSelection.range(range.from, range.to + shift * 2),
      };
    });
    view.dispatch(changes, { scrollIntoView: true, userEvent: "input" });
    return true;
  };
}

export function MarkdownEditor({
  value,
  onChange,
  label,
  placeholder,
  readOnly = false,
  plain = false,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder?: string;
  readOnly?: boolean;
  /** Plain text (YAML, scripts): no Markdown highlighting or shortcuts. */
  plain?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // biome-ignore lint/correctness/useExhaustiveDependencies: the editor is created once; value changes are applied below.
  useEffect(() => {
    if (!host.current) return;
    const extensions: Extension[] = [
      history(),
      keymap.of([
        ...(plain
          ? []
          : [
              { key: "Mod-b", run: toggleWrap("**") },
              { key: "Mod-i", run: toggleWrap("_") },
              { key: "Mod-e", run: toggleWrap("`") },
            ]),
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      EditorView.lineWrapping,
      theme,
      EditorView.contentAttributes.of({ "aria-label": label, spellcheck: plain ? "false" : "true" }),
      EditorState.readOnly.of(readOnly),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) onChangeRef.current(update.state.doc.toString());
      }),
    ];
    if (!plain) extensions.push(markdown(), syntaxHighlighting(highlight));
    if (placeholder) extensions.push(placeholderExtension(placeholder));
    const created = new EditorView({
      parent: host.current,
      state: EditorState.create({ doc: value, extensions }),
    });
    view.current = created;
    return () => {
      created.destroy();
      view.current = null;
    };
  }, [label, placeholder, readOnly, plain]);

  // Apply a value that came from outside (a reload), keeping the caret sane.
  useEffect(() => {
    const current = view.current;
    if (!current) return;
    const existing = current.state.doc.toString();
    if (existing !== value) {
      current.dispatch({ changes: { from: 0, to: existing.length, insert: value } });
    }
  }, [value]);

  return <div className="md-editor" ref={host} />;
}
