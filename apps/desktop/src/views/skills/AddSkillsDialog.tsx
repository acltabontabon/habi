/**
 * Add skills: one entry point, three sources. Habi inspects before writing —
 * it lists the packages it found, their origin, problems and what importing
 * would create — and imports only what the user selects.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { ImportCandidate } from "../../bindings/ImportCandidate";
import type { ImportFrom } from "../../bindings/ImportFrom";
import type { ImportInspection } from "../../bindings/ImportInspection";
import { Dialog } from "../../components/Dialog";
import { Icon } from "../../components/Icon";
import { useToast } from "../../components/Toasts";
import { Button, ErrorNotice, Status, Working } from "../../components/ui";
import { api, HabiError, newJobId } from "../../lib/api";
import { NO_RULES_PHRASE, plural } from "../../lib/format";
import { useNav } from "../../lib/nav";
import { invalidateSkills, useRecentProjects, useSources } from "../../lib/queries";
import { identifierProblem } from "../../lib/skills";
import { ConnectLibrary } from "../sources/ConnectLibrary";

export type AddSkillsStart =
  | { source: "choose" }
  | { source: "project"; projectId: string; preselect?: string }
  | { source: "folder" }
  | { source: "git" }
  | { source: "library"; sourceId: string; preselect?: string };

type Step =
  | { name: "choose" }
  | { name: "git" }
  | { name: "inspecting"; job: string; label: string }
  | { name: "review"; from: ImportFrom; inspection: ImportInspection };

type Choice = { selected: boolean; rename: string };

/** The last segment of a path, for titles; the full origin is shown below. */
function shortOrigin(origin: string): string {
  return origin.split(/[\\/]/).filter(Boolean).pop() ?? origin;
}

function defaultChoice(c: ImportCandidate, preselect?: string): Choice {
  const importable = c.complete && c.files.includes("SKILL.md");
  return {
    selected: importable && (preselect ? c.path === preselect : c.duplicate === null),
    rename: c.suggestedName ?? "",
  };
}

