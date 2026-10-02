/**
 * What already exists in this project: skill folders and instruction files.
 * Discovery is read-only — nothing here is adopted, installed or imported
 * until the user asks, and a discovered file always stays where it is.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { DiscoveredSkill } from "../../bindings/DiscoveredSkill";
import type { InstructionFile } from "../../bindings/InstructionFile";
import type { InstructionSection } from "../../bindings/InstructionSection";
import type { ProjectRecord } from "../../bindings/ProjectRecord";
import { Dialog } from "../../components/Dialog";
import { Icon } from "../../components/Icon";
import { Button, ErrorNotice, Notice, Status, Working } from "../../components/ui";
import { useActions } from "../../lib/actions";
import { api } from "../../lib/api";
import { clientsPhrase, NO_RULES_PHRASE, plural } from "../../lib/format";
import { useNav } from "../../lib/nav";
import { invalidateSkills, useKnowledge } from "../../lib/queries";
import { lineRange } from "../../lib/skills";
import { EvidenceExcerpt } from "./Explain";

function SkillRow({ skill, project }: { skill: DiscoveredSkill; project: ProjectRecord }) {
  const { navigate } = useNav();
  const { addSkills } = useActions();
  const [open, setOpen] = useState(false);
  const errors = skill.problems.filter((p) => p.level === "error");
  return (
    <li className="found-row">
      <div className="found-main">
        <div className="found-top">
          <span className="found-title">{skill.name}</span>
          {skill.managedBy ? (
            <Status tone="ok">Installed by Habi from {skill.managedBy}</Status>
          ) : skill.importedAs ? (
            <Status tone="muted">A copy is in My skills</Status>
          ) : null}
        </div>
        {skill.description ? <p className="found-desc">{skill.description}</p> : null}
        <p className="found-meta">
          <span className="mono">{skill.path}</span>
          <span>
            {" · "}
            {skill.readers.length > 0
              ? `read by ${clientsPhrase(skill.readers)}`
              : "not in a folder an agent reads"}
            {" · "}
            {plural(skill.fileCount, "file")}
            {" · "}
            {skill.hasMetadata ? "has applicability rules" : NO_RULES_PHRASE.toLowerCase()}
          </span>
        </p>
        {errors.length > 0 ? (
          <p className="field-problem">
            {errors[0]?.message}
            {errors.length > 1 ? ` (and ${errors.length - 1} more)` : ""}
          </p>
        ) : null}
        {open ? <EvidenceExcerpt projectId={project.id} file={`${skill.path}/SKILL.md`} line={null} /> : null}
      </div>
      <div className="found-actions">
        <Button size="sm" variant="quiet" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? "Hide" : "Read"}
        </Button>
        {skill.importedAs ? (
          <Button
            size="sm"
            onClick={() => navigate({ name: "skills", skillId: skill.importedAs ?? undefined })}
          >
            Open my copy
          </Button>
        ) : (
          <Button
            size="sm"
            onClick={() => addSkills({ source: "project", projectId: project.id, preselect: skill.path })}
          >
            Edit a copy…
          </Button>
        )}
      </div>
    </li>
  );
}

/** Pick part of an instruction file and start a draft from it. */
function InstructionPicker({
  project,
  file,
  onClose,
}: {
  project: ProjectRecord;
  file: InstructionFile;
  onClose: () => void;
}) {
  const { navigate } = useNav();
  const client = useQueryClient();
  const document = useQuery({
    queryKey: ["instructions", project.id, file.path],
    queryFn: () => api.readInstructions(project.id, file.path),
  });
  const [section, setSection] = useState<InstructionSection | null>(null);
  const [range, setRange] = useState<{ start: number; end: number } | null>(null);
  const [title, setTitle] = useState("");
  const [titleEdited, setTitleEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const lines = document.data?.lines ?? [];
  const total = lines.length;
  const chosen = range ?? (section ? { start: section.startLine, end: section.endLine } : null);
  const valid = chosen !== null && chosen.start >= 1 && chosen.end >= chosen.start && chosen.end <= total;
  const shownTitle = titleEdited ? title : (section?.title ?? "");

  const pick = (s: InstructionSection) => {
    setSection(s);
    setRange(null);
  };

  const create = async () => {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      const skill = await api.createSkillFromInstructions(
        project.id,
        file.path,
        chosen.start,
        chosen.end,
        shownTitle.trim(),
      );
      invalidateSkills(client);
      onClose();
      navigate({ name: "skills", skillId: skill.summary.id });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      wide
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Turn part of ${file.path} into a skill`}
      description="Select a reusable procedure. The draft is a copy; the file itself stays exactly as it is."
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={busy} disabled={!valid} onClick={() => void create()}>
            {valid && chosen
              ? `Create draft from ${lineRange(chosen.start, chosen.end)}`
              : "Select the lines to use"}
          </Button>
        </>
      }
    >
      {error ? <ErrorNotice error={error} title="The draft could not be created" /> : null}
      {document.isPending ? <Working>Reading {file.path}…</Working> : null}
      {document.isError ? <ErrorNotice error={document.error} /> : null}
      {document.data ? (
        <div className="picker">
          <div className="picker-side">
            <p className="field-label">Sections</p>
            {document.data.sections.length === 0 ? (
              <p className="muted">No headings in this file. Choose lines below.</p>
            ) : (
              <ul className="picker-sections" aria-label="Sections">
                {document.data.sections.map((s) => {
                  const on = !range && section?.startLine === s.startLine;
                  return (
                    <li key={s.startLine} style={{ paddingLeft: `${(s.level - 1) * 12}px` }}>
                      <label className={`picker-section${on ? " is-on" : ""}`}>
                        <input type="radio" name="section" checked={on} onChange={() => pick(s)} />
                        <span>{s.title}</span>
                        <span className="muted mono">
                          {s.startLine}–{s.endLine}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="field-row picker-range">
              <label className="field">
                <span className="field-label">From line</span>
                <input
                  className="input mono"
                  type="number"
                  min={1}
                  max={total}
                  value={chosen?.start ?? ""}
                  onChange={(e) =>
                    setRange({ start: Number(e.target.value), end: chosen?.end ?? Number(e.target.value) })
                  }
                />
              </label>
              <label className="field">
                <span className="field-label">To line</span>
                <input
                  className="input mono"
                  type="number"
                  min={1}
                  max={total}
                  value={chosen?.end ?? ""}
                  onChange={(e) =>
                    setRange({ start: chosen?.start ?? Number(e.target.value), end: Number(e.target.value) })
                  }
                />
              </label>
            </div>
            <label className="field">
              <span className="field-label">Skill title</span>
              <input
                className="input"
                value={shownTitle}
                placeholder="What the procedure is for"
                onChange={(e) => {
                  setTitle(e.target.value);
                  setTitleEdited(true);
                }}
              />
            </label>
            <p className="field-hint">
              Rules that every change must follow belong in {file.path}, where agents always read them. A
              skill is loaded only when it is relevant.
            </p>
          </div>
          <pre className="picker-text">
            {lines.map((text, i) => {
              const n = i + 1;
              const hit = valid && chosen !== null && n >= chosen.start && n <= chosen.end;
              return (
                <span key={n} className={`excerpt-line${hit ? " is-hit" : ""}`}>
                  <span className="excerpt-num" aria-hidden="true">
                    {n}
                  </span>
                  {text || " "}
                  {"\n"}
                </span>
              );
            })}
          </pre>
        </div>
      ) : null}
    </Dialog>
  );
}

function InstructionRow({ file, project }: { file: InstructionFile; project: ProjectRecord }) {
  const [picking, setPicking] = useState(false);
  const [open, setOpen] = useState(false);
  return (
    <li className="found-row">
      <div className="found-main">
        <div className="found-top">
          <span className="found-title mono">{file.path}</span>
        </div>
        <p className="found-meta">
          {file.convention}
          {file.problem
            ? ""
            : ` · ${plural(file.lines, "line")}${file.sections.length > 0 ? ` · ${plural(file.sections.length, "section")}` : ""}`}
        </p>
        {file.problem ? <p className="field-problem">Not shown: {file.problem}.</p> : null}
        {open ? <EvidenceExcerpt projectId={project.id} file={file.path} line={null} /> : null}
      </div>
      <div className="found-actions">
        {!file.problem ? (
          <>
            <Button size="sm" variant="quiet" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
              {open ? "Hide" : "Read"}
            </Button>
            <Button size="sm" onClick={() => setPicking(true)}>
              Turn part into a skill…
            </Button>
          </>
        ) : null}
      </div>
      {picking ? <InstructionPicker project={project} file={file} onClose={() => setPicking(false)} /> : null}
    </li>
  );
}

export function FoundView({ project, lead }: { project: ProjectRecord; lead?: boolean }) {
  const knowledge = useKnowledge(project.id);
  const { newSkill, addSkills } = useActions();
  const { navigate } = useNav();
  const data = knowledge.data;
  const summary = useMemo(() => {
    if (!data) return "";
    const parts = [];
    if (data.skills.length > 0) parts.push(plural(data.skills.length, "skill"));
    if (data.instructions.length > 0) parts.push(plural(data.instructions.length, "instruction file"));
    return parts.join(" and ");
  }, [data]);

  if (knowledge.isPending) {
    return (
      <div className="page">
        <Working>Looking for skills and instructions already in this project…</Working>
      </div>
    );
  }
  if (knowledge.isError || !data) {
    return (
      <div className="page">
        <ErrorNotice
          error={knowledge.error}
          title="Habi could not look through this project"
          action={
            <Button size="sm" onClick={() => void knowledge.refetch()}>
              Try again
            </Button>
          }
        />
      </div>
    );
  }

  const nothing = data.skills.length === 0 && data.instructions.length === 0;
  const create = () => newSkill({ projectId: project.id, projectName: project.name });

  return (
    <div className="page found">
      {lead ? (
        <header className="found-lead">
          <h2 className="found-headline">
            {nothing ? "No skills or agent instructions in this project yet" : `Already here: ${summary}`}
          </h2>
          <p className="lead-sm">
            {nothing
              ? "Start with something you know about working in this codebase, or bring in what you already have."
              : "Habi only looked. Everything below stays where it is unless you copy it."}{" "}
            Recommendations appear when a team library is connected or one of your skills has applicability
            rules.
          </p>
          <div className="found-lead-actions">
            <Button variant="primary" icon="pencil" onClick={create}>
              Create a skill for this project
            </Button>
            <Button icon="plus" onClick={() => addSkills()}>
              Add existing skills…
            </Button>
            <Button
              variant="quiet"
              icon="library"
              onClick={() => navigate({ name: "sources", sourceId: "new" })}
            >
              Connect a team library…
            </Button>
          </div>
        </header>
      ) : (
        <header className="found-lead">
          <p className="lead-sm">
            Skills and agent instructions that already live in this repository. Habi only looked; everything
            stays where it is unless you copy it.
          </p>
        </header>
      )}

      {data.limits.map((l) => (
        <Notice key={l} tone="unknown" title="This picture may be incomplete">
          {l}
        </Notice>
      ))}

      {data.skills.length > 0 ? (
        <section className="found-section" aria-labelledby="found-skills">
          <h3 id="found-skills" className="section-title">
            Skills <span className="rec-group-count">{data.skills.length}</span>
          </h3>
          <ul className="found-list">
            {data.skills.map((s) => (
              <SkillRow key={s.path} skill={s} project={project} />
            ))}
          </ul>
        </section>
      ) : null}

      {data.instructions.length > 0 ? (
        <section className="found-section" aria-labelledby="found-instructions">
          <h3 id="found-instructions" className="section-title">
            Instructions <span className="rec-group-count">{data.instructions.length}</span>
          </h3>
          <ul className="found-list">
            {data.instructions.map((f) => (
              <InstructionRow key={f.path} file={f} project={project} />
            ))}
          </ul>
          {data.skills.length === 0 ? (
            <p className="muted found-note">
              No skills yet. If one of these files holds a procedure worth reusing — a release routine, a
              review checklist — select that part and turn it into a draft.
            </p>
          ) : null}
        </section>
      ) : null}

      {!lead && nothing ? (
        <div className="found-lead-actions">
          <p className="muted">Nothing found. </p>
          <Button icon="pencil" onClick={create}>
            Create a skill for this project
          </Button>
        </div>
      ) : null}
      {!lead && !nothing ? (
        <div className="found-lead-actions">
          <Button icon="pencil" onClick={create}>
            Create a skill for this project
          </Button>
          <Button variant="quiet" icon="plus" onClick={() => addSkills()}>
            Add existing skills…
          </Button>
        </div>
      ) : null}
      <p className="found-foot muted">
        <Icon name="info" size={13} /> Looked inside this project only. Personal and global agent folders are
        not scanned; add from them with “Add existing skills”.
      </p>
    </div>
  );
}
