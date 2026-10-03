/**
 * Source editor for everything in a skill package (CodeMirror 6): Markdown
 * with formatting shortcuts, and highlighting for YAML, JSON, JavaScript,
 * TypeScript, Python, shell and Ruby, chosen from the file name. Soft
 * wrapping and undo history everywhere. Tab moves focus, as everywhere else,
 * so the editor is never a keyboard trap.
 *
 * The prose variant sets Markdown as a document — the reading face, sized
 * headings, code in the machine face — so instructions are written the way
 * they will be read.
 */
import { autocompletion, type CompletionSource, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { yaml } from "@codemirror/lang-yaml";
import {
  HighlightStyle,
  LanguageDescription,
  LanguageSupport,
  StreamLanguage,
  syntaxHighlighting,
} from "@codemirror/language";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import {
  EditorSelection,
  EditorState,
  type Extension,
  Prec,
  RangeSetBuilder,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  placeholder as placeholderExtension,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { type Ref, useEffect, useImperativeHandle, useRef } from "react";
import type { SourceLanguage } from "../lib/languages";
import { type LivePreviewOptions, livePreview } from "./livePreview";

/** Code inside the instructions, highlighted in its own language. */
const fencedLanguages = [
  LanguageDescription.of({ name: "python", alias: ["py"], support: python() }),
  LanguageDescription.of({
    name: "javascript",
    alias: ["js", "jsx", "mjs", "node"],
    support: javascript({ jsx: true }),
  }),
  LanguageDescription.of({
    name: "typescript",
    alias: ["ts", "tsx"],
    support: javascript({ typescript: true, jsx: true }),
  }),
  LanguageDescription.of({ name: "json", support: json() }),
  LanguageDescription.of({ name: "yaml", alias: ["yml"], support: yaml() }),
  LanguageDescription.of({
    name: "shell",
    alias: ["sh", "bash", "zsh", "console"],
    load: async () => new LanguageSupport(StreamLanguage.define(shell)),
  }),
];

function languageExtension(language: SourceLanguage, rich = false): Extension[] {
  switch (language) {
    case "markdown":
      return [rich ? markdown({ base: markdownLanguage, codeLanguages: fencedLanguages }) : markdown()];
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
  { tag: tags.emphasis, fontStyle: "italic" },
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

/** Headings at the size they will be read; markup steps back; code in the machine face. */
const proseHighlight = HighlightStyle.define([
  {
    tag: tags.heading1,
    fontSize: "1.55em",
    fontWeight: "640",
    letterSpacing: "-0.02em",
    color: "var(--ink)",
  },
  {
    tag: tags.heading2,
    fontSize: "1.25em",
    fontWeight: "620",
    letterSpacing: "-0.012em",
    color: "var(--ink)",
  },
  { tag: tags.heading3, fontSize: "1.08em", fontWeight: "620", color: "var(--ink)" },
  { tag: [tags.heading4, tags.heading5, tags.heading6], fontWeight: "600", color: "var(--ink)" },
  { tag: tags.monospace, fontFamily: "var(--font-mono)", fontSize: "0.88em", color: "var(--dye-4)" },
  { tag: tags.processingInstruction, color: "var(--ink-faint)" },
]);

/** Lets a parent insert text where the caret is, or take the reader to a line. */
export type SourceEditorHandle = {
  insert: (text: string) => void;
  /** Scrolls to a 1-based line, puts the caret there (at its end when asked) and marks it briefly. */
  revealLine: (line: number, atEnd?: boolean) => void;
  focus: () => void;
};

/** A problem on a line, marked in the margin with its explanation. */
export type LineMark = { line: number; level: "error" | "warning" | "info" | "todo"; message: string };

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
  ".cm-tooltip": {
    border: "1px solid var(--hairline-strong)",
    borderRadius: "var(--radius)",
    background: "var(--paper-raised)",
    boxShadow: "var(--shadow-raised)",
    overflow: "hidden",
  },
  ".cm-tooltip-autocomplete > ul": { fontFamily: "var(--font-mono)", fontSize: "12.5px", maxHeight: "16em" },
  ".cm-tooltip-autocomplete > ul > li": { padding: "4px 10px !important", color: "var(--ink-soft)" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
    background: "var(--thread-wash) !important",
    color: "var(--ink) !important",
  },
  ".cm-completionDetail": { fontFamily: "var(--font-ui)", fontStyle: "normal", color: "var(--ink-faint)" },
  ".cm-completionMatchedText": { textDecoration: "none", color: "var(--thread-strong)", fontWeight: "600" },
});

const proseTheme = EditorView.theme({
  "&": { fontSize: "15.5px" },
  ".cm-scroller": { fontFamily: "var(--font-ui)", lineHeight: "1.72", overflow: "visible" },
  ".cm-content": { padding: "4px 0 30vh" },
  ".cm-line": { padding: "0" },
});

// ----- marks on lines: problems, and a brief flash where the reader was taken

const setMarks = StateEffect.define<LineMark[]>();
const flashLine = StateEffect.define<number | null>();

function decorate(state: EditorState, marks: LineMark[]): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const byLine = new Map<number, LineMark[]>();
  for (const m of marks) {
    if (m.line < 1 || m.line > state.doc.lines) continue;
    byLine.set(m.line, [...(byLine.get(m.line) ?? []), m]);
  }
  for (const line of [...byLine.keys()].sort((a, b) => a - b)) {
    const list = byLine.get(line) ?? [];
    const level = list.some((m) => m.level === "error") ? "error" : list[0]?.level;
    builder.add(
      state.doc.line(line).from,
      state.doc.line(line).from,
      Decoration.line({
        class: `cm-mark cm-mark-${level}`,
        attributes: { title: list.map((m) => m.message).join("\n") },
      }),
    );
  }
  return builder.finish();
}

const markField = StateField.define<{ marks: LineMark[]; set: DecorationSet }>({
  create: () => ({ marks: [], set: Decoration.none }),
  update(value, tr) {
    let next = value;
    for (const e of tr.effects) if (e.is(setMarks)) next = { marks: e.value, set: Decoration.none };
    if (next !== value || tr.docChanged) {
      // Lines move as text is typed; marks follow until the next check.
      const moved = (m: LineMark) => ({
        ...m,
        line: tr.state.doc.lineAt(tr.changes.mapPos(lineStart(tr.startState, m.line))).number,
      });
      const marks = next === value ? next.marks.map(moved) : next.marks;
      return { marks, set: decorate(tr.state, marks) };
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.set),
});

function lineStart(state: EditorState, line: number): number {
  return line >= 1 && line <= state.doc.lines ? state.doc.line(line).from : 0;
}

const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(flashLine)) {
        if (e.value === null || e.value > tr.state.doc.lines) return Decoration.none;
        const at = tr.state.doc.line(e.value).from;
        return Decoration.set([Decoration.line({ class: "cm-flash" }).range(at)]);
      }
    }
    return tr.docChanged ? value.map(tr.changes) : value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ----- Markdown shortcuts

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

