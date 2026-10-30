/** Saying what is known of a skill's use, and nothing more. */
import type { SkillUsage } from "../bindings/SkillUsage";
import { plural, relativeTime } from "./format";

export const UNUSED_COST_TIP =
  "Agents load its name and description at the start of every session, used or not. An estimate, about 4 characters to a token.";

/** "Used 12× in 30 days", "Not used in 30 days", or nothing when the transcripts give nothing to go on. */
export function usageLine(entry: SkillUsage | undefined, partial: boolean): string | null {
  const seen = entry?.usage;
  if (!seen) return null;
  const period = plural(seen.days, "day");
  if (seen.uses === 0) return `Not used in ${period}`;
  return `Used ${partial ? "at least " : ""}${seen.uses}× in ${period}`;
}

/** What the line above rests on. */
export function usageTip(entry: SkillUsage | undefined): string | undefined {
  const seen = entry?.usage;
  if (!seen) return undefined;
  const basis = "Other agents are not counted.";
  return seen.uses === 0
    ? `Claude Code sessions in this project offered it and did not use it. ${basis}`
    : `Last used ${relativeTime(seen.lastUsed)}, from Claude Code's session history on this machine. ${basis}`;
}
