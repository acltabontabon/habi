/**
 * The page. A skill's instructions as a document you write in directly: no marks
 * under the caret, no split view. The Markdown string stays the one truth; this is
 * a view of it, and what it gives back is the author's own text wherever they
 * didn't touch it.
 *
 * Typing costs one transaction. The text is worked out when typing pauses, or at
 * once when something asks for it, so a long document never slows the caret.
 */
import { dropCursor } from "prosemirror-dropcursor";
import { gapCursor } from "prosemirror-gapcursor";
import { DOMSerializer, type Node as PMNode, Slice } from "prosemirror-model";
import { EditorState, NodeSelection, TextSelection, type Transaction } from "prosemirror-state";
import { tableEditing } from "prosemirror-tables";
import { Transform } from "prosemirror-transform";
import { EditorView, type NodeViewConstructor } from "prosemirror-view";
import {
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { LineMark, SourceEditorHandle } from "../../../../components/SourceEditor";
import { BlockHandle, type BlockMenuTarget } from "./BlockHandle";
import { BlockTools } from "./BlockTools";
import { clipboardTextParser, clipboardTextSerializer } from "./clipboard";
import { sliceFromMarkdown, toggleTask } from "./commands";
import { armDrag } from "./drag";
import { FILE_ATTR, fileRefsPlugin, refreshFileRefs } from "./fileRefs";
import { editingPlugins } from "./keys";
import { canonOf } from "./markdown/canon";
import { type Parsed, parseBody } from "./markdown/parse";
import { type Span, write } from "./markdown/reconcile";
import { schema } from "./markdown/schema";
import { canonText, type Verdict } from "./markdown/verify";
import { verifyInBackground } from "./markdown/verifyWorker";
import { placeBlocks } from "./moves";
import { imageView, opaqueView, skillRefView, type ViewContext } from "./nodeViews";
import { Pieces } from "./Pieces";
import {
  flashBlock,
  flashPlugin,
  invisiblesPlugin,
  marksPlugin,
  type PromptFor,
  promptPlugin,
  type SlashState,
  setBlockMarks,
  slashPlugin,
} from "./plugins";
import { SelectionBar } from "./SelectionBar";
import { type SlashItem, SlashMenu, type SlashMenuHandle } from "./SlashMenu";
import { syntaxPlugin } from "./syntax";
import { usesPlugin } from "./uses";

const PAUSE_MS = 200;

export type DocEditorHandle = SourceEditorHandle & {
  /** Markdown at the caret, as content, undoable. */
  insertMarkdown: (markdown: string) => void;
  /** Markdown as a new last block, with the caret at its end. */
  appendMarkdown: (markdown: string) => void;
  /** The skill's files changed. */
  refreshFiles: () => void;
  /** Markdown where something was dropped, or at the caret. */
  insertAt: (markdown: string, coords: { left: number; top: number } | null) => void;
  /** Blocks of their own, in the gap nearest a point on screen: where a dropped file lands. */
  insertBlocksNear: (markdown: string, coords: { left: number; top: number }) => void;
  /** The text right now, without waiting for the pause. */
  text: () => string;
  /** Replaces what mentions are said to be, after their record changed elsewhere. */
  setRoles: (roles: Map<number, { role: string; from: string | null }>) => void;
  /** Whether the text would read back as what's on the page. */
  verify: (text: string) => Promise<Verdict>;
  view: () => EditorView | null;
};

function lineOfBlocks(spans: Span[], pos: number): number {
  let best = 1;
  for (const s of spans) {
    if (s.pos > pos) break;
    best = s.line;
  }
  return best;
}

/**
 * Where a line of the text is on the page. A block that wasn't touched is one
 * span, so inside it the line is found by walking its children's own lengths.
 */
export function positionForLine(doc: PMNode, spans: Span[], line: number): number {
  let span: Span | undefined;
  for (const s of spans) {
    if (s.line <= line && (!span || s.line >= span.line)) span = s;
    if (s.line > line) break;
  }
  if (!span) return 0;
  let pos = span.pos;
  let node = doc.nodeAt(pos);
  let left = line - span.line;
  // Down to the words themselves, so a mark sits on one item and not on its whole list.
  while (node && !node.isTextblock && !node.isAtom && node.type.name !== "table" && node.childCount > 0) {
    let inner = pos + 1;
    let found = false;
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      const lines = canonOf(child).split("\n").length;
      if (left < lines || i === node.childCount - 1) {
        pos = inner;
        node = child;
        found = true;
        break;
      }
      left -= lines;
      inner += child.nodeSize;
    }
    if (!found) break;
  }
  return pos;
}

