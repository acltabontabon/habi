/**
 * Where these rules would suggest the skill, in one line that stays in sight
 * while the skill is written. It asks again only when the rules change, and
 * keeps saying the last answer until the new one arrives. The Test sheet has
 * the reasons; this is the sentence.
 */
import { andList, plural } from "../../../lib/format";
import { useRulesPreview } from "../../../lib/useRulesPreview";
import type { SkillDraft } from "./useSkillDraft";

const NAMED = 3;

/** "a, b and c", or "a, b, c and 2 more". */
function named(list: string[]): string {
  return list.length <= NAMED
    ? andList(list)
    : `${list.slice(0, NAMED).join(", ")} and ${list.length - NAMED} more`;
}

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
  if (error) return null;

  const results = preview?.projects ?? [];
  const nameOf = (a: string) =>
    results.filter((p) => p.result?.applicability === a).map((p) => p.project.name);
  const applies = nameOf("applies");
  const unknown = results.filter((p) => !p.result || p.result.applicability === "needsInformation");
  const noRules = preview !== null && !preview.problem && !preview.appliesWhen && !preview.excludes;

  const sentence = !preview ? (
    "Checking your projects…"
  ) : preview.problem ? (
    "These rules cannot be evaluated yet."
  ) : noRules ? (
    "Not suggested anywhere until it says when to use it."
  ) : applies.length > 0 ? (
    <>
      Would be suggested in <strong>{named(applies)}</strong>
      {unknown.length > 0 ? `, and maybe ${plural(unknown.length, "more project")}.` : "."}
    </>
  ) : unknown.length > 0 ? (
    `Might be suggested in ${named(unknown.map((p) => p.project.name))}: Habi cannot tell yet.`
  ) : (
    `Would not be suggested in ${results.length === 1 ? "your project" : `any of your ${results.length} projects`}.`
  );
  const toRules = preview !== null && (noRules || Boolean(preview.problem));

  return (
    <p className={`sk-suggested${busy ? " is-stale" : ""}`} aria-live="polite">
      <span className={`sk-suggested-knot${applies.length > 0 ? " is-on" : ""}`} aria-hidden="true" />
      <span className="sk-suggested-text">{sentence}</span>
      {preview ? (
        <button type="button" className="link-btn" onClick={toRules ? onRules : onTest}>
          {toRules ? "When to use" : "See why"}
        </button>
      ) : null}
    </p>
  );
}
