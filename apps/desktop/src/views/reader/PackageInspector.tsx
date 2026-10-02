/**
 * What comes with a skill, beside it rather than in place of it.
 *
 * The inspector says what the package is before listing it: the files at
 * its root, its languages when it has language folders side by side, its
 * other folders with their counts, and the files an agent could run. Each
 * group unfolds on its own; a filter appears for large packages. Choosing a
 * file replaces the reading surface; the inspector stays as it was.
 */
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import type { ItemFile } from "../../bindings/ItemFile";
import { Icon } from "../../components/Icon";
import { plural } from "../../lib/format";
import { isCode, type PackageGroup, type PackageShape } from "../../lib/skillFacts";

export type Reveal = { kind: "code" } | { kind: "folder"; folder: string };

function size(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
}

/** Large groups start folded; small packages are simply listed. */
const OPEN_ALL_BELOW = 16;
const FILTER_FROM = 14;

function FileRow({
  file,
  label,
  active,
  onOpen,
}: {
  file: ItemFile;
  label: string;
  active: boolean;
  onOpen: () => void;
}) {
  const code = isCode(file);
  const slash = label.lastIndexOf("/");
  return (
    <li>
      <button
        type="button"
        data-nav
        className={`pkg-file${active ? " is-active" : ""}`}
        aria-current={active ? "page" : undefined}
        title={file.path}
        onClick={onOpen}
      >
        <span className="pkg-file-name mono">
          {slash >= 0 ? (
            <span className="pkg-file-dir">
              {label
                .slice(0, slash)
                .split("/")
                .map((part, i) => (
                  <span key={i}>
                    {part}/<wbr />
                  </span>
                ))}
            </span>
          ) : null}
          {label.slice(slash + 1)}
        </span>
        {code ? (
          <span className="pkg-file-runs" title="An agent could run this file">
            <Icon name="terminal" size={12} />
            <span className="visually-hidden">runs</span>
          </span>
        ) : null}
        <span className="pkg-file-size mono">{size(file.size)}</span>
      </button>
    </li>
  );
}

function Files({
  files,
  base,
  current,
  onOpen,
}: {
  files: ItemFile[];
  /** Folder prefix to leave out of each name. */
  base: string;
  current: string | null;
  onOpen: (path: string) => void;
}) {
  return (
    <ul className="pkg-files">
      {files.map((f) => (
        <FileRow
          key={f.path}
          file={f}
          label={base ? f.path.slice(base.length + 1) : f.path}
          active={current === f.path}
          onOpen={() => onOpen(f.path)}
        />
      ))}
    </ul>
  );
}

