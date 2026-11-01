/**
 * The instructions: SKILL.md's body, written as the document it is. An empty
 * skill offers a few shapes to start from — never required — and the page
 * suggests one next thing at a time.
 *
 * The outline is a quiet spine in the margin — one tick per heading — that
 * opens into the headings when pointed at, focused or summoned (⌘⇧O). On a
 * narrow window it appears only when summoned.
 */
import { type CSSProperties, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import type { TemplateInfo } from "../../../bindings/TemplateInfo";
import { SourceEditor } from "../../../components/lazy";
import { Button } from "../../../components/ui";
import { api } from "../../../lib/api";
import { unfinishedLines } from "../../../lib/coach";
import { markdownOutline, type OutlineHeading, sectionAt } from "../../../lib/markdownOutline";
import { KIND_GLYPH, materialsOf } from "../../../lib/materials";
import { packageCompletions } from "../../../lib/packageCompletions";
import { useSkillTemplates } from "../../../lib/queries";
import type { Composer } from "./compose/useComposer";
import { FilePeek, type PeekTarget } from "./doc/FilePeek";
import { markdownForFile } from "./doc/fileRefs";
import { DocEditor, type DocEditorHandle } from "./doc/lazy";
import { countInvisibles, removeInvisibles } from "./doc/plugins";
import { nextPrompt } from "./doc/prompts";
import type { SlashItem } from "./doc/SlashMenu";
import type { SkillDraft } from "./useSkillDraft";

const FALLBACK: TemplateInfo[] = [];

function Starters({ onPick }: { onPick: (t: TemplateInfo) => void }) {
  const templates = useSkillTemplates();
  const offered = (templates.data ?? FALLBACK).filter((t) => t.template !== "blank");
  if (offered.length === 0) return null;
  return (
    <section className="doc-starters" aria-label="Begin from a shape">
      <span className="doc-starters-lead">Or begin from a shape</span>
      <ul>
        {offered.map((t) => (
          <li key={t.template}>
            <button type="button" className="doc-starter" onClick={() => onPick(t)}>
              <span className="doc-starter-name">{t.label}</span>
              <span className="doc-starter-what">{t.summary}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Outline({
  outline,
  current,
  pinned,
  onPinned,
  onGo,
}: {
  outline: OutlineHeading[];
  current: OutlineHeading | null;
  pinned: boolean;
  onPinned: (on: boolean) => void;
  onGo: (line: number) => void;
}) {
  const nav = useRef<HTMLElement>(null);
  // Summoned, it takes focus (on the section the caret is in) and leaves on a click elsewhere.
  useEffect(() => {
    if (!pinned) return;
    requestAnimationFrame(() =>
      (
        nav.current?.querySelector<HTMLElement>("button.is-current") ??
        nav.current?.querySelector<HTMLElement>("button")
      )?.focus(),
    );
    const away = (e: PointerEvent) => {
      if (!nav.current?.contains(e.target as Node)) onPinned(false);
    };
    window.addEventListener("pointerdown", away);
    return () => window.removeEventListener("pointerdown", away);
  }, [pinned, onPinned]);
  // Two sections fit on a screen, and two ticks beside them only look like stray marks.
  if (outline.length < 3) return null;
  const top = Math.min(...outline.map((h) => h.level));
  return (
    <nav
      ref={nav}
      className={`ins-outline${pinned ? " is-pinned" : ""}`}
      aria-label="Outline"
      onKeyDown={(e) => {
        const items = [...(nav.current?.querySelectorAll<HTMLElement>("button") ?? [])];
        const at = items.indexOf(window.document.activeElement as HTMLElement);
        if (e.key === "Escape" && pinned) {
          e.stopPropagation();
          onPinned(false);
        } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          items[Math.max(0, Math.min(items.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)))]?.focus();
        }
      }}
    >
      <ol>
        {outline.map((h) => (
          <li key={`${h.line}:${h.text}`} style={{ "--depth": Math.min(h.level - top, 3) } as CSSProperties}>
            <button
              type="button"
              className={h === current ? "is-current" : undefined}
              aria-current={h === current ? "location" : undefined}
              onClick={() => {
                onGo(h.line);
                onPinned(false);
              }}
            >
              <span className="ins-tick" aria-hidden="true" />
              <span className="ins-heading">{h.text}</span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function useOutline(body: string, cursorLine: number) {
  const outline = useMemo(() => markdownOutline(body), [body]);
  return { outline, current: sectionAt(outline, cursorLine) };
}

export function Instructions({
  draft,
  editor,
  sourceMode,
  composer,
  onCursorLine,
  onOpenFile,
}: {
  draft: SkillDraft;
  editor: RefObject<DocEditorHandle | null>;
  /** The same text, as text: for those who want the Markdown itself. */
  sourceMode: boolean;
  composer: Composer;
  onCursorLine: (line: number) => void;
  /** A reference to one of the package's files was ⌘-clicked. */
  onOpenFile: (path: string) => void;
}) {
  const { skill, document, setDocument, trashed } = draft;
  const pathsRef = useRef<string[]>([]);
  pathsRef.current = skill.files.map((f) => f.path);
  const completions = useMemo(() => packageCompletions(() => pathsRef.current), []);
  // Problems on their line, and what a starter left unfilled, said where it is.
  const marks = useMemo(
    () => [
      ...skill.diagnostics
        .filter((d) => d.path === "SKILL.md" && d.line != null)
        .map((d) => ({
          line: d.line ?? 1,
          level: d.level,
          message: d.message.replace(/^SKILL\.md /, "This "),
        })),
      ...unfinishedLines(document.body).map((u) => ({
        line: u.line,
        level: "todo" as const,
        message: `${u.why} — fill it in, or remove it`,
      })),
    ],
    [skill.diagnostics, document.body],
  );
  const empty = document.body.trim() === "";
  const purpose = useRef(document.description);
  purpose.current = document.description;
  const [hidden, setHidden] = useState<{ count: number } | null>(null);

  const [peek, setPeek] = useState<PeekTarget | null>(null);
  const filesRef = useRef(skill.files);
  filesRef.current = skill.files;
  const bodyRef = useRef(document.body);
  bodyRef.current = document.body;
  const unmentioned = useMemo(
    () => (empty ? [] : materialsOf(skill.files, document.body).filter((m) => !m.referenced)),
    [skill.files, document.body, empty],
  );
  const composerContext = composer.context;
  const context = useMemo(
    () => ({
      ...composerContext,
      files: () => materialsOf(filesRef.current, bodyRef.current),
      onFileClick: (path: string, rect: DOMRect, absent: boolean) =>
        setPeek({ path, absent, rect: { left: rect.left, top: rect.top, bottom: rect.bottom } }),
      imageData: async (path: string) => {
        if (!pathsRef.current.includes(path)) return null;
        const file = await api.readSkillFile(skill.summary.id, path).catch(() => null);
        return file?.preview ?? null;
      },
      openExternal: (href: string) => {
        if (/^https?:\/\//i.test(href)) void api.openExternal(href);
      },
    }),
    [skill.summary.id, composerContext],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: the bridge lives as long as this page.
  useEffect(() => {
    draft.page.current = {
      text: () => editor.current?.text() ?? draftBody.current,
      composes: () => composerRef.current.liveComposes(),
      verify: (text) => editor.current?.verify(text) ?? Promise.resolve("same"),
    };
    return () => {
      // After the page closes, what it last said is the text.
      const last = editor.current?.text() ?? draftBody.current;
      const record = composerRef.current.liveComposes();
      draft.page.current = {
        text: () => last,
        composes: () => record,
        verify: () => Promise.resolve("same"),
      };
    };
  }, []);
  // What the page suggests depends on whether there's a purpose yet, which lives outside it.
  const hasPurpose = document.description.trim() !== "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: this is what it reacts to.
  useEffect(() => {
    const view = editor.current?.view();
    if (view) view.dispatch(view.state.tr.setMeta("addToHistory", false));
  }, [hasPurpose, editor]);

  const composerRef = useRef(composer);
  composerRef.current = composer;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the files are what it reacts to.
  useEffect(() => {
    editor.current?.refreshFiles();
  }, [skill.files, editor]);

  const slashExtras = useMemo(() => {
    const fromSkills = composer.slashExtras;
    return (query: string): SlashItem[] => {
      const scoped = query.startsWith("file");
      const words = scoped ? query.slice(4).trim() : query;
      const files: SlashItem[] =
        scoped || words
          ? pathsRef.current
              .filter((p) => p !== "SKILL.md" && !/^habi\.ya?ml$/.test(p))
              .filter((p) => p.toLowerCase().includes(words))
              .slice(0, scoped ? 8 : 3)
              .map((p) => ({
                id: `file:${p}`,
                group: "This skill's files",
                label: p.slice(p.lastIndexOf("/") + 1),
                hint: p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : undefined,
                act: () => editor.current?.insertAt(markdownForFile(p), null),
              }))
          : [];
      return [...(scoped ? [] : fromSkills(query)), ...files];
    };
  }, [composer.slashExtras, editor]);

  const draftBody = useRef(document.body);
  draftBody.current = document.body;

  // biome-ignore lint/correctness/useExhaustiveDependencies: the body is what can hide characters.
  useEffect(() => {
    const view = editor.current?.view();
    if (!view) return;
    const { count } = countInvisibles(view.state.doc);
    setHidden(count > 0 ? { count } : null);
  }, [document.body, editor]);

  return (
    <div className={`ins${empty ? " is-empty" : ""}`}>
      {sourceMode ? (
        <SourceEditor
          label="Instructions, as Markdown"
          value={document.body}
          readOnly={trashed}
          variant="prose"
          completions={completions}
          marks={marks}
          onCursorLine={onCursorLine}
          placeholder="Start writing…"
          onChange={(body) => setDocument((d) => ({ ...d, body }))}
        />
      ) : null}
      <div hidden={sourceMode}>
        <DocEditor
          handle={editor}
          label="Instructions"
          value={document.body}
          readOnly={trashed}
          marks={marks}
          onCursorLine={onCursorLine}
          paths={() => pathsRef.current}
          onOpenFile={onOpenFile}
          promptFor={(doc) => nextPrompt(doc, purpose.current)}
          context={context}
          slashExtras={slashExtras}
          annotate={composer.annotate}
          onSettled={composer.onSettled}
          onChange={(body) => setDocument((d) => ({ ...d, body }))}
        />
      </div>
      {unmentioned.length && !sourceMode ? (
        <div className="doc-loose">
          <span>
            An agent won't know about these until the words mention them. Drag one to where it belongs:
          </span>
          <ul>
            {unmentioned.map((m) => (
              <li key={m.path}>
                <button
                  type="button"
                  className="sk-file is-loose"
                  onPointerDown={(e) => {
                    if (!trashed) composer.liftFile(m.path, m.name, e.nativeEvent);
                  }}
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    setPeek({
                      path: m.path,
                      absent: false,
                      rect: { left: r.left, top: r.top, bottom: r.bottom },
                    });
                  }}
                >
                  <span className="sk-file-glyph" aria-hidden="true">
                    {KIND_GLYPH[m.kind]}
                  </span>
                  {m.name}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {hidden && !sourceMode ? (
        <p className="doc-invisibles-note" role="status">
          {hidden.count === 1 ? "A hidden character is" : `${hidden.count} hidden characters are`} marked on
          this page. They were kept, because they may be meant.{" "}
          <Button
            variant="quiet"
            onClick={() => {
              const view = editor.current?.view();
              if (view) removeInvisibles(view);
            }}
          >
            Remove {hidden.count === 1 ? "it" : "them"}
          </Button>
        </p>
      ) : null}
      {peek ? (
        <FilePeek
          skillId={skill.summary.id}
          target={peek}
          executable={skill.files.find((f) => f.path === peek.path)?.executable ?? false}
          onOpen={(path) => {
            setPeek(null);
            onOpenFile(path);
          }}
          onCreate={(path) => {
            setPeek(null);
            void api
              .writeSkillFile(skill.summary.id, path, "", null)
              .then((fresh) => draft.adopt(fresh, { document: false, metadata: false }))
              .catch(draft.setActionError);
          }}
          onClose={() => {
            setPeek(null);
            editor.current?.focus();
          }}
        />
      ) : null}
      {empty && !trashed && !sourceMode ? (
        <Starters onPick={(t) => setDocument((d) => ({ ...d, body: t.body }))} />
      ) : null}
    </div>
  );
}
