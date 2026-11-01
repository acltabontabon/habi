/** A quiet summary; all applicability editing lives in the sidebar. */
import { signalClause } from "../../../../lib/materials";
import type { SkillDraft } from "../useSkillDraft";
import { signalsOf } from "../WhenToUse";

export function WhenSummary({ draft, onOpen }: { draft: SkillDraft; onOpen: () => void }) {
  const { form, skill } = draft;
  const { applies, excludes } = signalsOf(form);
  const custom = !form.conditionsEditable;
  const invalid = skill.metadataStatus === "invalid";
  const configured = applies.length > 0 || excludes.length > 0 || custom || invalid;
  const summary = invalid
    ? "Rules need attention"
    : custom
      ? "Custom rules"
      : applies.length
        ? applies.map(signalClause).join(form.matchMode === "all" ? " and " : " or ")
        : excludes.length
          ? "Any project"
          : "Choose when this skill should help…";
  return (
    <div className="sk-when">
      <button
        type="button"
        className="sk-when-entry"
        onClick={onOpen}
        aria-label={configured ? "Edit when to use" : "Set conditions"}
      >
        <span className="sk-when-entry-icon" aria-hidden="true">
          ◇
        </span>
        <span className="sk-when-entry-copy">
          <span className="sk-when-label">When to use</span>
          <span>
            {summary}
            {!custom && !invalid && excludes.length
              ? `; except when ${excludes.map(signalClause).join(" or ")}`
              : ""}
          </span>
        </span>
        <span className="sk-when-entry-edit" aria-hidden="true">
          {configured ? "Edit" : "Set up"} ↗
        </span>
      </button>
    </div>
  );
}