function FolderGroup({
  group,
  open,
  onToggle,
  current,
  onOpen,
}: {
  group: PackageGroup;
  open: boolean;
  onToggle: () => void;
  current: string | null;
  onOpen: (path: string) => void;
}) {
  const id = `pkg-folder-${group.folder.replace(/[^a-z0-9_-]/gi, "_")}`;
  return (
    <li className={`pkg-folder${open ? " is-open" : ""}`} data-group={group.folder}>
      <button
        type="button"
        data-nav
        className="pkg-folder-toggle"
        aria-expanded={open}
        aria-controls={id}
        onClick={onToggle}
        onKeyDown={(e) => {
          if ((e.key === "ArrowRight" && !open) || (e.key === "ArrowLeft" && open)) {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <Icon name={open ? "chevronDown" : "chevronRight"} size={12} />
        <span className="pkg-folder-name mono">{group.folder}/</span>
        <span className="pkg-folder-count mono">
          {group.files.length}
          {group.code > 0 ? <span className="pkg-folder-runs"> · {group.code} run</span> : null}
        </span>
      </button>
      {open ? (
        <div id={id}>
          <Files files={group.files} base={group.folder} current={current} onOpen={onOpen} />
        </div>
      ) : null}
    </li>
  );
}

export function PackageInspector({
  shape,
  current,
  main,
  community,
  reveal,
  onOpen,
  onClose,
}: {
  shape: PackageShape;
  /** The file being read, or `null` for the main document. */
  current: string | null;
  main: string;
  community: boolean;
  /** A request to bring one part of the package forward. */
  reveal: (Reveal & { at: number }) | null;
  onOpen: (path: string | null) => void;
  onClose: () => void;
}) {
  const small = shape.count < OPEN_ALL_BELOW;
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(small ? [...shape.languages, ...shape.folders].map((g) => g.folder) : []),
  );
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLElement>(null);
  const open = (path: string) => onOpen(path === main ? null : path);
  const toggle = (folder: string) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(folder)) next.delete(folder);
      else next.add(folder);
      return next;
    });

  // The file being read is always visible: unfold its folder.
  useEffect(() => {
    if (!current?.includes("/")) return;
    const top = current.slice(0, current.indexOf("/"));
    setExpanded((s) => (s.has(top) ? s : new Set(s).add(top)));
  }, [current]);

  useEffect(() => {
    if (!reveal) return;
    const target = reveal.kind === "code" ? "@code" : reveal.folder;
    if (reveal.kind === "folder" && reveal.folder) setExpanded((s) => new Set(s).add(reveal.folder));
    requestAnimationFrame(() => {
      // An empty folder means the package as a whole: its first entry.
      const el = target
        ? ref.current?.querySelector<HTMLElement>(`[data-group="${CSS.escape(target)}"]`)
        : ref.current;
      el?.scrollIntoView?.({ block: "nearest" });
      el?.querySelector<HTMLElement>("[data-nav]")?.focus();
    });
  }, [reveal]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return [...shape.root, ...shape.languages, ...shape.folders]
      .flatMap((g) => ("files" in g ? g.files : [g]))
      .filter((f) => f.path.toLowerCase().includes(q));
  }, [query, shape]);

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Escape") {
      if (query && e.target instanceof HTMLInputElement) {
        e.preventDefault();
        e.stopPropagation();
        setQuery("");
      }
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const nav = [...(ref.current?.querySelectorAll<HTMLElement>("[data-nav]") ?? [])];
    const index = nav.indexOf(document.activeElement as HTMLElement);
    const next = nav[Math.max(0, Math.min(nav.length - 1, index + (e.key === "ArrowDown" ? 1 : -1)))];
    if (!next) return;
    e.preventDefault();
    next.focus();
  };

  const languageFiles = shape.languages.filter((g) => expanded.has(g.folder));

  return (
    <section className="pkg" aria-label="Package contents" ref={ref} onKeyDown={onKeyDown}>
      <header className="pkg-head">
        <p className="kicker">Package</p>
        <button
          type="button"
          className="icon-btn pkg-close"
          onClick={onClose}
          title="Close the package (Esc)"
          aria-label="Close the package"
        >
          <Icon name="close" size={14} />
        </button>
        <p className="pkg-summary mono">
          {plural(shape.count, "file")}
          {shape.languages.length > 0 ? ` · ${shape.languages.length} languages` : ""}
        </p>
      </header>

      {shape.count >= FILTER_FROM ? (
        <div className="pkg-filter">
          <Icon name="search" size={12} />
          <label className="visually-hidden" htmlFor="pkg-filter">
            Filter files
          </label>
          <input
            id="pkg-filter"
            type="search"
            data-nav
            placeholder={`Filter ${shape.count} files`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      ) : null}

      {matches ? (
        matches.length > 0 ? (
          <Files files={matches} base="" current={current ?? main} onOpen={open} />
        ) : (
          <p className="pkg-note">No file matches.</p>
        )
      ) : (
        <>
          <Files files={shape.root} base="" current={current ?? main} onOpen={open} />

          {shape.languages.length > 0 ? (
            <div className="pkg-section">
              <p className="pkg-label">Languages</p>
              <div className="pkg-keys">
                {shape.languages.map((g) => (
                  <button
                    key={g.folder}
                    type="button"
                    data-nav
                    className="pkg-key"
                    aria-pressed={expanded.has(g.folder)}
                    title={`${g.folder}/ · ${plural(g.files.length, "file")}`}
                    onClick={() => toggle(g.folder)}
                  >
                    {g.label}
                  </button>
                ))}
              </div>
              {languageFiles.length > 0 ? (
                <ul className="pkg-groups">
                  {languageFiles.map((g) => (
                    <FolderGroup
                      key={g.folder}
                      group={g}
                      open
                      onToggle={() => toggle(g.folder)}
                      current={current}
                      onOpen={open}
                    />
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          {shape.folders.length > 0 ? (
            <div className="pkg-section">
              {shape.languages.length > 0 ? <p className="pkg-label">Also</p> : null}
              <ul className="pkg-groups">
                {shape.folders.map((g) => (
                  <FolderGroup
                    key={g.folder}
                    group={g}
                    open={expanded.has(g.folder)}
                    onToggle={() => toggle(g.folder)}
                    current={current}
                    onOpen={open}
                  />
                ))}
              </ul>
            </div>
          ) : null}

          {shape.code.length > 0 ? (
            <div className="pkg-section pkg-runs" data-group="@code">
              <p className="pkg-label">
                <Icon name="terminal" size={12} /> Runs
              </p>
              <p className="pkg-note">
                {shape.code.length === 1 ? "One file" : `${shape.code.length} files`} an agent could run once
                the skill is installed. Habi never runs them.{" "}
                {community ? "Not reviewed by your team — read them before use." : "Read them before use."}
              </p>
              <Files files={shape.code} base="" current={current} onOpen={open} />
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