/** Turns the selected lines into a list (or back into plain lines). */
function toggleList(ordered: boolean) {
  const marker = ordered ? /^(\s*)\d+[.)]\s+/ : /^(\s*)[-*+]\s+/;
  return (view: EditorView): boolean => {
    const { state } = view;
    const lines = new Set<number>();
    for (const r of state.selection.ranges) {
      for (let n = state.doc.lineAt(r.from).number; n <= state.doc.lineAt(r.to).number; n++) lines.add(n);
    }
    const all = [...lines].sort((a, b) => a - b).map((n) => state.doc.line(n));
    const listed = all.every((l) => marker.test(l.text));
    const changes = all.map((l, i) => {
      if (listed) {
        const m = marker.exec(l.text);
        return { from: l.from + (m?.[1]?.length ?? 0), to: l.from + (m?.[0]?.length ?? 0), insert: "" };
      }
      const indent = /^\s*/.exec(l.text)?.[0].length ?? 0;
      return { from: l.from + indent, insert: ordered ? `${i + 1}. ` : "- " };
    });
    view.dispatch({ changes, scrollIntoView: true, userEvent: "input" });
    return true;
  };
}

/** `[selection](|)` — the caret lands where the address goes. */
function insertLink(view: EditorView): boolean {
  view.dispatch(
    view.state.changeByRange((range) => {
      const text = view.state.sliceDoc(range.from, range.to);
      const insert = `[${text}]()`;
      return {
        changes: { from: range.from, to: range.to, insert },
        range: EditorSelection.cursor(range.from + (text ? insert.length - 1 : 1)),
      };
    }),
    { scrollIntoView: true, userEvent: "input" },
  );
  return true;
}

