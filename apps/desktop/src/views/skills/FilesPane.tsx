/**
 * The package as real files: SKILL.md, the optional habi.yaml, and
 * scripts, references and assets in the standard layout — plus any other
 * folders an imported package brought along. Text files are edited here with
 * highlighting; images are previewed. Scripts are stored, never run.
 */
import { useEffect, useRef, useState } from "react";
import type { Diagnostic } from "../../bindings/Diagnostic";
import type { LocalSkill } from "../../bindings/LocalSkill";
import type { SkillFileContent } from "../../bindings/SkillFileContent";
import type { SkillFileEntry } from "../../bindings/SkillFileEntry";
import { Icon } from "../../components/Icon";
import { Markdown, SourceEditor } from "../../components/lazy";
import { SaveIndicator } from "../../components/SaveIndicator";
import { Button, ErrorNotice, Notice } from "../../components/ui";
import { api, HabiError } from "../../lib/api";
import { languageFor } from "../../lib/languages";
import { useAutosave } from "../../lib/useAutosave";

type Kind = "script" | "reference" | "asset" | "other";

const KINDS: { id: Kind; label: string; folder: string; hint: string; placeholder: string }[] = [
  {
    id: "script",
    label: "Script",
    folder: "scripts",
    hint: "Code the agent may run. Habi stores it and never runs it.",
    placeholder: "check.sh",
  },
  {
    id: "reference",
    label: "Reference",
    folder: "references",
    hint: "A document the instructions point to, read when needed.",
    placeholder: "checklist.md",
  },
  {
    id: "asset",
    label: "Asset",
    folder: "assets",
    hint: "A template or other file used in the output.",
    placeholder: "template.md",
  },
  {
    id: "other",
    label: "Other file",
    folder: "",
    hint: "Anywhere in the package; use a/b.txt to create folders.",
    placeholder: "notes/README.md",
  },
];

/** Starting points for a new script. The first line names the interpreter. */
const SCRIPT_TEMPLATES: { id: string; label: string; ext: string; body: string }[] = [
  {
    id: "shell",
    label: "Shell",
    ext: ".sh",
    body: "#!/usr/bin/env bash\n# What this script does, in one line.\nset -euo pipefail\n\n",
  },
  {
    id: "python",
    label: "Python",
    ext: ".py",
    body: '#!/usr/bin/env python3\n"""What this script does, in one line."""\n\n\ndef main() -> None:\n    pass\n\n\nif __name__ == "__main__":\n    main()\n',
  },
  {
    id: "node",
    label: "Node.js",
    ext: ".mjs",
    body: "#!/usr/bin/env node\n// What this script does, in one line.\n\n",
  },
  { id: "empty", label: "Empty", ext: "", body: "" },
];

const STANDARD = [
  { prefix: "scripts/", title: "Scripts" },
  { prefix: "references/", title: "References" },
  { prefix: "assets/", title: "Assets" },
];

