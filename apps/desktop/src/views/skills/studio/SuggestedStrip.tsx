/**
 * Where these rules would suggest the skill, without a sentence: your projects'
 * marks, lit where it would be suggested. It asks again only when the rules change,
 * and keeps showing the last answer until the new one arrives. A mark opens the
 * reasons.
 */
import { ProjectMark } from "../../../components/Weave";
import { useRulesPreview } from "../../../lib/useRulesPreview";
import type { SkillDraft } from "./useSkillDraft";

const SHOWN = 6;

type Standing = "on" | "maybe" | "off";

const SAYS: Record<Standing, string> = {
  on: "would be suggested",
  maybe: "can't tell yet",
  off: "wouldn't be suggested",
};
const ORDER: Standing[] = ["on", "maybe", "off"];

export function SuggestedStrip({
  draft,
  projectIds,
  onTest,
  onRules,
}: {
  draft: SkillDraft;
  projectIds: string[];
  onTest: () => void;
  onRules: () => void;
}) {
  const { preview, busy, error } = useRulesPreview(
    draft.previewRequest(null),
    `${draft.rulesKey}|${projectIds.join(",")}`,
  );
  if (error || !preview) return null;
  if (preview.problem) {
    return (
      <button type="button" className="sk-lit-problem" onClick={onRules}>
        Can't check these rules
      </button>
    );
  }
  // With no rules there is nothing to light up.
  if (!preview.appliesWhen && !preview.excludes) return null;

  const marks = preview.projects
    .map((p) => {
      const a = p.result?.applicability;
      const standing: Standing = a === "applies" ? "on" : !a || a === "needsInformation" ? "maybe" : "off";
      return { project: p.project, standing };
    })
    .sort((a, b) => ORDER.indexOf(a.standing) - ORDER.indexOf(b.standing));
  const more = marks.length - SHOWN;

  return (
    <div className={`sk-lit${busy ? " is-stale" : ""}`} aria-live="polite">
      {marks.slice(0, SHOWN).map(({ project, standing }) => (
        <button
          key={project.id}
          type="button"
          className={`sk-lit-mark is-${standing}`}
          title={`${project.name}: ${SAYS[standing]}`}
          aria-label={`${project.name}: ${SAYS[standing]}`}
          onClick={onTest}
        >
          <ProjectMark name={project.name} languages={project.summary?.languages ?? []} />
        </button>
      ))}
      {more > 0 ? (
        <button type="button" className="sk-lit-more" onClick={onTest}>
          +{more}
        </button>
      ) : null}
    </div>
  );
}
