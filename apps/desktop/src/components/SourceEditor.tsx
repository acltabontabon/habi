/**
 * Source editor for everything in a skill package (CodeMirror 6): Markdown
 * with formatting shortcuts, and highlighting for YAML, JSON, JavaScript,
 * TypeScript, Python, shell and Ruby, chosen from the file name. Soft
 * wrapping and undo history everywhere. Tab moves focus, as everywhere else,
 * so the editor is never a keyboard trap.
 */
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { yaml } from "@codemirror/lang-yaml";
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, placeholder as placeholderExtension } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { type Ref, useEffect, useImperativeHandle, useRef } from "react";
import type { SourceLanguage } from "../lib/languages";

function languageExtension(language: SourceLanguage): Extension[] {
  switch (language) {
    case "markdown":
      return [markdown()];
    case "yaml":
      return [yaml()];
    case "json":
      return [json()];
    case "javascript":
      return [javascript({ jsx: true })];
    case "typescript":
      return [javascript({ typescript: true, jsx: true })];
    case "python":
      return [python()];
    case "shell":
      return [StreamLanguage.define(shell)];
    case "ruby":
      return [StreamLanguage.define(ruby)];
    case "plain":
      return [];
  }
}

/** Prose and code in the Loom palette: dyes for code, ink for prose. */
const highlight = HighlightStyle.define([
  { tag: tags.heading, fontWeight: "600", color: "var(--ink)" },
  { tag: tags.strong, fontWeight: "600" },
  { tag: [tags.link, tags.url], color: "var(--thread-strong)" },
  { tag: tags.monospace, color: "var(--dye-4)" },
  { tag: [tags.processingInstruction, tags.meta, tags.quote], color: "var(--ink-muted)" },
  { tag: [tags.keyword, tags.controlKeyword, tags.operatorKeyword, tags.modifier], color: "var(--dye-7)" },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: "var(--dye-2)" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: "var(--dye-1)" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "var(--ink-muted)" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "var(--dye-0)" },
  { tag: [tags.propertyName, tags.attributeName], color: "var(--dye-4)" },
  { tag: [tags.typeName, tags.className], color: "var(--dye-5)" },
  { tag: tags.variableName, color: "var(--ink)" },
]);

/** Lets a parent insert text where the caret is (a file link, say). */
export type SourceEditorHandle = {
  insert: (text: string) => void;
};

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

export function SourceEditor({
  value,
  onChange,
  label,
  placeholder,
  readOnly = false,
  language = "markdown",
  handle,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder?: string;
  readOnly?: boolean;
  language?: SourceLanguage;
  handle?: Ref<SourceEditorHandle>;
}) {
  const prose = language === "markdown";
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
        ...(!prose
          ? []
          : [
              { key: "Mod-b", run: toggleWrap("**") },
              { key: "Mod-i", run: toggleWrap("_") },
              { key: "Mod-e", run: toggleWrap("`") },
            ]),
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      // Prose wraps; code keeps its lines and scrolls sideways.
      ...(prose || language === "plain" ? [EditorView.lineWrapping] : []),
      theme,
      EditorView.contentAttributes.of({ "aria-label": label, spellcheck: prose ? "true" : "false" }),
      EditorState.readOnly.of(readOnly),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) onChangeRef.current(update.state.doc.toString());
      }),
    ];
    extensions.push(...languageExtension(language), syntaxHighlighting(highlight));
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
  }, [label, placeholder, readOnly, language]);

  useImperativeHandle(
    handle,
    () => ({
      insert: (text: string) => {
        const current = view.current;
        if (!current) return;
        current.dispatch(current.state.replaceSelection(text), {
          scrollIntoView: true,
          userEvent: "input",
        });
        current.focus();
      },
    }),
    [],
  );

  // Apply a value that came from outside (a reload), keeping the caret sane.
  useEffect(() => {
    const current = view.current;
    if (!current) return;
    const existing = current.state.doc.toString();
    if (existing !== value) {
      current.dispatch({ changes: { from: 0, to: existing.length, insert: value } });
    }
  }, [value]);

  return <div className="source-editor" ref={host} />;
}