function size(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

function isCore(path: string): boolean {
  return path === "SKILL.md" || /^habi\.ya?ml$/.test(path);
}

/** Groups: the skill itself, the standard folders, then other folders as found. */
function groupFiles(
  files: SkillFileEntry[],
): { key: string; title: string; folder: string | null; files: SkillFileEntry[] }[] {
  const groups = [
    {
      key: "core",
      title: "Skill",
      folder: null as string | null,
      files: files.filter((f) => isCore(f.path)),
    },
  ];
  for (const s of STANDARD) {
    const members = files.filter((f) => f.path.startsWith(s.prefix));
    if (members.length > 0)
      groups.push({ key: s.prefix, title: s.title, folder: s.prefix.slice(0, -1), files: members });
  }
  const rest = files.filter((f) => !isCore(f.path) && !STANDARD.some((s) => f.path.startsWith(s.prefix)));
  const byFolder = new Map<string, SkillFileEntry[]>();
  for (const f of rest) {
    const top = f.path.includes("/") ? f.path.slice(0, f.path.indexOf("/")) : "";
    byFolder.set(top, [...(byFolder.get(top) ?? []), f]);
  }
  for (const [folder, members] of [...byFolder.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    groups.push({
      key: `other:${folder}`,
      title: folder ? `${folder}/` : "Package root",
      folder: folder || null,
      files: members,
    });
  }
  return groups;
}

function problemsFor(diagnostics: Diagnostic[], path: string): Diagnostic[] {
  return diagnostics.filter((d) => d.path === path);
}

function FileEditor({
  skillId,
  file,
  readOnly,
  onSaved,
}: {
  skillId: string;
  file: SkillFileContent;
  readOnly: boolean;
  onSaved: (skill: LocalSkill) => void;
}) {
  const [text, setText] = useState(file.text ?? "");
  const [previewing, setPreviewing] = useState(false);
  const digest = useRef(file.digest);
  const language = languageFor(file.path);
  const save = useAutosave<string>({
    value: text,
    keyOf: (v) => v,
    enabled: !readOnly,
    save: async (v) => {
      const saved = await api.writeSkillFile(skillId, file.path, v, digest.current);
      digest.current = saved.files.find((f) => f.path === file.path)?.digest ?? digest.current;
      onSaved(saved);
    },
  });
  const [readError, setReadError] = useState<unknown>(null);
  const reload = async () => {
    setReadError(null);
    try {
      const fresh = await api.readSkillFile(skillId, file.path);
      digest.current = fresh.digest;
      setText(fresh.text ?? "");
      save.reset(fresh.text ?? "");
    } catch (e) {
      setReadError(e);
    }
  };
  const keepMine = async () => {
    setReadError(null);
    try {
      const fresh = await api.readSkillFile(skillId, file.path);
      digest.current = fresh.digest;
      save.retry();
    } catch (e) {
      setReadError(e);
    }
  };
  return (
    <div className="file-editor">
      <div className="file-editor-status">
        {language === "markdown" ? (
          <div className="segmented-control" role="radiogroup" aria-label="View">
            <label className={!previewing ? "is-on" : undefined}>
              <input
                type="radio"
                name="file-mode"
                checked={!previewing}
                onChange={() => setPreviewing(false)}
              />
              Write
            </label>
            <label className={previewing ? "is-on" : undefined}>
              <input
                type="radio"
                name="file-mode"
                checked={previewing}
                onChange={() => setPreviewing(true)}
              />
              Preview
            </label>
          </div>
        ) : (
          <span className="kicker">{language === "plain" ? "text" : language}</span>
        )}
        {readOnly ? null : <SaveIndicator state={save.state} />}
      </div>
      {save.state === "conflict" ? (
        <Notice
          tone="warn"
          title={`${file.path} changed outside Habi`}
          action={
            <>
              <Button size="sm" onClick={() => void reload()}>
                Show the other version
              </Button>
              <Button size="sm" variant="quiet" onClick={() => void keepMine()}>
                Keep mine
              </Button>
            </>
          }
        />
      ) : null}
      {save.state === "error" ? <ErrorNotice error={save.error} title="Not saved" /> : null}
      {readError ? <ErrorNotice error={readError} title={`Could not read ${file.path}`} /> : null}
      {previewing ? (
        <div className="instructions-preview">
          <Markdown text={text} />
        </div>
      ) : (
        <SourceEditor
          key={file.path}
          label={file.path}
          value={text}
          onChange={setText}
          readOnly={readOnly}
          language={language}
        />
      )}
    </div>
  );
}

/** "Add file": pick what kind, name it, optionally start from a template. */
function AddFile({
  onCreate,
  onImport,
}: {
  onCreate: (path: string, body: string, executable: boolean) => void;
  onImport: (folder: string) => void;
}) {
  const [kind, setKind] = useState<Kind | null>(null);
  const [name, setName] = useState("");
  const [template, setTemplate] = useState("shell");
  const chosen = KINDS.find((k) => k.id === kind);
  const tpl = SCRIPT_TEMPLATES.find((t) => t.id === template) ?? SCRIPT_TEMPLATES[0];

  if (!chosen) {
    return (
      <div className="add-file">
        <span className="kicker">Add file</span>
        <div className="add-file-kinds">
          {KINDS.map((k) => (
            <button key={k.id} type="button" className="add-file-kind" onClick={() => setKind(k.id)}>
              <Icon name={k.id === "script" ? "terminal" : "file"} size={14} />
              {k.label}
            </button>
          ))}
        </div>
      </div>
    );
  }

  const fileName = (() => {
    const raw = name.trim();
    if (!raw) return "";
    if (kind === "script" && tpl && tpl.ext && !raw.includes(".")) return `${raw}${tpl.ext}`;
    return raw;
  })();
  const path = chosen.folder && fileName ? `${chosen.folder}/${fileName}` : fileName;
  const create = () => {
    if (!path) return;
    onCreate(path, kind === "script" ? (tpl?.body ?? "") : "", kind === "script" && tpl?.id !== "empty");
    setKind(null);
    setName("");
  };

  return (
    <form
      className="add-file add-file-form"
      onSubmit={(e) => {
        e.preventDefault();
        create();
      }}
    >
      <span className="kicker">New {chosen.label.toLowerCase()}</span>
      <p className="field-hint">{chosen.hint}</p>
      <div className="add-file-row">
        {chosen.folder ? <span className="mono muted add-file-folder">{chosen.folder}/</span> : null}
        <label className="visually-hidden" htmlFor="new-file-name">
          File name
        </label>
        <input
          id="new-file-name"
          className="input mono"
          placeholder={chosen.placeholder}
          value={name}
          spellCheck={false}
          // biome-ignore lint/a11y/noAutofocus: the field is the only thing to do after choosing a kind.
          autoFocus
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      {kind === "script" ? (
        <fieldset className="add-file-templates">
          <legend className="visually-hidden">Start from</legend>
          {SCRIPT_TEMPLATES.map((t) => (
            <label key={t.id} className={`chip-radio${template === t.id ? " is-on" : ""}`}>
              <input
                type="radio"
                name="template"
                checked={template === t.id}
                onChange={() => setTemplate(t.id)}
              />
              {t.label}
            </label>
          ))}
        </fieldset>
      ) : null}
      <div className="add-file-actions">
        <Button type="submit" size="sm" variant="primary" icon="plus" disabled={!path}>
          Create {path ? <span className="mono">{path}</span> : null}
        </Button>
        <Button size="sm" variant="quiet" onClick={() => onImport(chosen.folder)}>
          Import from disk…
        </Button>
        <Button size="sm" variant="quiet" onClick={() => setKind(null)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function FilesPane({
  skill,
  readOnly,
  beforeChange,
  onSkill,
}: {
  skill: LocalSkill;
  readOnly: boolean;
  /** Writes pending edits made elsewhere in the editor before files change. */
  beforeChange: () => Promise<void>;
  /** Called with the skill after a change; `path` names the file edited, if one. */
  onSkill: (skill: LocalSkill, path?: string) => void;
}) {
  const id = skill.summary.id;
  const [open, setOpen] = useState<SkillFileContent | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [listOpen, setListOpen] = useState(true);
  const [renaming, setRenaming] = useState<{ from: string; to: string } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const wanted = useRef<string | null>(null);

  const select = async (path: string) => {
    setError(null);
    setRenaming(null);
    setRemoving(null);
    wanted.current = path;
    try {
      await beforeChange();
      const content = await api.readSkillFile(id, path);
      if (wanted.current === path) setOpen(content);
    } catch (e) {
      setError(e);
    }
  };

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

  const create = (path: string, body: string, executable: boolean) =>
    void run(
      async () => {
        const created = await api.writeSkillFile(id, path, body, null);
        return executable ? api.setSkillFileExecutable(id, path, true) : created;
      },
      () => void select(path),
    );

  const rename = () => {
    if (!renaming) return;
    const to = renaming.to.trim();
    if (!to || to === renaming.from) {
      setRenaming(null);
      return;
    }
    const from = renaming.from;
    const wasOpen = open?.path;
    setRenaming(null);
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

  const entry = open ? skill.files.find((f) => f.path === open.path) : undefined;
  const groups = groupFiles(skill.files);
  const openProblems = open ? problemsFor(skill.diagnostics, open.path) : [];

  const renameForm = (path: string) =>
    renaming?.from === path ? (
      <form
        className="rename-form"
        onSubmit={(e) => {
          e.preventDefault();
          rename();
        }}
      >
        <label className="visually-hidden" htmlFor="rename-to">
          New path for {path}
        </label>
        <input
          id="rename-to"
          className="input mono"
          value={renaming.to}
          spellCheck={false}
          // biome-ignore lint/a11y/noAutofocus: renaming starts in the field.
          autoFocus
          onChange={(e) => setRenaming({ from: path, to: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Escape") setRenaming(null);
          }}
        />
        <Button type="submit" size="sm">
          Rename
        </Button>
        <Button size="sm" variant="quiet" onClick={() => setRenaming(null)}>
          Cancel
        </Button>
      </form>
    ) : null;

  const confirmRemove = (path: string, what: string) =>
    removing === path ? (
      <span className="pkg-confirm">
        <span className="muted">Remove {what}?</span>
        <Button size="sm" variant="danger" onClick={() => remove(path)}>
          Remove
        </Button>
        <Button size="sm" variant="quiet" onClick={() => setRemoving(null)}>
          Keep
        </Button>
      </span>
    ) : null;

  return (
    <div className={`files-pane${listOpen ? "" : " is-list-collapsed"}`}>
      <div className="files-list">
        <div className="files-list-head">
          <span className="kicker">
            Package · {skill.files.length} {skill.files.length === 1 ? "file" : "files"}
          </span>
          <button
            type="button"
            className="icon-btn"
            aria-expanded={listOpen}
            aria-label={listOpen ? "Collapse the file list" : "Expand the file list"}
            onClick={() => setListOpen((v) => !v)}
          >
            <Icon name={listOpen ? "chevronDown" : "chevronRight"} size={14} />
          </button>
        </div>
        {listOpen ? (
          <>
            {error ? (
              <ErrorNotice
                error={error}
                title={error instanceof HabiError && error.code === "conflict" ? "Not changed" : undefined}
              />
            ) : null}
            {groups.map((g) => (
              <section key={g.key} className="pkg-group" aria-label={g.title}>
                <div className="pkg-group-head">
                  <h3 className="pkg-group-title">{g.title}</h3>
                  {g.folder && !readOnly ? (
                    <span className="pkg-group-actions">
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label={`Rename folder ${g.folder}`}
                        title="Rename folder"
                        onClick={() => setRenaming({ from: g.folder as string, to: g.folder as string })}
                      >
                        <Icon name="pencil" size={13} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label={`Remove folder ${g.folder}`}
                        title="Remove folder"
                        onClick={() => setRemoving(g.folder)}
                      >
                        <Icon name="trash" size={13} />
                      </button>
                    </span>
                  ) : null}
                </div>
                {g.folder ? renameForm(g.folder) : null}
                {g.folder ? confirmRemove(g.folder, `the folder and its ${g.files.length} files`) : null}
                <ul className="file-list">
                  {g.files.map((f) => {
                    const problems = problemsFor(skill.diagnostics, f.path);
                    const blocking = problems.some((p) => p.level === "error");
                    return (
                      <li key={f.path} className="pkg-file">
                        <button
                          type="button"
                          className={`file-row${open?.path === f.path ? " is-active" : ""}`}
                          aria-current={open?.path === f.path ? "true" : undefined}
                          onClick={() => void select(f.path)}
                        >
                          <Icon
                            name={f.path.startsWith("scripts/") || f.executable ? "terminal" : "file"}
                            size={14}
                          />
                          <span className="mono file-row-name">{f.path}</span>
                          {problems.length > 0 ? (
                            <span className={`file-problem tone-${blocking ? "danger" : "warn"}`}>
                              {problems.length}
                              <span className="visually-hidden">
                                {blocking ? " problems to fix" : " things to improve"}
                              </span>
                            </span>
                          ) : null}
                          <span className="muted file-row-size">
                            {f.executable ? "exec · " : ""}
                            {size(f.size)}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
            {!readOnly ? (
              <AddFile
                onCreate={create}
                onImport={(folder) => void run(() => api.addSkillFiles(id, folder))}
              />
            ) : null}
          </>
        ) : null}
      </div>

      <div className="files-view">
        {open ? (
          <>
            <div className="file-view-head">
              <span className="mono file-view-path">{open.path}</span>
              {!readOnly ? (
                <span className="file-view-actions">
                  {open.path !== "SKILL.md" ? (
                    <Button
                      size="sm"
                      variant="quiet"
                      icon="pencil"
                      onClick={() => setRenaming({ from: open.path, to: open.path })}
                    >
                      Rename
                    </Button>
                  ) : null}
                  {entry && !open.binary ? (
                    <label className="check-inline" title="Scripts the agent runs directly need this">
                      <input
                        type="checkbox"
                        checked={entry.executable}
                        onChange={(e) =>
                          void run(() => api.setSkillFileExecutable(id, open.path, e.target.checked))
                        }
                      />
                      Executable
                    </label>
                  ) : null}
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
                  <Button
                    size="sm"
                    variant="quiet"
                    icon="external"
                    onClick={() => void api.openSkillFile(id, open.path).catch((e: unknown) => setError(e))}
                  >
                    Open in text editor
                  </Button>
                  {open.path !== "SKILL.md" ? (
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={`Remove ${open.path}`}
                      title="Remove"
                      onClick={() => setRemoving(open.path)}
                    >
                      <Icon name="trash" size={14} />
                    </button>
                  ) : null}
                </span>
              ) : null}
            </div>
            {renameForm(open.path)}
            {confirmRemove(open.path, "this file")}
            {openProblems.length > 0 ? (
              <ul className="file-problems">
                {openProblems.map((p, i) => (
                  <li key={i} className={`tone-${p.level === "error" ? "danger" : "warn"}`}>
                    <strong>
                      {p.level === "error" ? "Must fix" : p.level === "warning" ? "Should fix" : "Suggestion"}
                    </strong>{" "}
                    {p.message}
                  </li>
                ))}
              </ul>
            ) : null}
            {open.binary || open.text === null ? (
              <div className="binary-view">
                {open.preview ? <img src={open.preview} alt={`Preview of ${open.path}`} /> : null}
                <p className="muted">
                  {open.preview ? "" : "Not a text file. "}
                  {size(open.size)} · kept in the package exactly as it is.
                </p>
              </div>
            ) : (
              <FileEditor
                key={`${open.path}:${open.digest}`}
                skillId={id}
                file={open}
                readOnly={readOnly}
                onSaved={(fresh) => onSkill(fresh, open.path)}
              />
            )}
          </>
        ) : (
          <div className="files-empty">
            <p className="muted">Select a file to read or edit it.</p>
            <p className="field-hint">
              Standard layout: <span className="mono">scripts/</span> for code the agent may run,{" "}
              <span className="mono">references/</span> for documents it reads when needed,{" "}
              <span className="mono">assets/</span> for templates and files used in the output.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
