/**
 * The package as real files: SKILL.md, the optional habi.yaml, and
 * references, scripts and assets. Text files can be edited here; scripts are
 * shown and stored, never run.
 */
import { useEffect, useRef, useState } from "react";
import type { LocalSkill } from "../../bindings/LocalSkill";
import type { SkillFileContent } from "../../bindings/SkillFileContent";
import type { SkillFileEntry } from "../../bindings/SkillFileEntry";
import { Icon } from "../../components/Icon";
import { MarkdownEditor } from "../../components/lazy";
import { SaveIndicator } from "../../components/SaveIndicator";
import { Button, ErrorNotice, Notice } from "../../components/ui";
import { api, HabiError } from "../../lib/api";
import { useAutosave } from "../../lib/useAutosave";

const GROUPS: { id: string; title: string; hint: string; match: (path: string) => boolean }[] = [
  {
    id: "core",
    title: "Skill",
    hint: "SKILL.md is the skill. habi.yaml is optional and only Habi reads it.",
    match: (p) => p === "SKILL.md" || /^habi\.ya?ml$/.test(p),
  },
  {
    id: "references",
    title: "References",
    hint: "Documents the instructions point to; loaded by the agent when needed.",
    match: (p) => p.startsWith("references/"),
  },
  {
    id: "scripts",
    title: "Scripts",
    hint: "Code the agent may run. Habi stores scripts and never runs them.",
    match: (p) => p.startsWith("scripts/"),
  },
  {
    id: "assets",
    title: "Assets",
    hint: "Templates and other files used in the output.",
    match: (p) => p.startsWith("assets/"),
  },
];

function size(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
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
  const digest = useRef(file.digest);
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
      <div className="file-editor-head">
        <span className="mono">{file.path}</span>
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
      <MarkdownEditor
        key={file.path}
        label={file.path}
        value={text}
        onChange={setText}
        readOnly={readOnly}
        plain={!file.path.endsWith(".md")}
      />
    </div>
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
  const [folder, setFolder] = useState("references");
  const [name, setName] = useState("");
  const [removing, setRemoving] = useState<string | null>(null);
  const wanted = useRef<string | null>(null);

  const select = async (path: string) => {
    setError(null);
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

  const create = () => {
    const file = name.trim();
    if (!file) return;
    const path = folder ? `${folder}/${file}` : file;
    void run(
      () => api.writeSkillFile(id, path, "", null),
      () => {
        setName("");
        void select(path);
      },
    );
  };

  const grouped = GROUPS.map((g) => ({ ...g, files: skill.files.filter((f) => g.match(f.path)) }));
  const other = skill.files.filter((f) => !GROUPS.some((g) => g.match(f.path)));
  const row = (f: SkillFileEntry) => (
    <li key={f.path} className="pkg-file">
      <button
        type="button"
        className={`file-row${open?.path === f.path ? " is-active" : ""}`}
        aria-current={open?.path === f.path ? "true" : undefined}
        onClick={() => void select(f.path)}
      >
        <Icon name={f.path.startsWith("scripts/") ? "terminal" : "file"} size={14} />
        <span className="mono">{f.path}</span>
        <span className="muted">
          {size(f.size)}
          {f.executable ? " · executable" : ""}
        </span>
      </button>
      {!readOnly && f.path !== "SKILL.md" ? (
        removing === f.path ? (
          <span className="pkg-confirm">
            <Button
              size="sm"
              variant="danger"
              onClick={() => {
                setRemoving(null);
                void run(() => api.removeSkillFile(id, f.path));
              }}
            >
              Remove
            </Button>
            <Button size="sm" variant="quiet" onClick={() => setRemoving(null)}>
              Keep
            </Button>
          </span>
        ) : (
          <button
            type="button"
            className="icon-btn"
            aria-label={`Remove ${f.path}`}
            onClick={() => setRemoving(f.path)}
          >
            <Icon name="trash" size={14} />
          </button>
        )
      ) : null}
    </li>
  );

  return (
    <div className="files-pane">
      <div className="files-list">
        {error ? (
          <ErrorNotice
            error={error}
            title={error instanceof HabiError && error.code === "conflict" ? "Not added" : undefined}
          />
        ) : null}
        {grouped
          .filter((g) => g.files.length > 0 || g.id === "core")
          .map((g) => (
            <section key={g.id} className="pkg-group" aria-label={g.title}>
              <h3 className="pkg-group-title">{g.title}</h3>
              <p className="field-hint">{g.hint}</p>
              <ul className="file-list">{g.files.map(row)}</ul>
            </section>
          ))}
        {other.length > 0 ? (
          <section className="pkg-group" aria-label="Other files">
            <h3 className="pkg-group-title">Other files</h3>
            <ul className="file-list">{other.map(row)}</ul>
          </section>
        ) : null}

        {!readOnly ? (
          <section className="pkg-group pkg-add" aria-label="Add a file">
            <h3 className="pkg-group-title">Add a file</h3>
            <div className="rule-adder-row">
              <label className="visually-hidden" htmlFor="new-file-folder">
                Folder
              </label>
              <select
                id="new-file-folder"
                className="input rule-kind"
                value={folder}
                onChange={(e) => setFolder(e.target.value)}
              >
                <option value="references">references/</option>
                <option value="scripts">scripts/</option>
                <option value="assets">assets/</option>
                <option value="">(package root)</option>
              </select>
              <label className="visually-hidden" htmlFor="new-file-name">
                File name
              </label>
              <input
                id="new-file-name"
                className="input mono"
                placeholder="checklist.md"
                value={name}
                spellCheck={false}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    create();
                  }
                }}
              />
              <Button size="sm" icon="plus" disabled={!name.trim()} onClick={create}>
                New file
              </Button>
            </div>
            <div className="pkg-add-row">
              <Button size="sm" onClick={() => void run(() => api.addSkillFiles(id, folder))}>
                Copy files from disk into {folder ? `${folder}/` : "the package"}…
              </Button>
              <button type="button" className="link-btn" onClick={() => void api.revealSkill(id)}>
                Show the folder
              </button>
            </div>
          </section>
        ) : null}
      </div>
      <div className="files-view">
        {open ? (
          open.binary || open.text === null ? (
            <p className="muted editor-pad">
              <span className="mono">{open.path}</span> is not text ({size(open.size)}). It is kept in the
              package as it is.
            </p>
          ) : (
            <FileEditor
              key={`${open.path}:${open.digest}`}
              skillId={id}
              file={open}
              readOnly={readOnly}
              onSaved={(fresh) => onSkill(fresh, open.path)}
            />
          )
        ) : (
          <p className="muted editor-pad">Select a file to read or edit it.</p>
        )}
      </div>
    </div>
  );
}
