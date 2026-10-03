/**
 * What already exists in this project: skill folders and instruction files.
 * Discovery is read-only — nothing here is adopted, installed or imported
 * until the user asks, and a discovered file always stays where it is.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type CSSProperties, type ReactNode, useState } from "react";
import type { DiscoveredSkill } from "../../bindings/DiscoveredSkill";
import type { InstructionFile } from "../../bindings/InstructionFile";
import type { InstructionSection } from "../../bindings/InstructionSection";
import type { MachineSkill } from "../../bindings/MachineSkill";
import type { ProjectKnowledge } from "../../bindings/ProjectKnowledge";
import type { ProjectRecord } from "../../bindings/ProjectRecord";
import { Dialog } from "../../components/Dialog";
import { Icon } from "../../components/Icon";
import { Button, ErrorNotice, Notice, Status, Working } from "../../components/ui";
import { useActions } from "../../lib/actions";
import { api } from "../../lib/api";
import { clientsPhrase, plural } from "../../lib/format";
import { copyState, precedenceNote } from "../../lib/machine";
import { useNav } from "../../lib/nav";
import { invalidateSkills, useKnowledge, useMachineSkills, useSources } from "../../lib/queries";
import { lineRange } from "../../lib/skills";
import { EvidenceExcerpt } from "./Explain";

/** The copy of this skill among the person's own folders, if there is one: where it is and how it compares. */
function ownCopy(machine: MachineSkill[], skill: DiscoveredSkill, project: ProjectRecord) {
  for (const m of machine) {
    const here = m.inProjects.find((c) => c.projectId === project.id && c.path === skill.path);
    if (here) return { location: m.location, copy: here };
  }
  return null;
}

function SkillRow({
  skill,
  project,
  machine,
}: {
  skill: DiscoveredSkill;
  project: ProjectRecord;
  machine: MachineSkill[];
}) {
  const { navigate } = useNav();
  const own = ownCopy(machine, skill, project);
  const { addSkills } = useActions();
  const [open, setOpen] = useState(false);
  const errors = skill.problems.filter((p) => p.level === "error");
  return (
    <li className="found-row">
      <div className="found-main">
        <div className="found-top">
          <Toggle open={open} onToggle={() => setOpen((o) => !o)}>
            {skill.name}
          </Toggle>
          {skill.managedBy ? (
            <Status tone="ok">Installed by Habi from {skill.managedBy}</Status>
          ) : skill.importedAs ? (
            <Status tone="muted">A copy is in My skills</Status>
          ) : null}
        </div>
        {skill.description ? <p className="found-desc">{skill.description}</p> : null}
        {skill.readers.length === 0 ? (
          <p className="found-warn">Not in a folder an agent reads — agents will not find it.</p>
        ) : null}
        {own ? (
          <p className="found-warn">
            Also in your own skills ({own.location}): {copyState(own.copy)}.{" "}
            {precedenceNote(own.copy) ?? "No agent reads both, so neither hides the other."}
          </p>
        ) : null}
        {errors.length > 0 ? (
          <p className="field-problem">
            {errors[0]?.message}
            {errors.length > 1 ? ` (and ${errors.length - 1} more)` : ""}
          </p>
        ) : null}
      </div>
      <div className="found-actions">
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
      {open ? (
        <div className="found-expand">
          <EvidenceExcerpt projectId={project.id} file={`${skill.path}/SKILL.md`} line={null} />
        </div>
      ) : null}
    </li>
  );
}

/** Pick part of an instruction file and start a draft from it. */
function InstructionPicker({
  project,
  file,
  initial,
  onClose,
}: {
  project: ProjectRecord;
  file: InstructionFile;
  /** A section already chosen (from the outline). */
  initial?: InstructionSection;
  onClose: () => void;
}) {
  const { navigate } = useNav();
  const client = useQueryClient();
  const document = useQuery({
    queryKey: ["instructions", project.id, file.path],
    queryFn: () => api.readInstructions(project.id, file.path),
  });
  const [section, setSection] = useState<InstructionSection | null>(initial ?? null);
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

/** A row's name, which opens its text in place. */
function Toggle({
  open,
  onToggle,
  mono,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  mono?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`found-toggle${mono ? " mono" : ""}`}
      aria-expanded={open}
      onClick={onToggle}
    >
      <Icon name={open ? "chevronDown" : "chevronRight"} size={13} />
      <span>{children}</span>
    </button>
  );
}

