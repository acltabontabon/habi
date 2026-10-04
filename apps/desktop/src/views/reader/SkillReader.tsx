/**
 * Reading a skill: one document surface, and its package one keystroke
 * away.
 *
 * The surface shows the skill (an optional head, then SKILL.md) or exactly
 * one of its files — never both. Opening a file swaps the surface and keeps
 * the skill's place: "←" or Esc returns to the same scroll position. The
 * package is an inspector beside the surface (⌘I, or the Contents control):
 * it unfolds without moving the reader anywhere, and stays open for the
 * session if that is how someone works. Prose is rendered; code is shown
 * as code, highlighted and read-only. Used by libraries and by a project's
 * item detail alike.
 */
import { useQuery } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Icon } from "../../components/Icon";
import { Markdown, SourceEditor } from "../../components/lazy";
import { useToast } from "../../components/Toasts";
import { ErrorNotice, Working } from "../../components/ui";
import { api } from "../../lib/api";
import { plural } from "../../lib/format";
import { isInspectorShortcut, useInspectorOpen } from "../../lib/inspector";
import { languageFor } from "../../lib/languages";
import { modShortcut } from "../../lib/platform";
import { useItemDetail } from "../../lib/queries";
import { type PackageShape, packageShape } from "../../lib/skillFacts";
import { Outline } from "./Outline";
import { PackageInspector, type Reveal } from "./PackageInspector";

