/**
 * One package file, open: text with highlighting and its own autosave, or a
 * preview for images. A script is shown and edited as text — Habi never runs
 * it; how a person would run it is a line to copy, nothing more.
 */
import { useEffect, useRef, useState } from "react";
import type { LocalSkill } from "../../../../bindings/LocalSkill";
import type { SkillFileContent } from "../../../../bindings/SkillFileContent";
import { Icon } from "../../../../components/Icon";
import { Markdown, SourceEditor } from "../../../../components/lazy";
import { SaveIndicator } from "../../../../components/SaveIndicator";
import type { SourceEditorHandle } from "../../../../components/SourceEditor";
import { Button, ErrorNotice, Notice } from "../../../../components/ui";
import { api } from "../../../../lib/api";
import { languageFor } from "../../../../lib/languages";
import { kindOf, runCommand } from "../../../../lib/packageFiles";
import { type SaveState, useAutosave } from "../../../../lib/useAutosave";

export function size(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

function RunLine({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <p className="file-run">
      <Icon name="terminal" size={13} />
      <span>Habi never runs it. To run it yourself:</span>
      <code>{command}</code>
      <button
        type="button"
        className="link-quiet"
        onClick={() =>
          void navigator.clipboard
            ?.writeText(command)
            .then(() => setCopied(true))
            .catch(() => setCopied(false))
        }
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </p>
  );
}

export function FileEditor({
  skillId,
  file,
  readOnly,
  line,
  onSaved,
  onState,
}: {
  skillId: string;
  file: SkillFileContent;
  readOnly: boolean;
  /** A line to go to when the file opens. */
  line?: number | null;
  onSaved: (skill: LocalSkill) => void;
  onState?: (path: string, state: SaveState) => void;
}) {
  const [text, setText] = useState(file.text ?? "");
  const [previewing, setPreviewing] = useState(false);
  const digest = useRef(file.digest);
  const editor = useRef<SourceEditorHandle>(null);
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

  const onStateRef = useRef(onState);
  onStateRef.current = onState;
  useEffect(() => {
    onStateRef.current?.(file.path, save.state);
  }, [file.path, save.state]);

  useEffect(() => {
    if (!line) return;
    // The editor loads lazily; try again until it is there.
    let tries = 0;
    const timer = window.setInterval(() => {
      tries += 1;
      if (editor.current || tries > 20) {
        window.clearInterval(timer);
        editor.current?.revealLine(line);
      }
    }, 50);
    return () => window.clearInterval(timer);
  }, [line]);

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
  const script = kindOf(file.path) === "script" || /^#!/.test(text);

  return (
    <div className="file-editor">
      <div className="file-editor-bar">
        {language === "markdown" ? (
          <fieldset className="studio-switch">
            <legend className="visually-hidden">View</legend>
            <button
              type="button"
              aria-pressed={!previewing}
              className={!previewing ? "is-on" : undefined}
              onClick={() => setPreviewing(false)}
            >
              Write
            </button>
            <button
              type="button"
              aria-pressed={previewing}
              className={previewing ? "is-on" : undefined}
              onClick={() => setPreviewing(true)}
            >
              Preview
            </button>
          </fieldset>
        ) : (
          <span className="kicker">{language === "plain" ? "text" : language}</span>
        )}
        {readOnly ? null : <SaveIndicator state={save.state} ambient onRetry={() => void save.flush()} />}
      </div>
      {script ? <RunLine command={runCommand(file.path, text.split("\n", 1)[0])} /> : null}
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
        <div className="file-preview">
          <Markdown text={text} />
        </div>
      ) : (
        <SourceEditor
          key={file.path}
          handle={editor}
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

export function BinaryView({ file }: { file: SkillFileContent }) {
  return (
    <div className="file-binary">
      {file.preview ? (
        <div className="file-binary-frame">
          <img src={file.preview} alt={`Preview of ${file.path}`} />
        </div>
      ) : null}
      <p className="muted">
        {file.preview ? "" : "Not a text file. "}
        {size(file.size)} · kept in the package exactly as it is.
      </p>
    </div>
  );
}
