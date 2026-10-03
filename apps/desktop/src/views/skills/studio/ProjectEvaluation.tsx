/**
 * Testing the skill against a real project, on request: would Habi suggest
 * it there, and because of what — each signal with what it was decided on,
 * down to the file. The rules on screen (saved or not) go through the same
 * matcher recommendations use. Facts Habi could not establish stay "not
 * established" — never a guess, never a failure. Nothing is run.
 */
import { useState } from "react";
import type { PreviewRequest } from "../../../bindings/PreviewRequest";
import type { ProjectPreview } from "../../../bindings/ProjectPreview";
import type { ProjectRecord } from "../../../bindings/ProjectRecord";
import { Icon } from "../../../components/Icon";
import { Button } from "../../../components/ui";
import { plural, relativeTime } from "../../../lib/format";
import type { RulesPreview } from "../../../lib/useRulesPreview";
import { useRulesPreview } from "../../../lib/useRulesPreview";
import { ModuleDetail, ProjectRow, rank } from "../ApplicabilityPreview";

const sentence = {
  applies: "Habi would suggest this skill",
  doesNotApply: "Habi would not suggest it here",
  needsInformation: "Habi can’t tell yet",
  undeclared: "No signals — Habi won’t suggest it on its own",
} as const;

const mark = {
  applies: "check",
  doesNotApply: "cross",
  needsInformation: "question",
  undeclared: "minus",
} as const;

const prereqIcon = {
  present: "check",
  configured: "check",
  missing: "cross",
  notConfigured: "minus",
  unknown: "question",
} as const;

function Verdict({ p }: { p: ProjectPreview }) {
  const result = p.result;
  if (!result) {
    return (
      <div className="tv is-unknown">
        <p className="tv-sentence">Not inspected</p>
        <p className="tv-why">{p.error?.message ?? "The project could not be inspected."}</p>
      </div>
    );
  }
  const multi = result.modules.length > 1;
  const fits = result.modules.filter((m) => m.applicability === "applies").map((m) => m.moduleName);
  const tools = p.prerequisites.filter((x) => x.kind === "tool");
  return (
    <>
      <div className={`tv is-${result.applicability}`}>
        <p className="tv-sentence">
          <span className="tv-mark" aria-hidden="true">
            <Icon name={mark[result.applicability]} size={14} />
          </span>
          {sentence[result.applicability]}
        </p>
        {result.applicability === "undeclared" || result.modules.length === 0 ? (
          <p className="tv-why">{result.reason}</p>
        ) : null}
      </div>
      {p.incomplete.length > 0 ? (
        <p className="tv-note">
          Not everything could be read: {p.incomplete[0]}
          {p.incomplete.length > 1 ? ` (and ${p.incomplete.length - 1} more)` : ""}. Missing facts count as
          not established, not as absent.
        </p>
      ) : null}
      {result.applicability !== "undeclared" ? (
        <section className="tv-because">
          <p className="tv-kicker">Because</p>
          {result.modules.map((m) => (
            <ModuleDetail key={m.module} match={m} projectId={p.project.id} named={multi} />
          ))}
        </section>
      ) : null}
      {tools.length > 0 ? (
        <section className="tv-because">
          <p className="tv-kicker">It needs</p>
          <ul className="tv-needs">
            {tools.map((t) => (
              <li key={t.name} className={`is-${t.status}`}>
                <Icon name={prereqIcon[t.status]} size={13} />
                <span>
                  <strong>{t.name}</strong> — {t.status === "present" ? "available" : "missing"}
                  <span className="tv-detail">{t.detail}</span>
                  {t.status === "missing" && t.hint ? <span className="tv-detail">{t.hint}</span> : null}
                </span>
              </li>
            ))}
          </ul>
          <p className="tv-note">Looked up, never run.</p>
        </section>
      ) : null}
      <p className="tv-meta">
        {result.scope === "repository"
          ? "Checked once, across the whole repository"
          : `Checked ${plural(Math.max(result.modules.length, 1), "module")}${
              multi && fits.length ? ` — fits ${fits.join(", ")}` : ""
            }`}
        {p.inspectedAt ? ` · read ${relativeTime(p.inspectedAt)}` : ""} · from build files and file names only
      </p>
    </>
  );
}

export function ProjectEvaluation({
  projects,
  projectId,
  onProject,
  evaluation,
  allRequest,
  allKey,
  onOpenProject,
}: {
  projects: ProjectRecord[];
  projectId: string | null;
  onProject: (id: string) => void;
  /** The chosen project's evaluation. */
  evaluation: RulesPreview;
  /** The same rules, for every project (run only when asked). */
  allRequest: PreviewRequest | null;
  allKey: string;
  onOpenProject: () => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const all = useRulesPreview(allRequest, allKey, showAll);
  if (projects.length === 0) {
    return (
      <div className="tv-sheet">
        <p className="tv-empty">Open a project to test the skill against it. Habi only reads it.</p>
        <Button size="sm" icon="folder" onClick={onOpenProject}>
          Open a project…
        </Button>
      </div>
    );
  }
  const { preview, busy, error } = evaluation;
  const chosen = preview?.projects.find((p) => p.project.id === projectId);
  return (
    <div className="tv-sheet">
      <label className="tv-pick">
        <span className="visually-hidden">Project to test against</span>
        <select value={projectId ?? ""} onChange={(e) => onProject(e.target.value)}>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <Icon name="chevronDown" size={13} />
      </label>
      <div className={`tv-result${busy ? " is-busy" : ""}`} aria-live="polite" aria-busy={busy}>
        {error ? (
          <p className="field-problem" role="alert">
            The test could not run: {error instanceof Error ? error.message : String(error)}
          </p>
        ) : preview?.problem ? (
          <p className="field-problem" role="alert">
            These signals can’t be evaluated yet: {preview.problem}
          </p>
        ) : chosen ? (
          <Verdict p={chosen} />
        ) : (
          <p className="tv-empty">Reading the project…</p>
        )}
      </div>
      <section className="tv-elsewhere">
        {!showAll ? (
          <button type="button" className="link-quiet" onClick={() => setShowAll(true)}>
            Test all {plural(projects.length, "project")}
          </button>
        ) : all.preview && !all.preview.problem ? (
          <ul className={`preview-list${all.busy ? " is-stale" : ""}`}>
            {[...all.preview.projects]
              .sort((a, b) => rank(a) - rank(b))
              .map((p) => (
                <ProjectRow key={p.project.id} preview={p} />
              ))}
          </ul>
        ) : (
          <p className="tv-empty">Testing your projects…</p>
        )}
      </section>
    </div>
  );
}
