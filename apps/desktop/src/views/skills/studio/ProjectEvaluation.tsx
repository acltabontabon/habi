/**
 * Would Habi suggest this skill in a project you have open? The rules on
 * screen, evaluated against one project at a time with the same matcher
 * recommendations use: a plain verdict, each condition with what it was
 * decided on, the tools the skill needs, and the scope. Facts Habi could not
 * establish stay "not established" — never a guess, never a failure.
 *
 * This is about suggestions only: whether an agent loads or runs the skill
 * is up to the agent.
 */
import { useState } from "react";
import type { PreviewRequest } from "../../../bindings/PreviewRequest";
import type { ProjectPreview } from "../../../bindings/ProjectPreview";
import type { ProjectRecord } from "../../../bindings/ProjectRecord";
import { Icon } from "../../../components/Icon";
import { Button, Status } from "../../../components/ui";
import { applicabilityTone, relativeTime } from "../../../lib/format";
import type { RulesPreview } from "../../../lib/useRulesPreview";
import { useRulesPreview } from "../../../lib/useRulesPreview";
import { ModuleDetail, ProjectRow, rank } from "../ApplicabilityPreview";
import { PanelSection } from "./Panels";

const sentence = {
  applies: "Habi would suggest it here",
  doesNotApply: "Habi would not suggest it here",
  needsInformation: "Habi can't tell yet",
  undeclared: "Not suggested on its own",
} as const;

const word = {
  applies: "Fits",
  doesNotApply: "Does not fit",
  needsInformation: "Not established",
  undeclared: "No rules",
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
      <div className="eval-verdict is-unknown">
        <Status tone="unknown">Not inspected</Status>
        <p className="eval-why">{p.error?.message ?? "The project could not be inspected."}</p>
      </div>
    );
  }
  const multi = result.modules.length > 1;
  const modules = result.modules.filter((m) => m.applicability === "applies").map((m) => m.moduleName);
  return (
    <>
      <div className={`eval-verdict is-${result.applicability}`}>
        <Status tone={applicabilityTone[result.applicability]}>{word[result.applicability]}</Status>
        <p className="eval-sentence">{sentence[result.applicability]}</p>
        <p className="eval-why">{result.reason}</p>
      </div>
      {p.incomplete.length > 0 ? (
        <p className="eval-incomplete">
          <Icon name="info" size={13} /> Not everything could be read: {p.incomplete[0]}
          {p.incomplete.length > 1 ? ` (and ${p.incomplete.length - 1} more)` : ""}. Missing facts count as
          not established, not as absent.
        </p>
      ) : null}
      {result.applicability !== "undeclared" ? (
        <div className="eval-tree">
          {result.modules.map((m) => (
            <ModuleDetail key={m.module} match={m} projectId={p.project.id} named={multi} />
          ))}
        </div>
      ) : null}
      <p className="eval-scope">
        {result.scope === "repository"
          ? "Checked once, against the whole repository."
          : multi
            ? `Checked per module${modules.length ? ` — fits in ${modules.join(", ")}` : ""}.`
            : "Checked per module."}
        {p.inspectedAt ? ` Read ${relativeTime(p.inspectedAt)}.` : ""}
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
      <PanelSection title="In a project">
        <p className="panel-note">
          Open a project to see whether Habi would suggest this skill there. The skill does not need one.
        </p>
        <Button size="sm" icon="folder" onClick={onOpenProject}>
          Open a project…
        </Button>
      </PanelSection>
    );
  }
  const { preview, busy, error } = evaluation;
  const chosen = preview?.projects.find((p) => p.project.id === projectId);
  const tools = chosen?.prerequisites.filter((p) => p.kind === "tool") ?? [];
  return (
    <>
      <PanelSection title="In a project">
        <label className="eval-pick">
          <span className="visually-hidden">Project to check</span>
          <select className="input" value={projectId ?? ""} onChange={(e) => onProject(e.target.value)}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <div className={`eval${busy ? " is-busy" : ""}`} aria-live="polite" aria-busy={busy}>
          {error ? (
            <p className="field-problem" role="alert">
              The check could not run: {error instanceof Error ? error.message : String(error)}
            </p>
          ) : preview?.problem ? (
            <p className="field-problem" role="alert">
              These rules cannot be evaluated yet: {preview.problem}
            </p>
          ) : chosen ? (
            <Verdict p={chosen} />
          ) : (
            <p className="panel-note">Reading the project…</p>
          )}
        </div>
      </PanelSection>

      {tools.length > 0 ? (
        <PanelSection title="It needs">
          <ul className="eval-needs">
            {tools.map((t) => (
              <li key={t.name} className={`is-${t.status}`}>
                <Icon name={prereqIcon[t.status]} size={13} />
                <span>
                  <strong>{t.name}</strong> — {t.status === "present" ? "available" : "missing"}
                  <span className="eval-need-detail">{t.detail}</span>
                  {t.status === "missing" && t.hint ? (
                    <span className="eval-need-detail">{t.hint}</span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
          <p className="panel-hint">
            Looked up only — nothing was run. Tools never change the verdict above.
          </p>
        </PanelSection>
      ) : null}

      <PanelSection title="Elsewhere">
        {!showAll ? (
          <button type="button" className="link-quiet" onClick={() => setShowAll(true)}>
            Check all {projects.length} projects
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
          <p className="panel-note">Checking your projects…</p>
        )}
      </PanelSection>

      <p className="panel-hint eval-caveat">
        Whether Habi suggests it — not whether an agent loads or runs it. Matching reads build files and file
        names only.
      </p>
    </>
  );
}
