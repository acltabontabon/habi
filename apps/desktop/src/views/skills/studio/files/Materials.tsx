/**
 * What comes with a skill — and, for those who ask, the package as files.
 *
 * Materials is the author's view: scripts, examples, references and assets,
 * each with what it is for in the instructions' own words (or its first
 * comment), and a gentle word when the instructions never point at it. Habi
 * decides where things are stored: one "Add" brings files in and files them
 * by type; pasted code becomes a script or an example; files dropped on the
 * window are placed the same way, and can be taken back.
 *
 * Opening a file turns the layer into a small editor — the code gets the
 * stage, with the other materials beside it only when there is room. The
 * package source is the developer's view: the literal tree, SKILL.md and
 * habi.yaml included, opened raw. Scripts are shown, never run.
 */
import { useQuery } from "@tanstack/react-query";
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FileMatch } from "../../../../bindings/FileMatch";
import type { LocalSkill } from "../../../../bindings/LocalSkill";
import type { SkillFileContent } from "../../../../bindings/SkillFileContent";
import type { SkillFileEntry } from "../../../../bindings/SkillFileEntry";
import { Icon } from "../../../../components/Icon";
import { Menu, type MenuItem } from "../../../../components/Menu";
import { useToast } from "../../../../components/Toasts";
import { Button, ErrorNotice } from "../../../../components/ui";
import { api, HabiError } from "../../../../lib/api";
import { plural } from "../../../../lib/format";
import { languageFor } from "../../../../lib/languages";
import {
  fileLede,
  KIND_GLYPH,
  KIND_NAME,
  KIND_ORDER,
  type Material,
  type MaterialKind,
  materialKind,
  materialsOf,
} from "../../../../lib/materials";
import {
  baseName,
  innerDir,
  NEW_FILE_SHAPES,
  type NewFileShape,
  packageTree,
  withExtension,
} from "../../../../lib/packageFiles";
import { BinaryView, FileEditor, size } from "./FileEditor";

type Creating = { shape: NewFileShape; name: string };

/** The same marks as Materials, plus the skill's own two files. */
function srcGlyph(f: SkillFileEntry): string {
  if (f.path === "SKILL.md") return "§";
  if (/^habi\.ya?ml$/.test(f.path)) return "◇";
  return KIND_GLYPH[materialKind(f.path, f.executable)];
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

const isTextEntry = (t: EventTarget | null) =>
  t instanceof Element && t.closest("input, textarea, select, [contenteditable='true'], .cm-editor") !== null;

// ----- bringing files in: dropped on the window, placed by type, undoable

/**
 * Files dropped anywhere on the Studio are added where they belong (scripts,
 * references, assets — Habi decides from what each is), then said, with a
 * way to take them back. Desktop only: a browser cannot hand over real paths.
 */
export function useDropToAdd({
  enabled,
  skill,
  beforeChange,
  onSkill,
  onError,
}: {
  enabled: boolean;
  skill: LocalSkill;
  beforeChange: () => Promise<void>;
  onSkill: (skill: LocalSkill) => void;
  onError: (e: unknown) => void;
}) {
  const [hovering, setHovering] = useState(false);
  const toast = useToast();
  const latest = useRef({ skill, beforeChange, onSkill, onError });
  latest.current = { skill, beforeChange, onSkill, onError };
  useEffect(() => {
    if (!enabled || !("__TAURI_INTERNALS__" in window)) return;
    let stop: (() => void) | undefined;
    let cancelled = false;
    void import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) =>
        getCurrentWebview()
          .onDragDropEvent((event) => {
            const p = event.payload;
            if (p.type === "enter" || p.type === "over") setHovering(true);
            else if (p.type === "leave") setHovering(false);
            else if (p.type === "drop") {
              setHovering(false);
              if (p.paths.length > 0) void add(p.paths);
            }
          })
          .then((unlisten) => {
            if (cancelled) unlisten();
            else stop = unlisten;
          }),
      )
      .catch(() => {
        // No webview to listen on (a plain browser, the dev bridge): dropping stays off.
      });
    const add = async (paths: string[]) => {
      const { skill: before, beforeChange: flush, onSkill: adopt, onError: fail } = latest.current;
      try {
        await flush();
        const fresh = await api.addDroppedSkillFiles(before.summary.id, "auto", paths);
        adopt(fresh);
        const added = fresh.files.filter((f) => !before.files.some((b) => b.path === f.path));
        const words = added.map(
          (f) => `${baseName(f.path)} (${KIND_NAME[materialKind(f.path, f.executable)].one})`,
        );
        toast.show(`Added ${words.join(", ")}.`, "ok", {
          label: "Undo",
          run: () =>
            void (async () => {
              let last: LocalSkill | null = null;
              for (const f of added) last = await api.removeSkillPath(before.summary.id, f.path);
              if (last) latest.current.onSkill(last);
            })().catch(fail),
        });
      } catch (e) {
        fail(e);
      }
    };
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [enabled, toast]);
  return hovering;
}