function CandidateRow({
  candidate: c,
  choice,
  onChange,
}: {
  candidate: ImportCandidate;
  choice: Choice;
  onChange: (choice: Choice) => void;
}) {
  const [showFiles, setShowFiles] = useState(false);
  const errors = c.problems.filter((p) => p.level === "error");
  const warnings = c.problems.filter((p) => p.level === "warning");
  const blocked = !c.complete || !c.files.includes("SKILL.md");
  const needsRename = c.suggestedName !== null;
  const renameProblem = needsRename && choice.selected ? identifierProblem(choice.rename.trim()) : null;
  const id = `candidate-${c.path || "root"}`;
  return (
    <li className={`candidate${choice.selected ? " is-selected" : ""}`}>
      <div className="candidate-head">
        <input
          id={id}
          type="checkbox"
          checked={choice.selected}
          disabled={blocked}
          onChange={(e) => onChange({ ...choice, selected: e.target.checked })}
        />
        <label htmlFor={id} className="candidate-title">
          {c.title || c.name || c.path}
        </label>
        {c.duplicate?.kind === "sameContent" ? (
          <Status tone="muted">Already in My skills</Status>
        ) : c.duplicate?.kind === "sameName" ? (
          <Status tone="warn">Identifier in use</Status>
        ) : errors.length > 0 ? (
          <Status tone="warn">Needs fixing after import</Status>
        ) : null}
      </div>
      {c.description ? <p className="candidate-desc">{c.description}</p> : null}
      <p className="candidate-meta">
        <span className="mono">{c.path || c.name || "(this folder)"}</span> ·{" "}
        <button
          type="button"
          className="link-btn"
          aria-expanded={showFiles}
          onClick={() => setShowFiles((s) => !s)}
        >
          {plural(c.files.length, "file")}
        </button>
        {c.license ? ` · ${c.license}` : ""}
        {c.hasMetadata ? " · has applicability rules" : ` · ${NO_RULES_PHRASE.toLowerCase()}`}
      </p>
      {showFiles ? (
        <ul className="candidate-files mono">
          {c.files.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      ) : null}
      {c.duplicate?.kind === "sameContent" ? (
        <p className="candidate-note">
          The same content was imported as “{c.duplicate.title}”. Select it to add a second, separate copy
          under a new identifier.
        </p>
      ) : c.duplicate?.kind === "sameName" ? (
        <p className="candidate-note">
          “{c.duplicate.title}” in My skills uses the identifier <span className="mono">{c.name}</span> but
          has different content. Import this one under a new identifier to keep both.
        </p>
      ) : null}
      {needsRename && choice.selected ? (
        <label className="field candidate-rename">
          <span className="field-label">Import as</span>
          <input
            className="input mono"
            value={choice.rename}
            spellCheck={false}
            aria-invalid={renameProblem ? true : undefined}
            onChange={(e) => onChange({ ...choice, rename: e.target.value })}
          />
          <span className={renameProblem ? "field-problem" : "field-hint"}>
            {renameProblem ??
              "Only the identifier in the copy's SKILL.md changes. The original is not touched."}
          </span>
        </label>
      ) : null}
      {blocked ? (
        <p className="field-problem">
          {c.problems.find((p) => p.level === "error")?.message ??
            "This package cannot be copied completely, so Habi will not import it."}
        </p>
      ) : errors.length + warnings.length > 0 ? (
        <details className="candidate-problems">
          <summary>{plural(errors.length + warnings.length, "note")} about the package</summary>
          <ul>
            {[...errors, ...warnings].map((p, i) => (
              <li key={i}>
                {p.path ? <span className="mono">{p.path}: </span> : null}
                {p.message}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </li>
  );
}

export function AddSkillsDialog({ start, onClose }: { start: AddSkillsStart; onClose: () => void }) {
  const { navigate } = useNav();
  const client = useQueryClient();
  const toast = useToast();
  const projects = useRecentProjects();
  const sources = useSources();
  const [step, setStep] = useState<Step>(start.source === "git" ? { name: "git" } : { name: "choose" });
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [error, setError] = useState<unknown>(null);
  const [importing, setImporting] = useState(false);
  const available = (projects.data ?? []).filter((p) => p.exists);
  const [projectId, setProjectId] = useState(start.source === "project" ? start.projectId : "");
  const chosenProject = projectId || available[0]?.id || "";

  // Closing the dialog cancels a look that is still running, and work that
  // finishes afterwards does not navigate.
  const mounted = useRef(true);
  const jobRef = useRef<string | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (jobRef.current) void api.cancelJob(jobRef.current);
    };
  }, []);

  const inspect = async (from: ImportFrom, label: string, preselect?: string) => {
    setError(null);
    const job = newJobId();
    jobRef.current = job;
    setStep({ name: "inspecting", job, label });
    try {
      const inspection = await api.inspectImport(from, job);
      setChoices(Object.fromEntries(inspection.candidates.map((c) => [c.path, defaultChoice(c, preselect)])));
      setStep({ name: "review", from, inspection });
    } catch (e) {
      // Cancelling is the user's choice, not a failure.
      if (!(e instanceof HabiError && e.code === "cancelled")) setError(e);
      setStep({ name: "choose" });
    } finally {
      if (jobRef.current === job) jobRef.current = null;
    }
  };

  const fromFolder = async () => {
    setError(null);
    try {
      const folder = await api.pickImportFolder();
      if (folder) await inspect({ type: "folder", path: folder }, "the folder");
    } catch (e) {
      setError(e);
    }
  };

  // Entry points that already know the source skip the first step.
  const [showAll, setShowAll] = useState(false);
  const begun = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once for the dialog's starting source.
  useEffect(() => {
    if (begun.current) return;
    begun.current = true;
    if (start.source === "project") {
      void inspect({ type: "project", projectId: start.projectId }, "the project", start.preselect);
    } else if (start.source === "folder") {
      void fromFolder();
    } else if (start.source === "library") {
      void inspect({ type: "library", sourceId: start.sourceId }, "the library", start.preselect);
    }
  }, []);

  const doImport = async (from: ImportFrom, inspection: ImportInspection) => {
    setImporting(true);
    setError(null);
    try {
      const selections = inspection.candidates
        .filter((c) => choices[c.path]?.selected)
        .map((c) => ({
          path: c.path,
          rename: c.suggestedName !== null ? (choices[c.path]?.rename.trim() ?? null) : null,
        }));
      const outcome = await api.importSkills(from, selections, newJobId());
      invalidateSkills(client);
      if (outcome.imported.length > 0) {
        toast.show(
          `${plural(outcome.imported.length, "skill")} copied to My skills.${
            outcome.skipped.length > 0 ? ` ${outcome.skipped.length} not imported.` : ""
          } The originals were not changed.`,
        );
      }
      if (outcome.skipped.length > 0) {
        setError(new Error(outcome.skipped.map((s) => `${s.path || "The package"}: ${s.reason}`).join("\n")));
        // Show the current state so the user can adjust and retry.
        const refreshed = await api.inspectImport(from);
        setChoices(Object.fromEntries(refreshed.candidates.map((c) => [c.path, defaultChoice(c)])));
        setStep({ name: "review", from, inspection: refreshed });
        return;
      }
      if (!mounted.current) return;
      onClose();
      const only = outcome.imported.length === 1 ? outcome.imported[0] : undefined;
      navigate(only ? { name: "skills", skillId: only.id } : { name: "skills" });
    } catch (e) {
      setError(e);
    } finally {
      setImporting(false);
    }
  };

  const review = step.name === "review" ? step : null;
  const selectedCount = review
    ? review.inspection.candidates.filter((c) => choices[c.path]?.selected).length
    : 0;
  const renameInvalid = review
    ? review.inspection.candidates.some(
        (c) =>
          choices[c.path]?.selected &&
          c.suggestedName !== null &&
          identifierProblem(choices[c.path]?.rename.trim() ?? "") !== null,
      )
    : false;
  const fromLibrary = review?.from.type === "library";
  // Arriving with one skill in mind ("Edit a copy"): show that one first.
  const focus = start.source === "project" || start.source === "library" ? (start.preselect ?? null) : null;
  const focused = focus && review ? review.inspection.candidates.find((c) => c.path === focus) : undefined;
  const listed = review && focused && !showAll ? [focused] : (review?.inspection.candidates ?? []);
  const gitSources = (sources.data ?? []).filter((s) => s.snapshot);

  return (
    <Dialog
      open
      wide={step.name === "review"}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={
        step.name === "git"
          ? "Connect a Git library"
          : review
            ? focused
              ? `Edit a copy of ${focused.title}`
              : fromLibrary
                ? `Copy from ${review.inspection.origin}`
                : `Skills found in ${shortOrigin(review.inspection.origin)}`
            : "Add skills"
      }
      description={
        step.name === "choose"
          ? "Habi looks first. Nothing is copied until you choose."
          : review
            ? fromLibrary
              ? `Copies the whole package to My skills, linked to ${review.inspection.origin} so you can share edits back. The library stays as it is.`
              : "Copies the whole package to My skills. The originals stay where they are."
            : undefined
      }
      footer={
        review ? (
          <>
            <Button
              variant="quiet"
              onClick={() => (start.source === "choose" ? setStep({ name: "choose" }) : onClose())}
            >
              {start.source === "choose" ? "Back" : "Cancel"}
            </Button>
            <Button
              variant="primary"
              busy={importing}
              disabled={selectedCount === 0 || renameInvalid}
              onClick={() => void doImport(review.from, review.inspection)}
            >
              {selectedCount === 0
                ? "Select skills to import"
                : `Copy ${plural(selectedCount, "skill")} to My skills`}
            </Button>
          </>
        ) : undefined
      }
    >
      {error && !(error instanceof HabiError && error.code === "cancelled") ? (
        <ErrorNotice
          error={error}
          title={review ? "Some skills were not imported" : "Habi could not look there"}
        />
      ) : null}

      {step.name === "choose" ? (
        <ul className="source-choices">
          <li className="source-choice">
            <Icon name="folder" />
            <div className="source-choice-body">
              <h3 className="source-choice-title">From a project</h3>
              <p className="muted">
                Skill folders in a repository you opened (<span className="mono">.claude/skills</span>…).
              </p>
              {available.length > 0 ? (
                <div className="input-row">
                  <label className="visually-hidden" htmlFor="add-project">
                    Project
                  </label>
                  <select
                    id="add-project"
                    className="input"
                    value={chosenProject}
                    onChange={(e) => setProjectId(e.target.value)}
                  >
                    {available.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <Button
                    onClick={() => void inspect({ type: "project", projectId: chosenProject }, "the project")}
                  >
                    Look in project
                  </Button>
                </div>
              ) : (
                <p className="muted">Open a project first to look inside it.</p>
              )}
            </div>
          </li>
          <li className="source-choice">
            <Icon name="file" />
            <div className="source-choice-body">
              <h3 className="source-choice-title">From a folder</h3>
              <p className="muted">A skill folder, or a folder of skills such as your personal ones.</p>
              <Button onClick={() => void fromFolder()}>Choose a folder…</Button>
            </div>
          </li>
          <li className="source-choice">
            <Icon name="library" />
            <div className="source-choice-body">
              <h3 className="source-choice-title">From a Git repository</h3>
              <p className="muted">Connects it as a library that stays current when you refresh.</p>
              <div className="input-row">
                <Button onClick={() => setStep({ name: "git" })}>Connect a repository…</Button>
                {gitSources.length > 0 ? (
                  <>
                    <label className="visually-hidden" htmlFor="add-library">
                      Connected library
                    </label>
                    <select
                      id="add-library"
                      className="input"
                      value=""
                      onChange={(e) => {
                        if (e.target.value)
                          void inspect({ type: "library", sourceId: e.target.value }, "the library");
                      }}
                    >
                      <option value="">Copy from a connected library…</option>
                      {gitSources.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </>
                ) : null}
              </div>
            </div>
          </li>
        </ul>
      ) : null}

      {step.name === "git" ? (
        <ConnectLibrary
          compact
          onCancel={() => (start.source === "git" ? onClose() : setStep({ name: "choose" }))}
          onConnected={(source, count) => {
            toast.show(`${source.name} connected: ${plural(count, "item")} available.`);
            onClose();
            navigate({ name: "sources", sourceId: source.id });
          }}
        />
      ) : null}

      {step.name === "inspecting" ? (
        <Working onCancel={() => void api.cancelJob(step.job)}>Looking in {step.label}…</Working>
      ) : null}

      {review ? (
        <>
          {review.from.type === "folder" ? (
            <p className="candidate-origin mono">{review.inspection.origin}</p>
          ) : null}
          {review.inspection.notes.map((n) => (
            <p key={n} className="muted">
              {n}
            </p>
          ))}
          <ul className="candidates">
            {listed.map((c) => (
              <CandidateRow
                key={c.path}
                candidate={c}
                choice={choices[c.path] ?? { selected: false, rename: "" }}
                onChange={(choice) => setChoices((all) => ({ ...all, [c.path]: choice }))}
              />
            ))}
          </ul>
          {focused && review.inspection.candidates.length > 1 ? (
            <button type="button" className="link-btn" onClick={() => setShowAll((v) => !v)}>
              {showAll
                ? `Show only ${focused.title}`
                : `Show all ${review.inspection.candidates.length} skills in ${shortOrigin(review.inspection.origin)}`}
            </button>
          ) : null}
        </>
      ) : null}
    </Dialog>
  );
}
