/**
 * The package as a small workspace: a compact explorer beside the open file.
 *
 * SKILL.md and habi.yaml open where they are written (the instructions and
 * the rules), so one file never has two editors. Everything else opens here:
 * text with highlighting and its own autosave, images as previews. One "New
 * file" action starts a script, a reference or a blank file with a sensible
 * shape; files can be imported with the native picker or dropped onto the
 * window (only what was actually dropped is taken, and nothing is replaced).
 * Search finds file names as you type and text inside files. Scripts are
 * shown, never run.
 */
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FileMatch } from "../../../../bindings/FileMatch";
import type { LocalSkill } from "../../../../bindings/LocalSkill";
import type { SkillFileContent } from "../../../../bindings/SkillFileContent";
import type { SkillFileEntry } from "../../../../bindings/SkillFileEntry";
import { Icon } from "../../../../components/Icon";
import { Menu, type MenuItem } from "../../../../components/Menu";
import { Button, ErrorNotice } from "../../../../components/ui";
import { api, HabiError } from "../../../../lib/api";
import {
  baseName,
  innerDir,
  kindOf,
  NEW_FILE_SHAPES,
  type NewFileShape,
  packageTree,
  withExtension,
} from "../../../../lib/packageFiles";
import type { StudioMode } from "../../../../lib/studioNav";
import type { SaveState } from "../../../../lib/useAutosave";
import { BinaryView, FileEditor } from "./FileEditor";

type Creating = { shape: NewFileShape; name: string };
type Dropped = { paths: string[]; folder: string };

