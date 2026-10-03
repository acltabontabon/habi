/**
 * The instructions: SKILL.md's body, written as the document it is. The
 * Markdown steps aside away from the caret, references to the package's own
 * files read as references (⌘-click opens one), and an empty skill offers a
 * few shapes to start from — never required.
 *
 * The outline is a quiet spine in the margin — one tick per heading — that
 * opens into the headings when pointed at, focused or summoned (⌘⇧O). On a
 * narrow window it appears only when summoned.
 */
import { type CSSProperties, type RefObject, useEffect, useMemo, useRef } from "react";
import type { TemplateInfo } from "../../../bindings/TemplateInfo";
import { SourceEditor } from "../../../components/lazy";
import type { LineMark, SourceEditorHandle } from "../../../components/SourceEditor";
import { unfinishedLines } from "../../../lib/coach";
import { markdownOutline, type OutlineHeading, sectionAt } from "../../../lib/markdownOutline";
import { packageCompletions } from "../../../lib/packageCompletions";
import { useSkillTemplates } from "../../../lib/queries";
import type { SkillDraft } from "./useSkillDraft";

const FALLBACK: TemplateInfo[] = [];

function Starters({ onPick }: { onPick: (t: TemplateInfo) => void }) {
  const templates = useSkillTemplates();
  const offered = (templates.data ?? FALLBACK).filter((t) => t.template !== "blank");
  if (offered.length === 0) return null;
  return (
    <p className="ins-starters">
      <span>Or begin from</span>
      {offered.map((t) => (
        <button
          key={t.template}
          type="button"
          className="ins-starter"
          title={t.summary}
          onClick={() => onPick(t)}
        >
          {t.label}
        </button>
      ))}
    </p>
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
  if (outline.length < 2) return null;
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
  onCursorLine,
  onOpenFile,
}: {
  draft: SkillDraft;
  editor: RefObject<SourceEditorHandle | null>;
  onCursorLine: (line: number) => void;
  /** A reference to one of the package's files was ⌘-clicked. */
  onOpenFile: (path: string) => void;
}) {
  const { skill, document, setDocument, trashed } = draft;
  const pathsRef = useRef<string[]>([]);
  pathsRef.current = skill.files.map((f) => f.path);
  const openRef = useRef(onOpenFile);
  openRef.current = onOpenFile;
  const completions = useMemo(() => packageCompletions(() => pathsRef.current), []);
  const live = useMemo(
    () => ({ paths: () => pathsRef.current, onOpen: (path: string) => openRef.current(path) }),
    [],
  );
  // Problems on their line, and what a starter left unfilled, said where it is.
  const marks: LineMark[] = useMemo(
    () => [
      ...skill.diagnostics
        .filter((d) => d.path === "SKILL.md" && d.line != null)
        .map((d) => ({ line: d.line ?? 1, level: d.level, message: d.message })),
      ...unfinishedLines(document.body).map((u) => ({
        line: u.line,
        level: "todo" as const,
        message: `${u.why} — fill it in, or remove it`,
      })),
    ],
    [skill.diagnostics, document.body],
  );
  const empty = document.body.trim() === "";

  return (
    <div className={`ins${empty ? " is-empty" : ""}`}>
      <SourceEditor
        handle={editor}
        label="Instructions"
        value={document.body}
        readOnly={trashed}
        variant="prose"
        live={live}
        completions={completions}
        marks={marks}
        onCursorLine={onCursorLine}
        placeholder="Start writing…"
        onChange={(body) => setDocument((d) => ({ ...d, body }))}
      />
      {empty && !trashed ? <Starters onPick={(t) => setDocument((d) => ({ ...d, body: t.body }))} /> : null}
    </div>
  );
}
