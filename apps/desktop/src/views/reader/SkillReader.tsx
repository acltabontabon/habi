/**
 * Reading a skill: one document surface at a time, with the package beside
 * it.
 *
 * The surface shows the skill (an optional introduction, then SKILL.md) or
 * exactly one of its files — never both. The contents rail lists the
 * package as a light tree; choosing a file replaces the surface, and "←"
 * (or Esc) returns to the skill. Prose is rendered; code is shown as code,
 * highlighted and read-only. Used by libraries and by a project's item
 * detail alike.
 */
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import type { ItemFile } from "../../bindings/ItemFile";
import { Icon } from "../../components/Icon";
import { Markdown, SourceEditor } from "../../components/lazy";
import { useToast } from "../../components/Toasts";
import { ErrorNotice, Working } from "../../components/ui";
import { api } from "../../lib/api";
import { levelLabel } from "../../lib/format";
import { languageFor } from "../../lib/languages";
import { useItemDetail } from "../../lib/queries";

function size(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

function dirOf(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

/** The package as root files, then folders with their files. */
function tree(files: ItemFile[]): { folder: string; files: ItemFile[] }[] {
  const byFolder = new Map<string, ItemFile[]>();
  for (const f of files) byFolder.set(dirOf(f.path), [...(byFolder.get(dirOf(f.path)) ?? []), f]);
  const root = (byFolder.get("") ?? []).sort((a, b) =>
    a.path === "SKILL.md" ? -1 : b.path === "SKILL.md" ? 1 : a.path.localeCompare(b.path),
  );
  const folders = [...byFolder.keys()].filter((k) => k !== "").sort();
  return [
    { folder: "", files: root },
    ...folders.map((folder) => ({
      folder,
      files: (byFolder.get(folder) ?? []).sort((a, b) => a.path.localeCompare(b.path)),
    })),
  ];
}

function ContentsTree({
  files,
  current,
  main,
  onOpen,
}: {
  files: ItemFile[];
  /** The open file, or `null` for the main document. */
  current: string | null;
  /** The main document's file (SKILL.md, or the instructions file). */
  main: string;
  onOpen: (path: string | null) => void;
}) {
  return (
    <nav className="contents" aria-label="Package contents">
      {tree(files).map(({ folder, files: members }) => (
        <div key={folder || "root"} className="contents-group">
          {folder ? <p className="contents-folder mono">{folder}/</p> : null}
          <ul>
            {members.map((f, i) => {
              const isMain = f.path === main;
              const active = isMain ? current === null : current === f.path;
              const name = folder ? f.path.slice(folder.length + 1) : f.path;
              return (
                <li key={f.path}>
                  <button
                    type="button"
                    className={`contents-file${active ? " is-active" : ""}`}
                    aria-current={active ? "page" : undefined}
                    onClick={() => onOpen(isMain ? null : f.path)}
                  >
                    {folder ? (
                      <span className="contents-branch" aria-hidden="true">
                        {i === members.length - 1 ? "└" : "├"}
                      </span>
                    ) : null}
                    <span className="contents-name mono">{name}</span>
                    {f.executable ? <Icon name="terminal" size={12} /> : null}
                    <span className="contents-size mono">{size(f.size)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

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

export function SkillReader({
  sourceId,
  itemId,
  file,
  onFile,
  intro,
  title,
}: {
  sourceId: string;
  itemId: string;
  /** The file being read, or `null` for the skill itself. */
  file: string | null;
  onFile: (path: string | null) => void;
  /** Shown above the skill's document (not above a file). */
  intro?: ReactNode;
  /** The skill's name, for the way back from a file. */
  title: string;
}) {
  const detail = useItemDetail(sourceId, itemId);

  // Esc returns from a file to the skill, unless typing somewhere.
  useEffect(() => {
    if (file === null) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (e.key !== "Escape" || target?.closest("input, textarea, [contenteditable], [role=dialog]")) return;
      onFile(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [file, onFile]);

  if (detail.isPending) return <Working>Reading the skill…</Working>;
  if (detail.isError) return <ErrorNotice error={detail.error} />;
  const { item, body } = detail.data;
  const paths = item.files.map((f) => f.path);
  const main = item.kind === "instructions" ? (item.files[0]?.path ?? "") : "SKILL.md";
  const open = (path: string) => onFile(path === main ? null : path);

  return (
    <div className="reader">
      <article className="reader-main">
        {file === null ? (
          <>
            {intro}
            <div className="reader-doc">
              <Markdown text={body} files={paths} onLocalLink={open} />
            </div>
          </>
        ) : (
          <>
            <header className="reader-crumb">
              <button type="button" className="reader-back" onClick={() => onFile(null)}>
                <Icon name="arrowLeft" size={14} />
                {title}
              </button>
              <h2 className="reader-file mono">{file}</h2>
            </header>
            <FileReader sourceId={sourceId} itemId={itemId} path={file} files={paths} onLocalLink={open} />
          </>
        )}
      </article>
      <aside className="reader-rail">
        <p className="kicker">Contents</p>
        <ContentsTree files={item.files} current={file} main={main} onOpen={onFile} />
        {item.diagnostics.length > 0 ? (
          <details className="reader-notes">
            <summary>
              {item.diagnostics.length} {item.diagnostics.length === 1 ? "note" : "notes"} from reading it
            </summary>
            <ul>
              {item.diagnostics.map((d, i) => (
                <li key={i}>
                  <strong>{levelLabel(d.level)}</strong>{" "}
                  {d.path ? <span className="mono">{d.path}: </span> : null}
                  {d.message}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </aside>
    </div>
  );
}
