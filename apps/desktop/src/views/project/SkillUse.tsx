/**
 * A skill's use, in its row: only what the session history shows. An unused skill also says what it
 * costs, since that is when the cost is the question.
 */
import type { SkillUsage } from "../../bindings/SkillUsage";
import { UNUSED_COST_TIP, usageLine, usageTip } from "../../lib/usage";

export function SkillUse({ entry, partial }: { entry: SkillUsage | undefined; partial: boolean }) {
  const line = usageLine(entry, partial);
  if (!entry || !line) return null;
  return (
    <>
      <span title={usageTip(entry)}>{line}</span>
      {entry.usage?.uses === 0 && entry.tokens > 0 ? (
        <span title={UNUSED_COST_TIP}>~{entry.tokens} tokens</span>
      ) : null}
    </>
  );
}
