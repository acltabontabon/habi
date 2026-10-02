/**
 * Beside the instructions: the package's supporting files, so the
 * instructions can point at them. Inserting a link or a script's
 * documentation is always an explicit choice; nothing is rewritten for you.
 */
import { useState } from "react";
import type { SkillFileEntry } from "../../bindings/SkillFileEntry";
import { Icon } from "../../components/Icon";

/** A Markdown link to a package file, relative to SKILL.md. */
export function fileLink(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return `[${name}](${path})`;
}

/** A documentation block for a script, to fill in. */
export function scriptDoc(path: string): string {
  return `\n\n### \`${path}\`\n\n- **Purpose:** \n- **Run:** \`${path}\`\n- **Inputs:** \n- **Outputs:** \n- **Requires:** \n`;
}

export function PackageRefs({
  files,
  body,
  canInsert,
  onInsert,
  onManage,
}: {
  /** Supporting files (not SKILL.md or habi.yaml). */
  files: SkillFileEntry[];
  /** The instructions, to show which files they already mention. */
  body: string;
  /** False while previewing or read-only. */
  canInsert: boolean;
  onInsert: (text: string) => void;
  onManage: () => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <aside className={`package-refs${open ? "" : " is-collapsed"}`} aria-label="Package files">
      <button
        type="button"
        className="package-refs-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name={open ? "chevronDown" : "chevronRight"} size={13} />
        <span className="kicker">Package files · {files.length}</span>
      </button>
      {open ? (
        files.length === 0 ? (
          <p className="package-refs-empty">
            Instructions alone make a complete skill. Scripts, references and assets are optional.{" "}
            <button type="button" className="link-btn" onClick={onManage}>
              Add a file
            </button>
          </p>
        ) : (
          <>
            <ul className="package-refs-list">
              {files.map((f) => {
                const mentioned = body.includes(f.path);
                const script = f.path.startsWith("scripts/") || f.executable;
                return (
                  <li key={f.path}>
                    <span className="mono package-refs-path" title={f.path}>
                      {f.path}
                    </span>
                    {mentioned ? (
                      <span className="package-refs-state" title="The instructions mention this file">
                        <Icon name="check" size={12} />
                        <span className="visually-hidden">mentioned in the instructions</span>
                      </span>
                    ) : null}
                    <span className="package-refs-actions">
                      <button
                        type="button"
                        className="link-btn"
                        disabled={!canInsert}
                        onClick={() => onInsert(fileLink(f.path))}
                        aria-label={`Insert a link to ${f.path}`}
                      >
                        Link
                      </button>
                      {script ? (
                        <button
                          type="button"
                          className="link-btn"
                          disabled={!canInsert}
                          onClick={() => onInsert(scriptDoc(f.path))}
                          aria-label={`Insert documentation for ${f.path}`}
                        >
                          Document
                        </button>
                      ) : null}
                    </span>
                  </li>
                );
              })}
            </ul>
            <button type="button" className="link-btn package-refs-manage" onClick={onManage}>
              Manage files
            </button>
          </>
        )
      ) : null}
    </aside>
  );
}