export function SourceEditor({
  value,
  onChange,
  label,
  placeholder,
  readOnly = false,
  language = "markdown",
  variant = "code",
  handle,
  completions,
  marks,
  onCursorLine,
  live,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder?: string;
  readOnly?: boolean;
  language?: SourceLanguage;
  /** "prose" sets Markdown as a document; "code" keeps the machine face. */
  variant?: "code" | "prose";
  handle?: Ref<SourceEditorHandle>;
  /** Suggestions while typing (package paths, for instance). */
  completions?: CompletionSource;
  marks?: LineMark[];
  /** The 1-based line the caret is on, as it moves. */
  onCursorLine?: (line: number) => void;
  /** Markdown that steps aside away from the caret (prose only). */
  live?: LivePreviewOptions;
}) {
  const prose = language === "markdown";
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onCursorRef = useRef(onCursorLine);
  onCursorRef.current = onCursorLine;
  const completionsRef = useRef(completions);
  completionsRef.current = completions;
  const marksRef = useRef(marks);
  marksRef.current = marks;
  const hasCompletions = Boolean(completions);
  const liveRef = useRef(live);
  liveRef.current = live;
  const isLive = Boolean(live) && variant === "prose";

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
              { key: "Mod-Shift-8", run: toggleList(false) },
              { key: "Mod-Shift-7", run: toggleList(true) },
              { key: "Mod-Shift-l", run: insertLink },
            ]),
        ...(hasCompletions ? completionKeymap : []),
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      // Prose wraps; code keeps its lines and scrolls sideways.
      ...(prose || language === "plain" ? [EditorView.lineWrapping] : []),
      theme,
      ...(variant === "prose" ? [Prec.high(proseTheme), Prec.high(syntaxHighlighting(proseHighlight))] : []),
      markField,
      flashField,
      EditorView.contentAttributes.of({ "aria-label": label, spellcheck: prose ? "true" : "false" }),
      EditorState.readOnly.of(readOnly),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) onChangeRef.current(update.state.doc.toString());
        if (update.selectionSet || update.docChanged) {
          onCursorRef.current?.(update.state.doc.lineAt(update.state.selection.main.head).number);
        }
      }),
    ];
    if (hasCompletions) {
      extensions.push(
        autocompletion({
          icons: false,
          override: [(context) => completionsRef.current?.(context) ?? null],
        }),
      );
    }
    extensions.push(...languageExtension(language, variant === "prose"), syntaxHighlighting(highlight));
    if (isLive) {
      extensions.push(
        livePreview({
          paths: () => liveRef.current?.paths() ?? [],
          onOpen: (path) => liveRef.current?.onOpen?.(path),
        }),
      );
    }
    if (placeholder) extensions.push(placeholderExtension(placeholder));
    const created = new EditorView({
      parent: host.current,
      state: EditorState.create({ doc: value, extensions }),
    });
    view.current = created;
    if (marksRef.current?.length) created.dispatch({ effects: setMarks.of(marksRef.current) });
    return () => {
      created.destroy();
      view.current = null;
    };
  }, [label, placeholder, readOnly, language, variant, hasCompletions, isLive]);

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
      revealLine: (line: number, atEnd?: boolean) => {
        const current = view.current;
        if (!current) return;
        const target = Math.min(Math.max(1, line), current.state.doc.lines);
        const at = atEnd ? current.state.doc.line(target).to : current.state.doc.line(target).from;
        current.dispatch({
          selection: EditorSelection.cursor(at),
          effects: [EditorView.scrollIntoView(at, { y: "center" }), flashLine.of(target)],
        });
        current.focus();
        window.setTimeout(() => view.current?.dispatch({ effects: flashLine.of(null) }), 1400);
      },
      focus: () => view.current?.focus(),
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

  useEffect(() => {
    view.current?.dispatch({ effects: setMarks.of(marks ?? []) });
  }, [marks]);

  return (
    <div
      className={`source-editor${variant === "prose" ? " is-prose" : ""}${isLive ? " is-live" : ""}`}
      ref={host}
    />
  );
}
