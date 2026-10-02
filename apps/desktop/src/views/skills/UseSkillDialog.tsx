/**
 * Use a local skill in a project. Projects are listed with what the skill's
 * own rules say about them; the target agents are chosen next, at the point
 * of use, and the change goes through the same reviewed plan as any other
 * install: every file listed, nothing written until confirmed.
 */
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { Applicability } from "../../bindings/Applicability";
import type { LocalSkill } from "../../bindings/LocalSkill";
import { Dialog } from "../../components/Dialog";
import { Button, Status } from "../../components/ui";
import { useActions } from "../../lib/actions";
import { api, newJobId } from "../../lib/api";
import { applicabilityTone, NO_RULES_PHRASE } from "../../lib/format";
import { useRecentProjects } from "../../lib/queries";
import { ReviewDialog } from "../review/ReviewDialog";
import { type FixTarget, Unfinished } from "./Unfinished";

const verdict: Record<Applicability, string> = {
  applies: "Applies",
  needsInformation: "Needs information",
  undeclared: NO_RULES_PHRASE,
  doesNotApply: "Does not apply",
};
const order: Applicability[] = ["applies", "needsInformation", "undeclared", "doesNotApply"];

export function UseSkillDialog({
  skill,
  onClose,
  onFix,
}: {
  skill: LocalSkill;
  onClose: () => void;
  /** Opens the editor where an unfinished part is fixed. */
  onFix?: (target: FixTarget) => void;
}) {
  const projects = useRecentProjects();
  const { openProject } = useActions();
  const available = (projects.data ?? []).filter((p) => p.exists);
  const [projectId, setProjectId] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const errors = skill.diagnostics.filter((d) => d.level === "error");
  const preview = useQuery({
    queryKey: ["usePreview", skill.summary.id, skill.summary.contentDigest, available.map((p) => p.id)],
    queryFn: () =>
      api.previewSkill({ skillId: skill.summary.id, form: null, metadataText: null }, newJobId()),
    enabled: errors.length === 0 && available.length > 0,
  });

  const rows = available
    .map((p) => ({
      project: p,
      result: preview.data?.projects.find((x) => x.project.id === p.id)?.result ?? null,
    }))
    .sort((a, b) => {
      const rank = (r: typeof a) => (r.result ? order.indexOf(r.result.applicability) : order.length);
      return rank(a) - rank(b);
    });
  const chosen = projectId || rows[0]?.project.id || "";

  if (reviewing && chosen) {
    return (
      <ReviewDialog
        projectId={chosen}
        request={{
          kind: "install",
          items: [{ sourceId: "local", itemId: skill.summary.name }],
          title: skill.summary.title,
        }}
        onClose={onClose}
      />
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Use “${skill.summary.title}” in a project`}
      description="Habi copies the skill into the folders your agents read. Installing does not run it."
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={errors.length > 0 || !chosen}
            onClick={() => setReviewing(true)}
          >
            Choose agents and review…
          </Button>
        </>
      }
    >
      {errors.length > 0 ? (
        <Unfinished diagnostics={errors} action="installed" onFix={onFix} />
      ) : available.length === 0 ? (
        <div className="dialog-empty">
          <p>Open the project you want to use it in. Habi only reads it until you confirm a change.</p>
          <Button icon="folder" onClick={() => void openProject({ stay: true })}>
            Open a project…
          </Button>
        </div>
      ) : (
        <fieldset className="field">
          <legend className="field-label">Project</legend>
          <div className="choice-rows">
            {rows.map(({ project, result }) => (
              <label key={project.id} className={`choice-row${chosen === project.id ? " is-on" : ""}`}>
                <input
                  type="radio"
                  name="use-project"
                  checked={chosen === project.id}
                  onChange={() => setProjectId(project.id)}
                />
                <span className="choice-body">
                  <span className="choice-head">
                    <span className="choice-title">{project.name}</span>
                    {result ? (
                      <Status tone={applicabilityTone[result.applicability]}>
                        {verdict[result.applicability]}
                      </Status>
                    ) : null}
                  </span>
                  <span className="choice-detail mono">{project.path}</span>
                </span>
              </label>
            ))}
          </div>
          <span className="field-hint">
            {skill.summary.hasApplicability
              ? "The skill's own rules, evaluated for each project. You can install it anywhere deliberately."
              : "This skill has no applicability rules, so installing it is your call."}{" "}
            Next you choose Claude Code, Cursor or Codex and see every file that would be written.
          </span>
          <Button size="sm" variant="quiet" icon="folder" onClick={() => void openProject({ stay: true })}>
            Open another project…
          </Button>
        </fieldset>
      )}
    </Dialog>
  );
}