export function DocEditor({
  value,
  onChange,
  label,
  placeholder,
  readOnly = false,
  handle,
  marks,
  onCursorLine,
  paths,
  onOpenFile,
  promptFor,
  slashExtras,
  context,
  annotate,
  onSettled,
  trayHost,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder?: string;
  readOnly?: boolean;
  handle?: Ref<DocEditorHandle>;
  marks?: LineMark[];
  onCursorLine?: (line: number) => void;
  /** The skill's own files, for references. */
  paths: () => string[];
  onOpenFile?: (path: string) => void;
  promptFor?: PromptFor;
  /** Skills and files the slash menu offers, for what's typed so far. */
  slashExtras?: (query: string) => SlashItem[];
  context: ViewContext;
  /** What a freshly opened document's mentions are, by position: the roles the Markdown doesn't hold. */
  annotate?: (doc: PMNode) => Map<number, { role: string; from: string | null }>;
  /** The document after typing paused. */
  onSettled?: (doc: PMNode) => void;
  /** Where the tray lives, clear of the page. Null keeps it away; unset leaves it under the page. */
  trayHost?: HTMLElement | null;
}) {
  const tray = (pieces: ReactNode) =>
    trayHost === undefined ? pieces : trayHost ? createPortal(pieces, trayHost) : null;
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const parsed = useRef<Parsed | null>(null);
  const spans = useRef<Span[]>([]);
  /** What the page last said in text. An incoming value equal to this is its own echo. */
  const emitted = useRef(value);
  const timer = useRef<number | null>(null);
  const dirty = useRef(false);

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onCursorRef = useRef(onCursorLine);
  onCursorRef.current = onCursorLine;
  const marksRef = useRef(marks);
  marksRef.current = marks;
  const pathsRef = useRef(paths);
  pathsRef.current = paths;
  const openRef = useRef(onOpenFile);
  openRef.current = onOpenFile;
  const promptRef = useRef<PromptFor>(() => placeholder ?? null);
  promptRef.current = promptFor ?? (() => placeholder ?? null);
  const contextRef = useRef(context);
  contextRef.current = context;
  const annotateRef = useRef(annotate);
  annotateRef.current = annotate;
  const settledRef = useRef(onSettled);
  settledRef.current = onSettled;

  const [selectionTick, setSelectionTick] = useState(0);
  // The tools and tray need the page to exist, and it's created after the first render.
  const [, setMounted] = useState(false);
  const [slash, setSlash] = useState<SlashState>(null);
  const [blockMenu, setBlockMenu] = useState<BlockMenuTarget | null>(null);
  const slashMenu = useRef<SlashMenuHandle>(null);

  const placeMarks = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    const list = marksRef.current ?? [];
    setBlockMarks(
      view,
      list.map((m) => ({
        pos: positionForLine(view.state.doc, spans.current, m.line),
        level: m.level,
        message: m.message,
      })),
    );
  }, []);

  /** Works out the text. Cheap for what didn't change: blocks remember how they were written. */
  const settle = useCallback((): string => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    const view = viewRef.current;
    const base = parsed.current;
    if (!view || !base || !dirty.current) return emitted.current;
    const written = write(view.state.doc, base.baseline);
    dirty.current = false;
    spans.current = written.spans;
    settledRef.current?.(view.state.doc);
    if (written.text !== emitted.current) {
      emitted.current = written.text;
      onChangeRef.current(written.text);
    }
    return written.text;
  }, []);

  const reportCursor = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    onCursorRef.current?.(lineOfBlocks(spans.current, view.state.selection.from));
  }, []);

  const stateFor = useCallback((source: string, prior?: EditorState): EditorState => {
    const next = parseBody(source);
    parsed.current = next;
    spans.current = write(next.doc, next.baseline).spans;
    const roles = annotateRef.current?.(next.doc);
    let doc = next.doc;
    if (roles?.size) {
      const tr = new Transform(doc);
      for (const [pos, attrs] of roles) {
        tr.setNodeAttribute(pos, "role", attrs.role);
        if (attrs.from) tr.setNodeAttribute(pos, "from", attrs.from);
      }
      doc = tr.doc;
    }
    const state = EditorState.create({
      doc,
      plugins: [
        // First, so the open menu sees Enter and the arrows before the editor does.
        slashPlugin(() => ({
          onChange: setSlash,
          onKey: (e) => slashMenu.current?.key(e) ?? false,
        })),
        ...editingPlugins(),
        tableEditing({ allowTableNodeSelection: false }),
        dropCursor({ color: "var(--thread)", width: 2, class: "doc-drop" }),
        gapCursor(),
        promptPlugin(() => promptRef.current),
        marksPlugin(),
        flashPlugin(),
        invisiblesPlugin(),
        syntaxPlugin(),
        fileRefsPlugin(() => pathsRef.current()),
        usesPlugin(),
      ],
    });
    if (!prior) return state;
    const at = Math.min(prior.selection.from, state.doc.content.size);
    return state.apply(state.tr.setSelection(TextSelection.near(state.doc.resolve(at))));
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the page is created once; later values arrive below.
  useEffect(() => {
    if (!host.current) return;
    const nodeViews: Record<string, NodeViewConstructor> = {
      opaque_block: opaqueView(() => contextRef.current),
      image: imageView(() => contextRef.current),
      skill_ref: skillRefView(() => contextRef.current),
    };
    const view: EditorView = new EditorView(
      { mount: host.current },
      {
        state: stateFor(value),
        nodeViews,
        editable: () => !readOnly,
        attributes: {
          "aria-label": label,
          "aria-multiline": "true",
          role: "textbox",
          class: `doc-page${readOnly ? " is-readonly" : ""}`,
          spellcheck: "true",
          "data-skill-editor": "",
        },
        dispatchTransaction(tr: Transaction) {
          const next = view.state.apply(tr);
          view.updateState(next);
          if (tr.docChanged) {
            dirty.current = true;
            if (timer.current !== null) window.clearTimeout(timer.current);
            timer.current = window.setTimeout(() => {
              settle();
              reportCursor();
              placeMarks();
            }, PAUSE_MS);
          }
          if (tr.selectionSet || tr.docChanged) setSelectionTick((t) => t + 1);
          if (tr.selectionSet && !tr.docChanged) reportCursor();
        },
        clipboardTextParser,
        clipboardTextSerializer,
        handleKeyDown(current, event) {
          // The keyboard's way to open a skill named at the caret.
          if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return false;
          const { selection } = current.state;
          let pos: number | null = null;
          if (selection instanceof NodeSelection && selection.node.type.name === "skill_ref")
            pos = selection.from;
          else if (selection.$from.nodeAfter?.type.name === "skill_ref") pos = selection.from;
          else if (selection.$from.nodeBefore?.type.name === "skill_ref")
            pos = selection.from - (selection.$from.nodeBefore?.nodeSize ?? 1);
          if (pos === null) return false;
          const dom = current.nodeDOM(pos);
          if (!(dom instanceof HTMLElement)) return false;
          const node = current.state.doc.nodeAt(pos);
          contextRef.current.onSkillClick?.(node?.attrs.name as string, pos, dom.getBoundingClientRect());
          return true;
        },
        handleClickOn(current, _pos, node, nodePos, event) {
          const target = event.target as HTMLElement;
          // The box of a checklist item is on the item itself, left of its words.
          if (
            node.type.name === "list_item" &&
            node.attrs.checked !== null &&
            target.closest("li.doc-task")
          ) {
            const words = target.closest("li.doc-task")?.firstElementChild?.getBoundingClientRect();
            if (words && event.clientX < words.left) {
              toggleTask(nodePos)(current.state, current.dispatch);
              return true;
            }
          }
          const file = target.closest<HTMLElement>(`[${FILE_ATTR}]`);
          // A file named in the words opens a peek, with or without ⌘.
          if (file && !event.shiftKey) {
            const path = file.getAttribute(FILE_ATTR) ?? "";
            contextRef.current.onFileClick?.(
              path,
              file.getBoundingClientRect(),
              file.classList.contains("is-absent"),
            );
            return true;
          }
          const link = target.closest("a[href]");
          // Links open only when asked to with ⌘, and through what the app already trusts.
          if (link && (event.metaKey || event.ctrlKey)) {
            const href = link.getAttribute("href") ?? "";
            if (pathsRef.current().includes(href)) openRef.current?.(href);
            else contextRef.current.openExternal?.(href);
            event.preventDefault();
            return true;
          }
          return false;
        },
        handleDOMEvents: {
          // A click on a link while writing is a click in text, not a departure.
          click(_view, event) {
            if ((event.target as HTMLElement).closest("a[href]")) event.preventDefault();
            return false;
          },
          blur() {
            settle();
            return false;
          },
        },
      },
    );
    viewRef.current = view;
    setMounted(true);
    placeMarks();
    return () => {
      settle();
      view.destroy();
      viewRef.current = null;
    };
  }, [readOnly, label]);

  useImperativeHandle(
    handle,
    (): DocEditorHandle => ({
      insert: (text) => {
        const view = viewRef.current;
        if (!view) return;
        view.dispatch(view.state.tr.insertText(text).scrollIntoView());
        view.focus();
      },
      insertMarkdown: (markdown) => {
        const view = viewRef.current;
        if (!view) return;
        view.dispatch(view.state.tr.replaceSelection(sliceFromMarkdown(markdown)).scrollIntoView());
        view.focus();
      },
      appendMarkdown: (markdown) => {
        const view = viewRef.current;
        if (!view) return;
        const slice = sliceFromMarkdown(markdown);
        const tr = view.state.tr;
        const empty = tr.doc.childCount === 1 && tr.doc.firstChild?.content.size === 0;
        const nodes = slice.openStart
          ? [schema.nodes.paragraph.create(null, slice.content.firstChild?.content)]
          : null;
        const at = empty ? 0 : tr.doc.content.size;
        if (nodes) tr.replaceWith(at, empty ? tr.doc.content.size : at, nodes);
        else tr.replace(at, empty ? tr.doc.content.size : at, new Slice(slice.content, 0, 0));
        tr.setSelection(TextSelection.atEnd(tr.doc));
        view.dispatch(tr.scrollIntoView());
        view.focus();
      },
      revealLine: (line, atEnd) => {
        const view = viewRef.current;
        if (!view) return;
        settle();
        const pos = positionForLine(view.state.doc, spans.current, line);
        const $pos = view.state.doc.resolve(Math.min(pos + 1, view.state.doc.content.size));
        const sel = atEnd
          ? TextSelection.near(view.state.doc.resolve($pos.end()), -1)
          : TextSelection.near($pos);
        view.dispatch(view.state.tr.setSelection(sel));
        view.focus();
        const dom = view.nodeDOM(pos);
        if (dom instanceof HTMLElement) dom.scrollIntoView?.({ block: "center", behavior: "smooth" });
        flashBlock(view, pos);
      },
      focus: () => viewRef.current?.focus(),
      refreshFiles: () => {
        if (viewRef.current) refreshFileRefs(viewRef.current);
      },
      insertAt: (markdown, coords) => {
        const view = viewRef.current;
        if (!view) return;
        const hit = coords ? view.posAtCoords(coords) : null;
        const tr = view.state.tr;
        if (hit) tr.setSelection(TextSelection.near(tr.doc.resolve(hit.pos)));
        tr.replaceSelection(sliceFromMarkdown(markdown));
        view.dispatch(tr.scrollIntoView());
        view.focus();
      },
      insertBlocksNear: (markdown, coords) => {
        const view = viewRef.current;
        if (!view) return;
        const hit = view.posAtCoords(coords);
        const blocks: PMNode[] = [];
        parseBody(markdown).doc.forEach((block) => {
          blocks.push(block);
        });
        let at = view.state.doc.content.size;
        if (hit) {
          const $hit = view.state.doc.resolve(hit.pos);
          if ($hit.depth === 0) at = hit.pos;
          else {
            const dom = view.nodeDOM($hit.before(1));
            const box = dom instanceof HTMLElement ? dom.getBoundingClientRect() : null;
            at = box && coords.top < box.top + box.height / 2 ? $hit.before(1) : $hit.after(1);
          }
        }
        placeBlocks(view, at, blocks);
        view.focus();
      },
      text: () => settle(),
      setRoles: (roles) => {
        const view = viewRef.current;
        if (!view) return;
        const tr = view.state.tr;
        for (const [pos, attrs] of roles) {
          tr.setNodeAttribute(pos, "role", attrs.role);
          tr.setNodeAttribute(pos, "from", attrs.from);
        }
        view.dispatch(tr.setMeta("addToHistory", false));
      },
      verify: async (text) => {
        const view = viewRef.current;
        if (!view) return "same";
        return verifyInBackground(text, canonText(view.state.doc));
      },
      view: () => viewRef.current,
    }),
    [settle],
  );

  // A value from outside: a starter, a reload, the other version in a conflict.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || value === emitted.current) return;
    const apply = () => {
      if (!viewRef.current || viewRef.current.composing) {
        window.setTimeout(apply, 120);
        return;
      }
      if (value === emitted.current) return;
      settle();
      if (value === emitted.current) return;
      emitted.current = value;
      dirty.current = false;
      viewRef.current.updateState(stateFor(value, viewRef.current.state));
      placeMarks();
    };
    apply();
  }, [value, settle, stateFor, placeMarks]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: marks are read through their ref.
  useEffect(() => {
    placeMarks();
  }, [marks, placeMarks]);

  const view = viewRef.current;
  return (
    <div className={`doc-editor${readOnly ? " is-readonly" : ""}`}>
      <div className="doc-host" ref={host} />
      {view && !readOnly ? (
        <BlockHandle
          view={view}
          host={host}
          onMenu={setBlockMenu}
          menu={blockMenu}
          tick={selectionTick}
          onLiftUse={(pos, event) => contextRef.current.onLiftUse?.(pos, event)}
        />
      ) : null}
      {view && !readOnly ? (
        <SelectionBar view={view} tick={selectionTick} onLinkSkill={context.onLinkSkill} />
      ) : null}
      {view && !readOnly ? (
        <BlockTools
          view={view}
          tick={selectionTick}
          wrap={() => host.current?.parentElement ?? null}
          onOpenLink={(href) => {
            if (pathsRef.current().includes(href)) openRef.current?.(href);
            else contextRef.current.openExternal?.(href);
          }}
        />
      ) : null}
      {tray(
        view && !readOnly ? (
          <Pieces
            view={view}
            files={() => contextRef.current.files?.() ?? []}
            onChoose={(what) => contextRef.current.onChoosePiece?.(what)}
            landInto={(event, ghost, land) =>
              armDrag(event, () => ({
                view,
                ghost,
                grip: { x: 30, y: 16 },
                onLand: (landing) => {
                  if (landing.type === "slot") land(landing.slot.pos);
                },
              }))
            }
          />
        ) : null,
      )}
      {view && slash && !readOnly ? (
        <SlashMenu ref={slashMenu} view={view} slash={slash} extras={slashExtras} />
      ) : null}
    </div>
  );
}

export function renderToElement(node: PMNode): HTMLElement {
  const dom = document.createElement("div");
  dom.appendChild(DOMSerializer.fromSchema(schema).serializeNode(node));
  return dom;
}

export { NodeSelection };