const IMPORT_FOLDERS = [
  { folder: "references", label: "references/" },
  { folder: "assets", label: "assets/" },
  { folder: "scripts", label: "scripts/" },
  { folder: "", label: "the package root" },
];

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function FilesMode({
  skill,
  readOnly,
  active,
  broken,
  request,
  beforeChange,
  onSkill,
  onGoTo,
  onOpenChange,
}: {
  skill: LocalSkill;
  readOnly: boolean;
  /** Whether the mode is on screen (drops are taken only then). */
  active: boolean;
  /** SKILL.md cannot be parsed, so it is repaired here as plain text. */
  broken: boolean;
  /** A file (and line) to open, asked for from elsewhere in the Studio. */
  request?: { path: string; line?: number; nonce: number } | null;
  /** Writes pending edits made elsewhere before files change. */
  beforeChange: () => Promise<void>;
  /** Called with the skill after a change; `path` names the file edited, if one. */
  onSkill: (skill: LocalSkill, path?: string) => void;
  onGoTo: (mode: StudioMode) => void;
  onOpenChange: (path: string | null) => void;
}) {
  const id = skill.summary.id;
  const [open, setOpen] = useState<SkillFileContent | null>(null);
  const [openLine, setOpenLine] = useState<number | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState<Creating | null>(null);
  const [renaming, setRenaming] = useState<{ from: string; to: string } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [states, setStates] = useState<Record<string, SaveState>>({});
  const [hovering, setHovering] = useState(false);
  const [dropped, setDropped] = useState<Dropped | null>(null);
  const [matches, setMatches] = useState<FileMatch[] | null>(null);
  const wanted = useRef<string | null>(null);
  const tree = useRef<HTMLElement>(null);

  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;
  useEffect(() => {
    onOpenChangeRef.current(open?.path ?? null);
  }, [open?.path]);

  const select = useCallback(
    async (path: string, line?: number) => {
      // The instructions and the rules are written in their own modes.
      if (!broken && kindOf(path) === "instructions") return onGoTo("instructions");
      if (kindOf(path) === "rules") return onGoTo("rules");
      setError(null);
      setRenaming(null);
      setRemoving(null);
      wanted.current = path;
      try {
        await beforeChange();
        const content = await api.readSkillFile(id, path);
        if (wanted.current === path) {
          setOpen(content);
          setOpenLine(line ?? null);
        }
      } catch (e) {
        setError(e);
      }
    },
    [beforeChange, broken, id, onGoTo],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: opens once per request.
  useEffect(() => {
    if (request) void select(request.path, request.line);
  }, [request?.nonce]);

  // Keep the open file in step when it disappears.
  useEffect(() => {
    if (open && !skill.files.some((f) => f.path === open.path)) setOpen(null);
  }, [skill.files, open]);

  const run = async (action: () => Promise<LocalSkill | null>, then?: (skill: LocalSkill) => void) => {
    setError(null);
    try {
      await beforeChange();
      const fresh = await action();
      if (fresh) {
        onSkill(fresh);
        then?.(fresh);
      }
    } catch (e) {
      setError(e);
    }
  };

  // ----- search: names as typed, text after a pause

  const debounced = useDebounced(query.trim(), 250);
  useEffect(() => {
    if (debounced.length < 2) {
      setMatches(null);
      return;
    }
    let stale = false;
    api
      .searchSkillFiles(id, debounced)
      .then((m) => {
        if (!stale) setMatches(m);
      })
      .catch(() => {
        if (!stale) setMatches([]);
      });
    return () => {
      stale = true;
    };
  }, [debounced, id]);

  // ----- create, rename, remove

  const create = () => {
    if (!creating) return;
    const name = withExtension(creating.name, creating.shape.ext);
    if (!name) return;
    const path = creating.shape.folder ? `${creating.shape.folder}/${name}` : name;
    const { shape } = creating;
    setCreating(null);
    void run(
      async () => {
        const created = await api.writeSkillFile(id, path, shape.body(name), null);
        return shape.executable ? api.setSkillFileExecutable(id, path, true) : created;
      },
      () => void select(path),
    );
  };

  const rename = () => {
    if (!renaming) return;
    const to = renaming.to.trim();
    const from = renaming.from;
    setRenaming(null);
    if (!to || to === from) return;
    const wasOpen = open?.path;
    void run(
      () => api.renameSkillPath(id, from, to),
      () => {
        if (wasOpen === from) void select(to);
        else if (wasOpen?.startsWith(`${from}/`)) void select(`${to}${wasOpen.slice(from.length)}`);
      },
    );
  };

  const remove = (path: string) => {
    setRemoving(null);
    void run(() => api.removeSkillPath(id, path));
  };

  const importInto = (folder: string) => void run(() => api.addSkillFiles(id, folder));

  // ----- dropping files onto the window (desktop only)

  useEffect(() => {
    if (!active || readOnly || !("__TAURI_INTERNALS__" in window)) return;
    let stop: (() => void) | undefined;
    let cancelled = false;
    void import("@tauri-apps/api/webview").then(({ getCurrentWebview }) =>
      getCurrentWebview()
        .onDragDropEvent((event) => {
          const p = event.payload;
          if (p.type === "enter" || p.type === "over") setHovering(true);
          else if (p.type === "leave") setHovering(false);
          else if (p.type === "drop") {
            setHovering(false);
            if (p.paths.length > 0) setDropped({ paths: p.paths, folder: "references" });
          }
        })
        .then((unlisten) => {
          if (cancelled) unlisten();
          else stop = unlisten;
        }),
    );
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [active, readOnly]);

  const addDropped = () => {
    if (!dropped) return;
    const { paths, folder } = dropped;
    setDropped(null);
    void run(() => api.addDroppedSkillFiles(id, folder, paths));
  };

  // ----- the explorer

  const shown = useMemo(() => packageTree(skill.files, query), [skill.files, query]);
  const problems = (path: string) => skill.diagnostics.filter((d) => d.path === path);

  const onTreeKey = (e: KeyboardEvent<HTMLElement>) => {
    const rows = [...(tree.current?.querySelectorAll<HTMLButtonElement>("[data-row]") ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    const path = (document.activeElement as HTMLElement | null)?.dataset.path;
    if (e.key === "ArrowDown" || e.key === "j") rows[Math.min(at + 1, rows.length - 1)]?.focus();
    else if (e.key === "ArrowUp" || e.key === "k") rows[Math.max(at - 1, 0)]?.focus();
    else if (e.key === "Home") rows[0]?.focus();
    else if (e.key === "End") rows[rows.length - 1]?.focus();
    else if (e.key === "F2" && path && !readOnly && kindOf(path) !== "instructions")
      setRenaming({ from: path, to: path });
    else if ((e.key === "Delete" || e.key === "Backspace") && path && !readOnly && path !== "SKILL.md")
      setRemoving(path);
    else return;
    e.preventDefault();
  };

  const newItems: (MenuItem | MenuItem[])[] = [
    NEW_FILE_SHAPES.filter((s) => s.folder === "scripts").map((shape) => ({
      label: shape.label,
      hint: shape.hint,
      icon: "terminal" as const,
      onSelect: () => setCreating({ shape, name: "" }),
    })),
    NEW_FILE_SHAPES.filter((s) => s.folder !== "scripts").map((shape) => ({
      label: shape.label,
      hint: shape.hint,
      icon: "file" as const,
      onSelect: () => setCreating({ shape, name: "" }),
    })),
    [
      {
        label: "Import an asset…",
        hint: "assets/ · images, templates, data",
        icon: "upload" as const,
        onSelect: () => importInto("assets"),
      },
      {
        label: "Import files…",
        hint: "references/ · or drop files onto the window",
        icon: "upload" as const,
        onSelect: () => importInto("references"),
      },
    ],
  ];

  const renameField = (path: string) => (
    <form
      className="fx-rename"
      onSubmit={(e) => {
        e.preventDefault();
        rename();
      }}
    >
      <label className="visually-hidden" htmlFor="fx-rename">
        New path for {path}
      </label>
      <input
        id="fx-rename"
        className="input mono"
        value={renaming?.to ?? ""}
        spellCheck={false}
        // biome-ignore lint/a11y/noAutofocus: renaming starts in the field.
        autoFocus
        onChange={(e) => setRenaming({ from: path, to: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            setRenaming(null);
          }
        }}
        onBlur={() => setRenaming(null)}
      />
    </form>
  );

  const confirmRemove = (path: string, what: string) => (
    <div className="fx-confirm" role="alert">
      <span>Remove {what}?</span>
      <Button size="sm" variant="danger" onClick={() => remove(path)}>
        Remove
      </Button>
      <Button size="sm" variant="quiet" onClick={() => setRemoving(null)}>
        Keep
      </Button>
    </div>
  );

  const fileRow = (f: SkillFileEntry, depth: number) => {
    const p = problems(f.path);
    const blocking = p.some((d) => d.level === "error");
    const state = states[f.path];
    const kind = kindOf(f.path, f.executable);
    const routed = (kind === "instructions" && !broken) || kind === "rules";
    const name = depth === 0 ? f.path : `${innerDir(f.path)}${baseName(f.path)}`;
    if (renaming?.from === f.path) return <li key={f.path}>{renameField(f.path)}</li>;
    return (
      <li key={f.path}>
        <button
          type="button"
          data-row
          data-path={f.path}
          className={`fx-row${open?.path === f.path ? " is-open" : ""}`}
          style={{ paddingLeft: `${8 + depth * 14}px` }}
          aria-current={open?.path === f.path ? "true" : undefined}
          title={f.path}
          onClick={() => void select(f.path)}
        >
          <Icon name={kind === "script" ? "terminal" : kind === "rules" ? "thread" : "file"} size={13} />
          <span className="fx-name">{name}</span>
          {routed ? (
            <span className="fx-route">{kind === "instructions" ? "instructions" : "rules"} →</span>
          ) : null}
          {state === "pending" || state === "saving" ? (
            <span className="fx-dot" title="Saving">
              <span className="visually-hidden">unsaved changes</span>
            </span>
          ) : null}
          {p.length > 0 ? (
            <span className={`fx-badge tone-${blocking ? "danger" : "warn"}`}>
              {p.length}
              <span className="visually-hidden">{blocking ? " problems to fix" : " things to improve"}</span>
            </span>
          ) : null}
        </button>
        {removing === f.path ? confirmRemove(f.path, baseName(f.path)) : null}
      </li>
    );
  };

  const nothing = shown.core.length + shown.root.length + shown.folders.length === 0;

  return (
    <div className={`fx${open ? " is-viewing" : ""}${hovering ? " is-dropping" : ""}`}>
      <div className="fx-explorer">
        <div className="fx-tools">
          <label className="fx-search">
            <Icon name="search" size={13} />
            <span className="visually-hidden">Find files and text</span>
            <input
              type="search"
              value={query}
              placeholder="Find files and text"
              spellCheck={false}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          {!readOnly ? (
            <Menu
              label="New file"
              trigger={
                <>
                  <Icon name="plus" size={13} /> New
                </>
              }
              items={newItems}
            />
          ) : null}
        </div>

        {creating ? (
          <form
            className="fx-create"
            onSubmit={(e) => {
              e.preventDefault();
              create();
            }}
          >
            <p className="fx-create-title">{creating.shape.label}</p>
            <div className="fx-create-row">
              {creating.shape.folder ? <span className="mono muted">{creating.shape.folder}/</span> : null}
              <label className="visually-hidden" htmlFor="fx-new-name">
                File name
              </label>
              <input
                id="fx-new-name"
                className="input mono"
                value={creating.name}
                placeholder={creating.shape.ext ? `name${creating.shape.ext}` : "name"}
                spellCheck={false}
                // biome-ignore lint/a11y/noAutofocus: naming is the only thing to do after choosing a kind.
                autoFocus
                onChange={(e) => setCreating({ ...creating, name: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setCreating(null);
                  }
                }}
              />
            </div>
            <div className="fx-create-row">
              <Button type="submit" size="sm" variant="primary" disabled={!creating.name.trim()}>
                Create
              </Button>
              <Button size="sm" variant="quiet" onClick={() => setCreating(null)}>
                Cancel
              </Button>
            </div>
          </form>
        ) : null}

        {dropped ? (
          <div className="fx-dropped" role="alert">
            <p>
              Add{" "}
              {dropped.paths.length === 1
                ? baseName(dropped.paths[0] ?? "")
                : `${dropped.paths.length} files`}{" "}
              to
            </p>
            <select
              className="input"
              aria-label="Folder to add the dropped files to"
              value={dropped.folder}
              onChange={(e) => setDropped({ ...dropped, folder: e.target.value })}
            >
              {IMPORT_FOLDERS.map((f) => (
                <option key={f.folder} value={f.folder}>
                  {f.label}
                </option>
              ))}
            </select>
            <div className="fx-create-row">
              <Button size="sm" variant="primary" onClick={addDropped}>
                Add
              </Button>
              <Button size="sm" variant="quiet" onClick={() => setDropped(null)}>
                Cancel
              </Button>
            </div>
            <p className="rb-note">Copied into the skill; nothing is replaced and nothing runs.</p>
          </div>
        ) : null}

        {error ? (
          <ErrorNotice
            error={error}
            title={error instanceof HabiError && error.code === "conflict" ? "Not changed" : undefined}
          />
        ) : null}

        <nav className="fx-tree" ref={tree} onKeyDown={onTreeKey} aria-label="Package files">
          {nothing && matches !== null && matches.length === 0 ? (
            <p className="rb-note">Nothing matches “{query}”.</p>
          ) : null}
          <ul className="fx-list">
            {shown.core.map((f) => fileRow(f, 0))}
            {shown.folders.map((folder) => {
              const closed = collapsed.has(folder.name) && !query;
              return (
                <li key={folder.name} className="fx-folder">
                  {renaming?.from === folder.path ? (
                    renameField(folder.path)
                  ) : (
                    <div className="fx-folder-head">
                      <button
                        type="button"
                        data-row
                        data-path={folder.path}
                        className="fx-row is-folder"
                        aria-expanded={!closed}
                        onClick={() =>
                          setCollapsed((c) => {
                            const next = new Set(c);
                            if (next.has(folder.name)) next.delete(folder.name);
                            else next.add(folder.name);
                            return next;
                          })
                        }
                      >
                        <Icon name={closed ? "chevronRight" : "chevronDown"} size={12} />
                        <span className="fx-name">{folder.name}/</span>
                        <span className="fx-count">{folder.files.length}</span>
                      </button>
                      {!readOnly ? (
                        <Menu
                          label={`Folder ${folder.name}`}
                          className="fx-folder-menu"
                          items={[
                            {
                              label: "Rename folder",
                              icon: "pencil",
                              onSelect: () => setRenaming({ from: folder.path, to: folder.path }),
                            },
                            {
                              label: "Import files here…",
                              icon: "upload",
                              disabled: !["scripts", "references", "assets"].includes(folder.name),
                              onSelect: () => importInto(folder.name),
                            },
                            {
                              label: "Remove folder",
                              icon: "trash",
                              danger: true,
                              onSelect: () => setRemoving(folder.path),
                            },
                          ]}
                        />
                      ) : null}
                    </div>
                  )}
                  {removing === folder.path
                    ? confirmRemove(folder.path, `${folder.name}/ and its ${folder.files.length} files`)
                    : null}
                  {closed ? null : <ul className="fx-list">{folder.files.map((f) => fileRow(f, 1))}</ul>}
                </li>
              );
            })}
            {shown.root.map((f) => fileRow(f, 0))}
          </ul>
          {matches && matches.length > 0 ? (
            <section className="fx-matches" aria-label="In the text">
              <p className="kicker">In the text · {matches.length}</p>
              <ul className="fx-list">
                {matches.map((m) => (
                  <li key={`${m.path}:${m.line}`}>
                    <button
                      type="button"
                      data-row
                      className="fx-match"
                      onClick={() =>
                        kindOf(m.path) === "instructions" && !broken
                          ? onGoTo("instructions")
                          : void select(m.path, m.line)
                      }
                    >
                      <span className="mono fx-match-where">
                        {m.path}:{m.line}
                      </span>
                      <span className="fx-match-text">{m.text}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </nav>
        {!readOnly ? <p className="fx-drop-hint">Drop files onto the window to add them.</p> : null}
      </div>

      <div className="fx-view">
        {open ? (
          <>
            <div className="fx-view-head">
              <button type="button" className="fx-back" onClick={() => setOpen(null)}>
                <Icon name="arrowLeft" size={13} /> Files
              </button>
              <p className="fx-path mono" title={open.path}>
                {open.path.includes("/") ? (
                  <span className="fx-path-dir">{open.path.slice(0, open.path.lastIndexOf("/") + 1)}</span>
                ) : null}
                <span>{baseName(open.path)}</span>
              </p>
              {!readOnly ? (
                <span className="fx-view-actions">
                  {open.binary && open.path !== "SKILL.md" ? (
                    <Button
                      size="sm"
                      variant="quiet"
                      icon="refresh"
                      onClick={() =>
                        void run(
                          () => api.replaceSkillFile(id, open.path),
                          () => void select(open.path),
                        )
                      }
                    >
                      Replace…
                    </Button>
                  ) : null}
                  <Menu
                    label={`More for ${baseName(open.path)}`}
                    items={[
                      [
                        {
                          label: "Rename or move",
                          hint: "F2 in the file list",
                          icon: "pencil",
                          disabled: open.path === "SKILL.md",
                          onSelect: () => setRenaming({ from: open.path, to: open.path }),
                        },
                        {
                          label: skill.files.find((f) => f.path === open.path)?.executable
                            ? "Mark as not executable"
                            : "Mark as executable",
                          hint: "For scripts an agent runs directly",
                          icon: "terminal",
                          disabled: open.binary,
                          onSelect: () =>
                            void run(() =>
                              api.setSkillFileExecutable(
                                id,
                                open.path,
                                !skill.files.find((f) => f.path === open.path)?.executable,
                              ),
                            ),
                        },
                        {
                          label: "Open in your text editor",
                          icon: "external",
                          onSelect: () =>
                            void api.openSkillFile(id, open.path).catch((e: unknown) => setError(e)),
                        },
                      ],
                      [
                        {
                          label: "Remove",
                          icon: "trash",
                          danger: true,
                          disabled: open.path === "SKILL.md",
                          onSelect: () => setRemoving(open.path),
                        },
                      ],
                    ]}
                  />
                </span>
              ) : null}
            </div>
            {renaming?.from === open.path ? renameField(open.path) : null}
            {removing === open.path ? confirmRemove(open.path, "this file") : null}
            {open.binary || open.text === null ? (
              <BinaryView file={open} />
            ) : (
              <FileEditor
                key={`${open.path}:${open.digest}`}
                skillId={id}
                file={open}
                readOnly={readOnly}
                line={openLine}
                onSaved={(fresh) => onSkill(fresh, open.path)}
                onState={(path, state) => setStates((s) => (s[path] === state ? s : { ...s, [path]: state }))}
              />
            )}
          </>
        ) : (
          <div className="fx-empty">
            <p className="fx-empty-title">A skill is a folder</p>
            <dl className="fx-layout">
              <dt className="mono">SKILL.md</dt>
              <dd>the instructions — all a skill needs</dd>
              <dt className="mono">scripts/</dt>
              <dd>code an agent may run. Habi stores it and never runs it</dd>
              <dt className="mono">references/</dt>
              <dd>documents the instructions point to, read when needed</dd>
              <dt className="mono">assets/</dt>
              <dd>templates, images and files used in the output</dd>
            </dl>
            <p className="rb-note">Choose a file to read or edit it, or start one with New.</p>
          </div>
        )}
      </div>
    </div>
  );
}