/** A line of facts that wraps between facts, never inside one. */
function Meta({ parts }: { parts: string[] }) {
  return (
    <p className="found-meta">
      {parts.map((p, i) => (
        <span key={p} className="found-meta-part">
          {p}
          {i < parts.length - 1 ? " · " : ""}
        </span>
      ))}
    </p>
  );
}

/** "AGENTS.md — read by Codex, Cursor and others" under AGENTS.md says the name twice. */
function conventionOf(file: InstructionFile): string {
  const name = file.path.split("/").pop() ?? file.path;
  return file.convention.startsWith(`${name} — `) ? file.convention.slice(name.length + 3) : file.convention;
}

function InstructionRow({ file, project }: { file: InstructionFile; project: ProjectRecord }) {
  const [picking, setPicking] = useState<InstructionSection | true | false>(false);
  const [open, setOpen] = useState(false);
  return (
    <li className="found-row">
      <div className="found-main">
        <div className="found-top">
          {file.problem ? (
            <span className="found-title mono">{file.path}</span>
          ) : (
            <Toggle open={open} onToggle={() => setOpen((o) => !o)} mono>
              {file.path}
            </Toggle>
          )}
        </div>
        {file.problem ? <p className="field-problem">Not shown: {file.problem}.</p> : null}
      </div>
      <div className="found-actions">
        {!file.problem ? (
          <Button size="sm" onClick={() => setPicking(true)}>
            Turn part into a skill…
          </Button>
        ) : null}
      </div>
      {open ? (
        <div className="found-expand">
          <Outline project={project} file={file} onMakeSkill={(section) => setPicking(section)} />
        </div>
      ) : null}
      {picking ? (
        <InstructionPicker
          project={project}
          file={file}
          initial={picking === true ? undefined : picking}
          onClose={() => setPicking(false)}
        />
      ) : null}
    </li>
  );
}

/**
 * An instruction file as its file-outline on a thread: each heading a knot, a
 * bar as long as the section, the section's text opening in place, and
 * the way to make a skill of just that part. Without headings, the text.
 */