function size(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

function dirOf(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

function typing(target: EventTarget | null): boolean {
  return Boolean((target as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable]"));
}

/** The nearest ancestor that scrolls. */
function scroller(el: HTMLElement | null): HTMLElement | null {
  for (let node = el?.parentElement ?? null; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === "auto" || overflowY === "scroll") return node;
  }
  return null;
}

/** After the inspector closes, focus returns to what opened it. */
function focusToggle() {
  requestAnimationFrame(() => document.querySelector<HTMLElement>("[data-contents-toggle]")?.focus());
}

/* ---------- The package, for whatever is drawn around the reader ---------- */

type PackageControls = {
  shape: PackageShape;
  open: boolean;
  toggle: () => void;
  reveal: (target: Reveal) => void;
};

const PackageContext = createContext<PackageControls | null>(null);

/** The package of the skill being read, and its inspector. */
export function usePackage(): PackageControls | null {
  return useContext(PackageContext);
}

/** "Contents ▸": the one control that opens and closes the inspector. */
export function ContentsToggle() {
  const pkg = usePackage();
  if (!pkg) return null;
  return (
    <button
      type="button"
      className="contents-toggle"
      data-contents-toggle
      aria-expanded={pkg.open}
      aria-controls="package-inspector"
      title={`${pkg.open ? "Close" : "Open"} the package (${modShortcut("I")})`}
      onClick={pkg.toggle}
    >
      Contents
      <Icon name="chevronRight" size={12} />
    </button>
  );
}

/* ---------- One file of a package ---------- */

/** One file of a package, read where it is: prose rendered, code as code. */
export function FileReader({
  sourceId,
  itemId,
  path,
  files,
  onLocalLink,
}: {
  sourceId: string;
  itemId: string;
  path: string;
  files?: string[];
  onLocalLink?: (path: string) => void;
}) {
  const toast = useToast();
  const [source, setSource] = useState(false);
  const file = useQuery({
    queryKey: ["itemFile", sourceId, itemId, path],
    queryFn: () => api.itemFile(sourceId, itemId, path),
  });
  if (file.isPending) return <Working>Reading {path}…</Working>;
  if (file.isError) return <ErrorNotice error={file.error} />;
  const text = file.data.text;
  if (file.data.binary || text === null) {
    return <p className="muted file-reader-note">Not a text file · {size(file.data.size)}</p>;
  }
  const language = languageFor(path);
  const prose = language === "markdown" && !source;
  return (
    <div className="file-reader">
      <div className="file-reader-tools">
        <span className="kicker">{language === "plain" ? "text" : language}</span>
        <span className="mono muted">{size(file.data.size)}</span>
        {language === "markdown" ? (
          <button type="button" className="link-quiet" onClick={() => setSource((v) => !v)}>
            {source ? "Rendered" : "Source"}
          </button>
        ) : null}
        <button
          type="button"
          className="link-quiet"
          onClick={() =>
            void navigator.clipboard
              ?.writeText(text)
              .then(() => toast.show(`${path} copied.`))
              .catch(() => toast.show("Could not copy to the clipboard.", "danger"))
          }
        >
          Copy
        </button>
      </div>
      {prose ? (
        <div className="reader-doc">
          <Markdown text={text} files={files} onLocalLink={onLocalLink} base={dirOf(path) || undefined} />
        </div>
      ) : (
        <SourceEditor
          key={path}
          label={path}
          value={text}
          onChange={() => undefined}
          readOnly
          language={language}
        />
      )}
    </div>
  );
}

/* ---------- The reader ---------- */

/** Where a file sits: the skill, its folders, the file. */
function FileTrail({ title, file, onBack }: { title: string; file: string; onBack: () => void }) {
  const parts = file.split("/");
  const name = parts.pop();
  return (
    <header className="reader-crumb">
      <button type="button" className="reader-back" onClick={onBack} title="Back to the skill (Esc)">
        <Icon name="arrowLeft" size={14} />
        <span>{title}</span>
      </button>
      <h2 className="reader-path mono">
        {parts.map((p, i) => (
          <span key={i} className="reader-path-dir">
            {p}/
          </span>
        ))}
        <span className="reader-path-file">{name}</span>
      </h2>
      <span className="reader-esc" aria-hidden="true">
        esc
      </span>
    </header>
  );
}

export function SkillReader({
  sourceId,
  itemId,
  file,
  onFile,
  head,
  title,
}: {
  sourceId: string;
  itemId: string;
  /** The file being read, or `null` for the skill itself. */
  file: string | null;
  onFile: (path: string | null) => void;
  /** Shown above the skill's document (not above a file). Without one, a quiet package line. */
  head?: ReactNode;
  /** The skill's name, for the way back from a file. */
  title: string;
}) {
  const detail = useItemDetail(sourceId, itemId);
  const [open, setOpen] = useInspectorOpen();
  const [reveal, setReveal] = useState<(Reveal & { at: number }) | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const page = useRef<HTMLDivElement>(null);
  const skillScroll = useRef(0);
  const item = detail.data?.item;
  const main = item?.kind === "instructions" ? (item.files[0]?.path ?? "") : "SKILL.md";
  const shape = useMemo(() => (item ? packageShape(item.files, main) : null), [item, main]);

  // The inspector folds away after its last frame, so closing is seen.
  const [present, setPresent] = useState(open);
  useEffect(() => {
    if (open) {
      setPresent(true);
      return;
    }
    const t = window.setTimeout(() => setPresent(false), 200);
    return () => window.clearTimeout(t);
  }, [open]);

  const toggle = useCallback(() => setOpen(!open), [open, setOpen]);
  const revealIn = useCallback(
    (target: Reveal) => {
      setOpen(true);
      setReveal({ ...target, at: Date.now() });
    },
    [setOpen],
  );

  // Opening a file keeps the skill's place; returning restores it.
  const openFile = useCallback(
    (path: string | null) => {
      const box = scroller(root.current);
      if (path !== null && file === null && box) skillScroll.current = box.scrollTop;
      onFile(path);
    },
    [file, onFile],
  );
  const loaded = Boolean(item);
  useLayoutEffect(() => {
    if (!loaded) return;
    const box = scroller(root.current);
    if (!box) return;
    if (file === null) box.scrollTop = skillScroll.current;
    else box.scrollTop = 0;
  }, [file, loaded]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      if (isInspectorShortcut(e)) {
        e.preventDefault();
        if (!open) {
          setOpen(true);
          setReveal({ kind: "folder", folder: "", at: Date.now() });
        } else {
          setOpen(false);
          focusToggle();
        }
        return;
      }
      if (e.key !== "Escape" || e.defaultPrevented || typing(e.target)) return;
      // Esc steps back one layer: from a file to the skill, then closes the package.
      if (file !== null) {
        e.preventDefault();
        openFile(null);
      } else if (open) {
        e.preventDefault();
        const inside = (e.target as HTMLElement | null)?.closest?.("#package-inspector");
        setOpen(false);
        if (inside) focusToggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [file, open, openFile, setOpen]);

  if (detail.isPending) return <Working stage>Reading the skill…</Working>;
  if (detail.isError) return <ErrorNotice error={detail.error} />;
  if (!item || !shape) return null;
  const { body, source } = detail.data;
  const paths = item.files.map((f) => f.path);
  const openLink = (path: string) => openFile(path === main ? null : path);
  const controls: PackageControls = { shape, open, toggle, reveal: revealIn };

  return (
    <PackageContext.Provider value={controls}>
      <div className={`reader${open ? " has-inspector" : ""}`} ref={root}>
        <article className="reader-main">
          <div
            className={`reader-page${file !== null && languageFor(file) !== "markdown" ? " is-code" : ""}`}
            ref={page}
          >
            <div className="reader-content">
              {file !== null ? (
                <>
                  <FileTrail title={title} file={file} onBack={() => openFile(null)} />
                  <FileReader
                    sourceId={sourceId}
                    itemId={itemId}
                    path={file}
                    files={paths}
                    onLocalLink={openLink}
                  />
                </>
              ) : null}
              {/* The skill stays mounted while a file is read, so coming back is instant. */}
              <div hidden={file !== null}>
                {head ?? (
                  <div className="reader-bar">
                    <span className="mono muted">
                      {plural(shape.count, "file")}
                      {shape.code.length > 0 ? ` · ${plural(shape.code.length, "script")}` : ""}
                    </span>
                    <ContentsToggle />
                  </div>
                )}
                <div className="reader-doc" id="reader-doc" tabIndex={-1}>
                  <Markdown text={body} files={paths} onLocalLink={openLink} />
                </div>
              </div>
            </div>
            <Outline root={page} watch={file} />
          </div>
        </article>
        {present ? (
          <aside className="reader-inspector" id="package-inspector" inert={!open || undefined}>
            <PackageInspector
              shape={shape}
              current={file}
              main={main}
              community={source.role === "community"}
              reveal={reveal}
              onOpen={openFile}
              onClose={() => {
                setOpen(false);
                focusToggle();
              }}
            />
          </aside>
        ) : null}
      </div>
    </PackageContext.Provider>
  );
}