// ----- pasted code: offered as a script or an example

type Pasted = { text: string; language: string; ext: string; as: "script" | "example"; name: string };

function sniff(text: string): { language: string; ext: string } {
  const first = text.trimStart().split("\n", 1)[0] ?? "";
  if (/^#!.*\b(bash|sh|zsh)\b/.test(first) || /^\s*(set -e|echo |export )/m.test(text))
    return { language: "shell", ext: ".sh" };
  if (/^#!.*python/.test(first) || /^\s*(def |import |from \w+ import |print\()/m.test(text))
    return { language: "Python", ext: ".py" };
  if (/^#!.*node/.test(first) || /^\s*(const |let |function |import .* from |export )/m.test(text))
    return { language: "JavaScript", ext: ".mjs" };
  if (/^\s*[\w-]+:\s/m.test(text) && !/[;{}]/.test(text)) return { language: "YAML", ext: ".yaml" };
  return { language: "text", ext: ".txt" };
}

// ----- the materials list

function Lede({ skillId, m }: { skillId: string; m: Material }) {
  const own = useQuery({
    queryKey: ["material-lede", skillId, m.path, m.digest],
    queryFn: async () => fileLede((await api.readSkillFile(skillId, m.path)).text ?? ""),
    enabled: !m.described && m.text && m.size < 64 * 1024,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const said = m.described ?? own.data ?? null;
  return said ? <span className="mt-said">{said}</span> : null;
}

function MaterialsList({
  ref,
  skill,
  materials,
  readOnly,
  onOpen,
  onReference,
  onSource,
  addMenu,
  creating,
  pasted,
  onStart,
  onImport,
}: {
  ref: React.Ref<HTMLDivElement>;
  skill: LocalSkill;
  materials: Material[];
  readOnly: boolean;
  onOpen: (path: string) => void;
  onReference: (path: string) => void;
  onSource: () => void;
  addMenu: React.ReactNode;
  creating: React.ReactNode;
  pasted: React.ReactNode;
  /** Starts a new file of a shape (an id from NEW_FILE_SHAPES). */
  onStart: (shape: string) => void;
  onImport: () => void;
}) {
  const groups = KIND_ORDER.map((kind) => ({ kind, items: materials.filter((m) => m.kind === kind) })).filter(
    (g) => g.items.length > 0,
  );
  return (
    <div className="mt" ref={ref}>
      <header className="layer-head">
        <h2 className="layer-title">Materials</h2>
        {readOnly || materials.length === 0 ? null : addMenu}
      </header>
      {creating}
      {pasted}
      {materials.length === 0 ? (
        readOnly ? (
          <p className="mt-empty-hint">Nothing comes with it.</p>
        ) : (
          // Empty, the layer is its own menu: what can come with a skill, each one click away.
          <div className="mt-empty">
            <ul className="mt-rows">
              {(
                [
                  ["script", "Script", "with_server.py, check.sh", () => onStart("python")],
                  ["example", "Example", "a worked case to learn from", () => onStart("example")],
                  ["reference", "Reference", "architecture.md, API notes", () => onStart("reference")],
                  ["other", "Files from your machine", "placed by type", onImport],
                ] as const
              ).map(([kind, label, hint, run]) => (
                <li key={kind} className="mt-row">
                  <button type="button" className="mt-open" onClick={run}>
                    <span className={`mt-glyph is-${kind}`} aria-hidden="true">
                      {KIND_GLYPH[kind]}
                    </span>
                    <span className="mt-start">
                      {label} <span className="mt-start-hint">{hint}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <p className="mt-empty-hint">Or paste code, or drop files here.</p>
          </div>
        )
      ) : (
        groups.map((g) => (
          <section key={g.kind} className="mt-group" aria-label={KIND_NAME[g.kind].many}>
            <h3 className="mt-kind">
              {g.kind === "other"
                ? "Other"
                : g.items.length === 1
                  ? KIND_NAME[g.kind].one
                  : KIND_NAME[g.kind].many}
            </h3>
            <ul className="mt-rows">
              {g.items.map((m) => (
                <li key={m.path} className={`mt-row${m.referenced ? "" : " is-loose"}`}>
                  <button
                    type="button"
                    className="mt-open"
                    title={m.path}
                    data-path={m.path}
                    onClick={() => onOpen(m.path)}
                  >
                    <span className={`mt-glyph is-${m.kind}`} aria-hidden="true">
                      {KIND_GLYPH[m.kind]}
                    </span>
                    <span className="mt-name">{m.name}</span>
                    <Lede skillId={skill.summary.id} m={m} />
                  </button>
                  {m.referenced || g.kind === "other" ? null : (
                    <p className="mt-loose">
                      Not referenced by the instructions
                      {readOnly ? null : (
                        <button type="button" className="link-btn" onClick={() => onReference(m.path)}>
                          Reference it
                        </button>
                      )}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
      <footer className="mt-foot">
        <button type="button" className="link-quiet" onClick={onSource}>
          View package source →
        </button>
      </footer>
    </div>
  );
}

// ----- the package source: the literal tree

function SourceTree({
  skill,
  open,
  readOnly,
  onOpen,
  renaming,
  setRenaming,
  removing,
  setRemoving,
  renameField,
  confirmRemove,
  importInto,
  onStart,
  onWhen,
  addMenu,
  creating,
}: {
  skill: LocalSkill;
  open: string | null;
  readOnly: boolean;
  onOpen: (path: string, line?: number) => void;
  renaming: { from: string; to: string } | null;
  setRenaming: (r: { from: string; to: string } | null) => void;
  removing: string | null;
  setRemoving: (p: string | null) => void;
  renameField: (path: string) => React.ReactNode;
  confirmRemove: (path: string, what: string) => React.ReactNode;
  importInto: (folder: string) => void;
  onStart: (shape: string) => void;
  onWhen: () => void;
  addMenu: React.ReactNode;
  creating: React.ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [matches, setMatches] = useState<FileMatch[] | null>(null);
  const tree = useRef<HTMLElement>(null);
  const id = skill.summary.id;
  const debounced = useDebounced(query.trim(), 250);
  useEffect(() => {
    if (debounced.length < 2) {
      setMatches(null);
      return;
    }
    let stale = false;
    api
      .searchSkillFiles(id, debounced)
      .then((m) => !stale && setMatches(m))
      .catch(() => !stale && setMatches([]));
    return () => {
      stale = true;
    };
  }, [debounced, id]);
  const shown = useMemo(() => packageTree(skill.files, query), [skill.files, query]);

  const onTreeKey = (e: KeyboardEvent<HTMLElement>) => {
    const rows = [...(tree.current?.querySelectorAll<HTMLButtonElement>("[data-row]") ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    const path = (document.activeElement as HTMLElement | null)?.dataset.path;
    if (e.key === "ArrowDown" || e.key === "j") rows[Math.min(at + 1, rows.length - 1)]?.focus();
    else if (e.key === "ArrowUp" || e.key === "k") rows[Math.max(at - 1, 0)]?.focus();
    else if (e.key === "F2" && path && !readOnly && path !== "SKILL.md")
      setRenaming({ from: path, to: path });
    else if ((e.key === "Delete" || e.key === "Backspace") && path && !readOnly && path !== "SKILL.md")
      setRemoving(path);
    else return;
    e.preventDefault();
  };

  const row = (f: SkillFileEntry, depth: number) => {
    if (renaming?.from === f.path) return <li key={f.path}>{renameField(f.path)}</li>;
    const problems = skill.diagnostics.filter((d) => d.path === f.path);
    return (
      <li key={f.path}>
        <button
          type="button"
          data-row
          data-path={f.path}
          className={`src-row${open === f.path ? " is-open" : ""}`}
          style={{ paddingLeft: `${10 + depth * 16}px` }}
          aria-current={open === f.path ? "true" : undefined}
          title={f.path}
          onClick={() => onOpen(f.path)}
        >
          <span className="src-glyph" aria-hidden="true">
            {srcGlyph(f)}
          </span>
          <span className="src-name">{depth === 0 ? f.path : `${innerDir(f.path)}${baseName(f.path)}`}</span>
          {problems.length > 0 ? (
            <span className="src-problem" title={problems.map((d) => d.message).join("\n")}>
              {problems.length}
              <span className="visually-hidden"> problems</span>
            </span>
          ) : null}
        </button>
        {removing === f.path ? confirmRemove(f.path, baseName(f.path)) : null}
      </li>
    );
  };

  // The standard parts of a package that are not there yet, each one click from being made.
  const has = (prefix: string) =>
    skill.files.some((f) => f.path === prefix || f.path.startsWith(`${prefix}/`));
  const ghosts = readOnly
    ? []
    : [
        {
          path: "habi.yaml",
          glyph: "◇",
          hint: "when to suggest it",
          run: onWhen,
          here: has("habi.yaml") || has("habi.yml"),
        },
        {
          path: "scripts/",
          glyph: "▶",
          hint: "code it runs",
          run: () => onStart("python"),
          here: has("scripts"),
        },
        {
          path: "references/",
          glyph: "¶",
          hint: "docs it reads",
          run: () => onStart("reference"),
          here: has("references"),
        },
        {
          path: "assets/",
          glyph: "◫",
          hint: "templates, images",
          run: () => importInto("assets"),
          here: has("assets"),
        },
      ].filter((g) => !g.here);
  const total = skill.files.reduce((n, f) => n + f.size, 0);

  return (
    <div className="src-side">
      <header className="src-head">
        <p className="src-title">
          Package{" "}
          <span className="src-meta">
            {plural(skill.files.length, "file")} · {size(total)}
          </span>
        </p>
        {addMenu}
      </header>
      {creating}
      <label className="src-search">
        <Icon name="search" size={13} />
        <span className="visually-hidden">Find files and text</span>
        <input
          type="search"
          value={query}
          placeholder="Find in package"
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <nav className="src-tree" ref={tree} onKeyDown={onTreeKey} aria-label="Package files">
        <ul className="src-list">
          {shown.core.map((f) => row(f, 0))}
          {shown.folders.map((folder) => {
            const closed = collapsed.has(folder.name) && !query;
            return (
              <li key={folder.name}>
                {renaming?.from === folder.path ? (
                  renameField(folder.path)
                ) : (
                  <div className="src-folder">
                    <button
                      type="button"
                      data-row
                      data-path={folder.path}
                      className="src-row is-folder"
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
                      <span className="src-glyph" aria-hidden="true">
                        <Icon name={closed ? "chevronRight" : "chevronDown"} size={11} />
                      </span>
                      <span className="src-name">{folder.name}/</span>
                    </button>
                    {!readOnly ? (
                      <Menu
                        label={`Folder ${folder.name}`}
                        className="src-folder-menu"
                        items={[
                          {
                            label: "Rename folder",
                            icon: "pencil",
                            onSelect: () => setRenaming({ from: folder.path, to: folder.path }),
                          },
                          {
                            label: "Add files here…",
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
                  ? confirmRemove(
                      folder.path,
                      `${folder.name}/ and its ${plural(folder.files.length, "file")}`,
                    )
                  : null}
                {closed ? null : <ul className="src-list">{folder.files.map((f) => row(f, 1))}</ul>}
              </li>
            );
          })}
          {shown.root.map((f) => row(f, 0))}
          {query
            ? null
            : ghosts.map((g) => (
                <li key={g.path}>
                  <button
                    type="button"
                    data-row
                    className="src-row is-ghost"
                    style={{ paddingLeft: "10px" }}
                    title={`Not in the package yet — ${g.hint}`}
                    onClick={g.run}
                  >
                    <span className="src-glyph" aria-hidden="true">
                      {g.glyph}
                    </span>
                    <span className="src-name">{g.path}</span>
                    <span className="src-ghost-hint">
                      <Icon name="plus" size={11} /> {g.hint}
                    </span>
                  </button>
                </li>
              ))}
        </ul>
        {matches && matches.length > 0 ? (
          <section className="src-matches" aria-label="In the text">
            <p className="mt-kind">In the text · {matches.length}</p>
            <ul className="src-list">
              {matches.map((m) => (
                <li key={`${m.path}:${m.line}`}>
                  <button type="button" data-row className="src-match" onClick={() => onOpen(m.path, m.line)}>
                    <span className="mono src-match-where">
                      {m.path}:{m.line}
                    </span>
                    <span className="src-match-text">{m.text}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : query && shown.core.length + shown.root.length + shown.folders.length === 0 ? (
          <p className="mt-empty-hint">Nothing matches “{query}”.</p>
        ) : null}
      </nav>
    </div>
  );
}

// ----- the layer

export function Materials({
  skill,
  readOnly,
  active,
  source,
  path,
  line,
  instructions,
  beforeChange,
  onSkill,
  onPath,
  onSource,
  onReference,
  onWhen,
}: {
  skill: LocalSkill;
  readOnly: boolean;
  /** Whether the layer is on screen (pasting is taken only then). */
  active: boolean;
  /** The developer's view: the package as files. */
  source: boolean;
  /** The open file, if any, and a line to go to. */
  path: string | null;
  line?: number | null;
  /** The instructions' text: a file is findable when it is mentioned there. */
  instructions: string;
  /** Writes pending edits made elsewhere before files change. */
  beforeChange: () => Promise<void>;
  /** Called with the skill after a change; `path` names the file edited, if one. */
  onSkill: (skill: LocalSkill, path?: string) => void;
  onPath: (path: string | null, line?: number) => void;
  onSource: (on: boolean) => void;
  /** Writes a reference to a file into the instructions. */
  onReference: (path: string) => void;
  /** Goes to when Habi suggests it (habi.yaml is written from there). */
  onWhen: () => void;
}) {
  const id = skill.summary.id;
  const [open, setOpen] = useState<SkillFileContent | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [creating, setCreating] = useState<Creating | null>(null);
  const [pasted, setPasted] = useState<Pasted | null>(null);
  const [renaming, setRenaming] = useState<{ from: string; to: string } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const materials = useMemo(() => materialsOf(skill.files, instructions), [skill.files, instructions]);

  // The open file follows `path`; it is read after pending edits are written.
  // Only the latest path asked for counts: a slower answer (or failure) for one
  // passed over never shows, nor leaves another file under its name.
  const wanted = useRef<string | null>(null);
  const load = useCallback(
    async (p: string) => {
      setError(null);
      setRenaming(null);
      setRemoving(null);
      wanted.current = p;
      try {
        await beforeChange();
        const content = await api.readSkillFile(id, p);
        if (wanted.current === p) setOpen(content);
      } catch (e) {
        if (wanted.current === p) setError(e);
      }
    },
    [beforeChange, id],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: reads when the path asked for changes.
  useEffect(() => {
    wanted.current = path;
    if (!path) setOpen(null);
    else if (path !== open?.path) {
      setOpen(null);
      void load(path);
    }
  }, [path]);
  // The package source always has a file open: the skill's own, to begin with.
  useEffect(() => {
    if (source && !path) onPath("SKILL.md");
  }, [source, path, onPath]);
  // A file that disappears closes.
  useEffect(() => {
    if (path && open && !skill.files.some((f) => f.path === path)) onPath(null);
  }, [skill.files, path, open, onPath]);

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

  const create = () => {
    if (!creating) return;
    const name = withExtension(creating.name, creating.shape.ext);
    if (!name) return;
    const target = creating.shape.folder ? `${creating.shape.folder}/${name}` : name;
    const { shape } = creating;
    setCreating(null);
    void run(
      async () => {
        const created = await api.writeSkillFile(id, target, shape.body(name), null);
        return shape.executable ? api.setSkillFileExecutable(id, target, true) : created;
      },
      () => onPath(target),
    );
  };

  const savePasted = () => {
    if (!pasted) return;
    const name = withExtension(pasted.name, pasted.ext);
    if (!name) return;
    const target = `${pasted.as === "script" ? "scripts" : "examples"}/${name}`;
    const { text, as } = pasted;
    setPasted(null);
    void run(
      async () => {
        const created = await api.writeSkillFile(id, target, text.endsWith("\n") ? text : `${text}\n`, null);
        return as === "script" && /^#!/.test(text) ? api.setSkillFileExecutable(id, target, true) : created;
      },
      () => onPath(target),
    );
  };

  const rename = () => {
    if (!renaming) return;
    const to = renaming.to.trim();
    const from = renaming.from;
    setRenaming(null);
    if (!to || to === from) return;
    void run(
      () => api.renameSkillPath(id, from, to),
      () => {
        if (path === from) onPath(to);
        else if (path?.startsWith(`${from}/`)) onPath(`${to}${path.slice(from.length)}`);
      },
    );
  };

  // Removing moves focus on to the row that took its place (or Add), never to the page.
  const root = useRef<HTMLDivElement>(null);
  const [refocus, setRefocus] = useState<{ path: string | null; failed?: boolean } | null>(null);
  useEffect(() => {
    const el = root.current;
    if (!refocus || !el) return;
    if (!refocus.failed && !source && path) return; // the removed file is still closing
    setRefocus(null);
    const row = refocus.path
      ? el.querySelector<HTMLElement>(`[data-path="${CSS.escape(refocus.path)}"]`)
      : null;
    (
      row ??
      el.querySelector<HTMLElement>(
        ".mt-add .menu-trigger, .src-head .menu-trigger, .mt-open, .mt-file-actions .menu-trigger",
      )
    )?.focus();
  });
  const neighbour = (p: string) => {
    const order = source
      ? [...(root.current?.querySelectorAll<HTMLElement>("[data-path]") ?? [])].map(
          (e) => e.dataset.path ?? "",
        )
      : KIND_ORDER.flatMap((kind) => materials.filter((m) => m.kind === kind).map((m) => m.path));
    const gone = (q: string) => q === p || q.startsWith(`${p}/`);
    const at = order.findIndex(gone);
    if (at < 0) return null;
    return (
      order.slice(at + 1).find((q) => !gone(q)) ??
      order
        .slice(0, at)
        .reverse()
        .find((q) => !gone(q)) ??
      null
    );
  };

  const remove = (p: string) => {
    setRemoving(null);
    const next = neighbour(p);
    void run(
      async () => {
        try {
          return await api.removeSkillPath(id, p);
        } catch (e) {
          setRefocus({ path: p, failed: true });
          throw e;
        }
      },
      () => setRefocus({ path: next }),
    );
  };

  const importInto = (folder: string) => void run(() => api.addSkillFiles(id, folder));

  // Pasted code in the list (not in a field) is offered as a script or an example.
  useEffect(() => {
    if (!active || readOnly || path || source) return;
    const onPaste = (e: ClipboardEvent) => {
      if (isTextEntry(e.target) || document.querySelector('[role="dialog"]')) return;
      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (text.trim().split("\n").length < 2) return;
      e.preventDefault();
      const { language, ext } = sniff(text);
      setPasted({ text, language, ext, as: "script", name: "" });
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [active, readOnly, path, source]);

  const addItems: (MenuItem | MenuItem[])[] = [
    [
      {
        label: "Add files…",
        hint: "Placed by type",
        icon: "upload",
        onSelect: () => importInto("auto"),
      },
    ],
    NEW_FILE_SHAPES.filter((s) => ["python", "shell", "javascript"].includes(s.id)).map((shape) => ({
      label: `New ${shape.label.toLowerCase()}`,
      icon: "terminal" as const,
      onSelect: () => setCreating({ shape, name: "" }),
    })),
    NEW_FILE_SHAPES.filter((s) => ["reference", "example"].includes(s.id)).map((shape) => ({
      label: `New ${shape.label.toLowerCase()}`,
      icon: "file" as const,
      onSelect: () => setCreating({ shape, name: "" }),
    })),
    ...(source
      ? [
          [
            {
              label: "New blank file",
              hint: "Anywhere — use a/b.txt for folders",
              icon: "file" as const,
              onSelect: () => {
                const shape = NEW_FILE_SHAPES.find((s) => s.id === "blank");
                if (shape) setCreating({ shape, name: "" });
              },
            },
          ],
        ]
      : []),
  ];
  const addMenu = (
    <Menu
      label="Add material"
      className="mt-add"
      trigger={
        <>
          <Icon name="plus" size={13} /> Add
        </>
      }
      items={addItems}
    />
  );

  const creatingRow = creating ? (
    <form
      className="mt-create"
      onSubmit={(e) => {
        e.preventDefault();
        create();
      }}
    >
      <label className="mt-create-label" htmlFor="mt-new-name">
        New {creating.shape.label.toLowerCase()}
      </label>
      <input
        id="mt-new-name"
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
            e.stopPropagation();
            setCreating(null);
          }
        }}
      />
      <Button type="submit" size="sm" variant="primary" disabled={!creating.name.trim()}>
        Create
      </Button>
      <Button size="sm" variant="quiet" onClick={() => setCreating(null)}>
        Cancel
      </Button>
    </form>
  ) : null;

  const pastedRow = pasted ? (
    <form
      className="mt-create is-pasted"
      onSubmit={(e) => {
        e.preventDefault();
        savePasted();
      }}
    >
      <p className="mt-create-label">
        Pasted {plural(pasted.text.trim().split("\n").length, "line")} of {pasted.language}. Keep it as
      </p>
      <span className="mt-choice">
        {(["script", "example"] as const).map((as) => (
          <button
            key={as}
            type="button"
            aria-pressed={pasted.as === as}
            className={pasted.as === as ? "is-on" : undefined}
            onClick={() => setPasted({ ...pasted, as })}
          >
            {as === "script" ? "a script" : "an example"}
          </button>
        ))}
      </span>
      <label className="visually-hidden" htmlFor="mt-paste-name">
        File name
      </label>
      <input
        id="mt-paste-name"
        className="input mono"
        value={pasted.name}
        placeholder={`name${pasted.ext}`}
        spellCheck={false}
        // biome-ignore lint/a11y/noAutofocus: naming is what is left to do.
        autoFocus
        onChange={(e) => setPasted({ ...pasted, name: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            setPasted(null);
          }
        }}
      />
      <Button type="submit" size="sm" variant="primary" disabled={!pasted.name.trim()}>
        Add
      </Button>
      <Button size="sm" variant="quiet" onClick={() => setPasted(null)}>
        Discard
      </Button>
      <pre className="mt-paste-peek">{pasted.text.split("\n").slice(0, 4).join("\n")}</pre>
    </form>
  ) : null;

  const renameField = (p: string) => (
    <form
      className="src-rename"
      onSubmit={(e) => {
        e.preventDefault();
        rename();
      }}
    >
      <label className="visually-hidden" htmlFor="src-rename">
        New path for {p}
      </label>
      <input
        id="src-rename"
        className="input mono"
        value={renaming?.to ?? ""}
        spellCheck={false}
        // biome-ignore lint/a11y/noAutofocus: renaming starts in the field.
        autoFocus
        onChange={(e) => setRenaming({ from: p, to: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            setRenaming(null);
          }
        }}
        onBlur={() => setRenaming(null)}
      />
    </form>
  );

  const confirmRemove = (p: string, what: string) => (
    <div className="src-confirm" role="alert">
      <span>Remove {what}?</span>
      <Button size="sm" variant="danger" onClick={() => remove(p)}>
        Remove
      </Button>
      <Button size="sm" variant="quiet" onClick={() => setRemoving(null)}>
        Keep
      </Button>
    </div>
  );

  const errorNotice = error ? (
    <ErrorNotice
      error={error}
      title={error instanceof HabiError && error.code === "conflict" ? "Not changed" : undefined}
    />
  ) : null;

  const entry = open ? skill.files.find((f) => f.path === open.path) : undefined;
  const material = open ? materials.find((m) => m.path === open.path) : undefined;
  const fileView = open ? (
    <div className="mt-file-main">
      <header className="mt-file-head">
        <p className="mt-facts">
          {source ? (
            <>
              <span className="src-path mono" title={open.path}>
                {open.path.includes("/") ? (
                  <span className="src-path-dir">{open.path.slice(0, open.path.lastIndexOf("/") + 1)}</span>
                ) : null}
                {baseName(open.path)}
              </span>
              <span className="mt-fact">
                {open.binary ? "binary" : languageFor(open.path).replace("plain", "text")}
              </span>
            </>
          ) : material ? (
            <>
              <span className={`mt-glyph is-${material.kind}`} aria-hidden="true">
                {KIND_GLYPH[material.kind]}
              </span>
              <span>{KIND_NAME[material.kind].one.replace(/^./, (c) => c.toUpperCase())}</span>
            </>
          ) : (
            <span className="mono">{open.path}</span>
          )}
          {entry ? <span className="mt-fact">{size(entry.size)}</span> : null}
          {!source && material && material.kind !== "other" ? (
            material.referenced ? (
              <span className="mt-fact is-ok">
                <Icon name="check" size={12} /> referenced by the instructions
              </span>
            ) : (
              <span className="mt-fact is-loose">
                not referenced
                {readOnly ? null : (
                  <button type="button" className="link-btn" onClick={() => onReference(open.path)}>
                    Reference it
                  </button>
                )}
              </span>
            )
          ) : null}
        </p>
        {!readOnly ? (
          <span className="mt-file-actions">
            {open.binary && open.path !== "SKILL.md" ? (
              <Button
                size="sm"
                variant="quiet"
                icon="refresh"
                onClick={() =>
                  void run(
                    () => api.replaceSkillFile(id, open.path),
                    () => void load(open.path),
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
                    icon: "pencil",
                    disabled: open.path === "SKILL.md",
                    onSelect: () => setRenaming({ from: open.path, to: open.path }),
                  },
                  {
                    label: entry?.executable ? "Not runnable" : "Runnable by agents",
                    hint: entry?.executable ? "Clears the executable bit" : "Sets the executable bit",
                    icon: "terminal",
                    disabled: open.binary,
                    onSelect: () =>
                      void run(() => api.setSkillFileExecutable(id, open.path, !entry?.executable)),
                  },
                  {
                    label: "Open in your text editor",
                    icon: "external",
                    onSelect: () => void api.openSkillFile(id, open.path).catch((e: unknown) => setError(e)),
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
      </header>
      {renaming?.from === open.path ? renameField(open.path) : null}
      {removing === open.path ? confirmRemove(open.path, "this file") : null}
      {errorNotice}
      {open.binary || open.text === null ? (
        <BinaryView file={open} />
      ) : (
        <FileEditor
          key={`${open.path}:${open.digest}`}
          skillId={id}
          file={open}
          readOnly={readOnly}
          line={line}
          bare={source}
          onSaved={(fresh) => onSkill(fresh, open.path)}
        />
      )}
    </div>
  ) : null;

  if (source) {
    return (
      <div className="src" ref={root}>
        <SourceTree
          skill={skill}
          open={open?.path ?? null}
          readOnly={readOnly}
          onOpen={(p, l) => onPath(p, l)}
          renaming={renaming}
          setRenaming={setRenaming}
          removing={removing}
          setRemoving={setRemoving}
          renameField={renameField}
          confirmRemove={confirmRemove}
          importInto={importInto}
          onStart={(shapeId) => {
            const shape = NEW_FILE_SHAPES.find((x) => x.id === shapeId);
            if (shape) setCreating({ shape, name: "" });
          }}
          onWhen={onWhen}
          addMenu={readOnly ? null : addMenu}
          creating={creatingRow}
        />
        <div className="src-main">
          {fileView ?? errorNotice ?? <div className="src-loading" aria-hidden="true" />}
        </div>
      </div>
    );
  }

  if (path) {
    return (
      <div ref={root} className={`mt-file${materials.length > 1 ? " has-nav" : ""}`}>
        {materials.length > 1 ? (
          <nav className="mt-nav" aria-label="Materials">
            {KIND_ORDER.map((kind: MaterialKind) => {
              const items = materials.filter((m) => m.kind === kind);
              if (items.length === 0) return null;
              return (
                <section key={kind}>
                  <p className="mt-kind">
                    {kind === "other"
                      ? "Other"
                      : items.length === 1
                        ? KIND_NAME[kind].one
                        : KIND_NAME[kind].many}
                  </p>
                  <ul>
                    {items.map((m) => (
                      <li key={m.path}>
                        <button
                          type="button"
                          className={m.path === path ? "is-open" : undefined}
                          aria-current={m.path === path ? "true" : undefined}
                          title={m.path}
                          onClick={() => onPath(m.path)}
                        >
                          {m.name}
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </nav>
        ) : null}
        {fileView ?? errorNotice ?? <p className="mt-empty-hint">Opening…</p>}
      </div>
    );
  }

  return (
    <>
      {errorNotice}
      <MaterialsList
        ref={root}
        skill={skill}
        materials={materials}
        readOnly={readOnly}
        onOpen={(p) => onPath(p)}
        onReference={onReference}
        onSource={() => onSource(true)}
        addMenu={addMenu}
        creating={creatingRow}
        pasted={pastedRow}
        onStart={(id) => {
          const shape = NEW_FILE_SHAPES.find((x) => x.id === id);
          if (shape) setCreating({ shape, name: "" });
        }}
        onImport={() => importInto("auto")}
      />
    </>
  );
}