export function Outline({
  project,
  file,
  onMakeSkill,
}: {
  project: ProjectRecord;
  file: InstructionFile;
  onMakeSkill: (section: InstructionSection) => void;
}) {
  const document = useQuery({
    queryKey: ["instructions", project.id, file.path],
    queryFn: () => api.readInstructions(project.id, file.path),
  });
  const [open, setOpen] = useState<number | null>(null);
  const sections = file.sections;
  if (sections.length === 0) return <EvidenceExcerpt projectId={project.id} file={file.path} line={null} />;
  const top = Math.min(...sections.map((s) => s.level));
  const longest = Math.max(...sections.map((s) => s.endLine - s.startLine + 1));
  const lines = document.data?.lines ?? [];
  return (
    <ol className="file-outline">
      {sections.map((s, i) => {
        const length = s.endLine - s.startLine + 1;
        const isOpen = open === i;
        return (
          <li
            key={`${s.startLine}-${s.title}`}
            className={`file-outline-section${s.level > top ? " is-sub" : ""}${isOpen ? " is-open" : ""}`}
            style={{ "--depth": s.level - top } as CSSProperties}
          >
            <div className="file-outline-head">
              <span className="file-outline-knot" aria-hidden="true" />
              <button
                type="button"
                className="file-outline-title"
                aria-expanded={isOpen}
                onClick={() => setOpen(isOpen ? null : i)}
              >
                {s.title}
              </button>
              <span
                className="file-outline-length"
                data-tip={`Lines ${s.startLine}–${s.endLine}`}
                style={{ "--share": Math.max(0.06, length / longest) } as CSSProperties}
              />
              <button type="button" className="link-btn file-outline-make" onClick={() => onMakeSkill(s)}>
                Make a skill
              </button>
            </div>
            {isOpen ? (
              <pre className="file-outline-text">
                {lines.slice(s.startLine - 1, s.endLine).map((text, n) => (
                  <span key={s.startLine + n} className="excerpt-line">
                    <span className="excerpt-num" aria-hidden="true">
                      {s.startLine + n}
                    </span>
                    {text || " "}
                    {"\n"}
                  </span>
                ))}
              </pre>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Recommendations when nothing fits: which libraries were asked, what to do
 * with only this project, and the skills that can still be used by hand.
 * What is already in the project has its own tab.
 */
export function NothingFits({
  project,
  byHand,
  ruled,
  onBrowse,
}: {
  project: ProjectRecord;
  /** Library skills without rules, not installed here: Habi cannot tell if they fit. */
  byHand: number;
  /** Library skills with rules that do not hold here. */
  ruled: number;
  onBrowse: () => void;
}) {
  const sources = useSources();
  const { newSkill, addSkills } = useActions();
  const { navigate } = useNav();
  const connected = (sources.data ?? []).filter((l) => l.snapshot);
  const libraries = connected.map((l) => l.name);
  return (
    <div className="page found is-nothing">
      <div className="found-columns">
        <header className="found-lead">
          <h2 className="found-headline">No recommendations yet</h2>
          <p className="lead-sm">{whyNothing(libraries, project.name, byHand, ruled)}</p>
          <div className="found-lead-actions">
            <Button
              variant="primary"
              icon="pencil"
              onClick={() => newSkill({ projectId: project.id, projectName: project.name })}
            >
              Create a skill for this project
            </Button>
            {byHand > 0 ? (
              <Button icon="library" onClick={onBrowse}>
                Browse {plural(byHand, "library skill")}
              </Button>
            ) : (
              <Button icon="plus" onClick={() => addSkills()}>
                Add existing skills…
              </Button>
            )}
            {libraries.length === 0 ? (
              <Button variant="quiet" icon="library" onClick={() => navigate({ name: "sources" })}>
                Connect a library…
              </Button>
            ) : null}
          </div>
        </header>
        <AlreadyHere project={project} />
      </div>
    </div>
  );
}

/** Skills and agent instructions already in the repository, as a list. Nothing when there are none. */
export function AlreadyHere({ project }: { project: ProjectRecord }) {
  const knowledge = useKnowledge(project.id);
  const machine = useMachineSkills();
  const data = knowledge.data;

  if (knowledge.isPending) return <Working>Looking for skills and instructions already here…</Working>;
  if (knowledge.isError || !data) {
    return (
      <ErrorNotice
        error={knowledge.error}
        title="Habi could not look through this project"
        action={
          <Button size="sm" onClick={() => void knowledge.refetch()}>
            Try again
          </Button>
        }
      />
    );
  }
  const count = data.skills.length + data.instructions.length;
  if (count === 0) return null;

  return (
    <section className="found-section" aria-labelledby="found-here">
      {data.limits.map((l) => (
        <Notice key={l} tone="unknown" title="This picture may be incomplete">
          {l}
        </Notice>
      ))}
      <h3 id="found-here" className="section-title found-heading">
        Already in {project.name}
        <span className="found-scope" data-tip={SCOPE_TIP}>
          <Icon name="info" size={13} />
        </span>
      </h3>
      <ul className="found-list">
        {data.skills.map((s) => (
          <SkillRow key={s.path} skill={s} project={project} machine={machine.data ?? []} />
        ))}
        {data.instructions.map((f) => (
          <InstructionRow key={f.path} file={f} project={project} />
        ))}
      </ul>
    </section>
  );
}

const SCOPE_TIP =
  "Only this repository. Skills in your own agent folders are listed in My skills under On this machine; a copy of one found here is noted on its row";

/** Something already in the project, as the workbench lists it beside the recommendations. */
export type HereItem =
  | { key: string; kind: "skill"; title: string; gist: string; skill: DiscoveredSkill }
  | { key: string; kind: "instructions"; title: string; gist: string; file: InstructionFile };

/**
 * What is already here and not a library's (Habi's installs are
 * recommendations, with their status, already).
 */
export function hereItems(data: ProjectKnowledge | undefined): HereItem[] {
  if (!data) return [];
  return [
    ...data.skills
      .filter((s) => !s.managedBy)
      .map((skill) => ({
        key: `here:${skill.path}`,
        kind: "skill" as const,
        title: skill.name,
        gist: skill.description || skill.path,
        skill,
      })),
    ...data.instructions.map((file) => ({
      key: `here:${file.path}`,
      kind: "instructions" as const,
      title: file.path,
      gist: conventionOf(file),
      file,
    })),
  ];
}

/** The detail pane for something already in the project: what it is, what to do with it, its text. */
export function HereDetail({ project, item }: { project: ProjectRecord; item: HereItem }) {
  const { navigate } = useNav();
  const { addSkills } = useActions();
  const [picking, setPicking] = useState<InstructionSection | true | false>(false);
  const isSkill = item.kind === "skill";
  const path = isSkill ? `${item.skill.path}/SKILL.md` : item.file.path;
  const meta = isSkill
    ? [
        item.skill.path,
        item.skill.readers.length > 0
          ? `read by ${clientsPhrase(item.skill.readers)}`
          : "not in a folder an agent reads",
      ]
    : [conventionOf(item.file)];
  return (
    <article className="detail" aria-labelledby="detail-title">
      <header className="detail-head">
        <p className="detail-kicker">
          {isSkill ? "Skill" : "Agent instructions"} · already in {project.name}
          <span className="found-scope" data-tip={SCOPE_TIP}>
            <Icon name="info" size={12} />
          </span>
        </p>
        <h2 id="detail-title" className={`detail-title${isSkill ? "" : " mono"}`}>
          {item.title}
        </h2>
        {isSkill && item.skill.description ? <p className="detail-desc">{item.skill.description}</p> : null}
        <Meta parts={meta} />
        <div className="detail-actions">
          {isSkill ? (
            item.skill.importedAs ? (
              <Button
                variant="primary"
                onClick={() => navigate({ name: "skills", skillId: item.skill.importedAs ?? undefined })}
              >
                Open my copy
              </Button>
            ) : (
              <Button
                variant="primary"
                icon="pencil"
                onClick={() =>
                  addSkills({ source: "project", projectId: project.id, preselect: item.skill.path })
                }
              >
                Edit a copy…
              </Button>
            )
          ) : item.file.problem ? (
            <p className="field-problem">Not shown: {item.file.problem}.</p>
          ) : (
            <Button variant="primary" icon="pencil" onClick={() => setPicking(true)}>
              Turn part into a skill…
            </Button>
          )}
        </div>
      </header>
      <div className="detail-body">
        {item.kind === "instructions" ? (
          item.file.problem ? null : (
            <Outline project={project} file={item.file} onMakeSkill={(section) => setPicking(section)} />
          )
        ) : (
          <EvidenceExcerpt projectId={project.id} file={path} line={null} />
        )}
      </div>
      {picking && item.kind === "instructions" ? (
        <InstructionPicker
          project={project}
          file={item.file}
          initial={picking === true ? undefined : picking}
          onClose={() => setPicking(false)}
        />
      ) : null}
    </article>
  );
}

/**
 * Why nothing is recommended, without claiming more than Habi knows: a
 * skill with no rules is not a "no", only a "cannot tell".
 */
function whyNothing(libraries: string[], project: string, byHand: number, ruled: number): string {
  if (libraries.length === 0) return "Connect a library and what fits this project shows here.";
  if (byHand === 0) return `Nothing in ${listPhrase(libraries, "or")} fits ${project}.`;
  if (ruled === 0) {
    const they =
      libraries.length === 1 ? "doesn't say when its skills apply" : "don't say when their skills apply";
    return `${listPhrase(libraries, "and")} ${they}, so Habi can't match them to ${project}.`;
  }
  return `None of the ${plural(ruled, "skill")} that say when they apply fit ${project}. The other ${byHand} don't say, so Habi can't match them.`;
}

/** "Local", "Local or OpenAI", "Local, OpenAI or 2 more". */
function listPhrase(names: string[], conjunction: "or" | "and"): string {
  if (names.length <= 2) return names.join(` ${conjunction} `);
  return `${names.slice(0, 2).join(", ")} ${conjunction} ${names.length - 2} more`;
}
