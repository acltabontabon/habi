/**
 * The instructions: the body of SKILL.md, written as the document it is.
 * An empty skill offers a few shapes to start from — never required — and the
 * package's own files complete as paths are typed.
 */
import { type RefObject, useMemo, useRef } from "react";
import type { TemplateInfo } from "../../../bindings/TemplateInfo";
import { Markdown, SourceEditor } from "../../../components/lazy";
import type { LineMark, SourceEditorHandle } from "../../../components/SourceEditor";
import { packageCompletions } from "../../../lib/packageCompletions";
import { useSkillTemplates } from "../../../lib/queries";
import type { SkillDraft } from "./useSkillDraft";

/** When the core cannot be asked, the shapes still have names. */
const FALLBACK: TemplateInfo[] = [];

export function Starters({ onPick }: { onPick: (t: TemplateInfo) => void }) {
  const templates = useSkillTemplates();
  const offered = (templates.data ?? FALLBACK).filter((t) => t.template !== "blank");
  if (offered.length === 0) return null;
  return (
    <section className="studio-starters" aria-labelledby="studio-starters-title">
      <p className="studio-starters-title" id="studio-starters-title">
        Start writing — or begin from a shape
      </p>
      <ul>
        {offered.map((t) => (
          <li key={t.template}>
            <button type="button" className="studio-starter" onClick={() => onPick(t)}>
              <span className="studio-starter-label">{t.label}</span>
              <span className="studio-starter-summary">{t.summary}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function InstructionsMode({
  draft,
  editor,
  writing,
  onCursorLine,
  onOpenFile,
}: {
  draft: SkillDraft;
  editor: RefObject<SourceEditorHandle | null>;
  writing: boolean;
  onCursorLine: (line: number) => void;
  /** A link to one of the package's files was followed in the preview. */
  onOpenFile: (path: string) => void;
}) {
  const { skill, document, setDocument, trashed, broken } = draft;
  const paths = skill.files.map((f) => f.path);
  const pathsRef = useRef(paths);
  pathsRef.current = paths;
  const completions = useMemo(() => packageCompletions(() => pathsRef.current), []);
  const marks: LineMark[] = useMemo(
    () =>
      skill.diagnostics
        .filter((d) => d.path === "SKILL.md" && d.line != null)
        .map((d) => ({ line: d.line ?? 1, level: d.level, message: d.message })),
    [skill.diagnostics],
  );

  if (broken) {
    return (
      <p className="studio-empty-note">
        SKILL.md cannot be read as frontmatter and instructions. Repair it as plain text under Files; nothing
        was overwritten.
      </p>
    );
  }
  const empty = document.body.trim() === "";
  return (
    <div className="studio-doc">
      {writing ? (
        <>
          {empty && !trashed ? (
            <Starters onPick={(t) => setDocument((d) => ({ ...d, body: t.body }))} />
          ) : null}
          <SourceEditor
            handle={editor}
            label="Instructions (Markdown)"
            value={document.body}
            readOnly={trashed}
            variant="prose"
            completions={completions}
            marks={marks}
            onCursorLine={onCursorLine}
            placeholder="Write what the agent should do, step by step. Name the files, commands and checks that matter in your code."
            onChange={(body) => setDocument((d) => ({ ...d, body }))}
          />
        </>
      ) : empty ? (
        <p className="studio-empty-note">Nothing to preview yet.</p>
      ) : (
        <div className="studio-preview">
          <Markdown text={document.body} files={paths} onLocalLink={onOpenFile} />
        </div>
      )}
    </div>
  );
}
