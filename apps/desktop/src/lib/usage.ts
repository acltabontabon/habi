/** Saying what is known of a skill's use, and nothing more. */
import type { SkillUsage } from "../bindings/SkillUsage";
import { plural, relativeTime } from "./format";

export const UNUSED_COST_TIP =
  "Agents load its name and description at the start of every session, used or not. An estimate, about 4 characters to a token.";

/**
 * "Used 12× in Claude Code here in 30 days", "Not used in Claude Code here in 30 days", or nothing
 * when the transcripts give nothing to go on. It names Claude Code in the row itself: other agents
 * read the same folder, so a bare "Not used" would be false for a skill used daily in Cursor.
 */
export function usageLine(entry: SkillUsage | undefined, partial: boolean): string | null {
  const seen = entry?.usage;
  if (!seen) return null;
  const period = plural(seen.days, "day");
  if (seen.uses === 0) return `Not used in Claude Code here in ${period}`;
  return `Used ${partial ? "at least " : ""}${seen.uses}× in Claude Code here in ${period}`;
}

/** What the line above rests on. */
export function usageTip(entry: SkillUsage | undefined): string | undefined {
  const seen = entry?.usage;
  if (!seen) return undefined;
  const basis = "Other agents, and other people's sessions, are not counted.";
  return seen.uses === 0
    ? `Claude Code sessions for this project on this machine offered it and did not use it. ${basis}`
    : `Last used ${relativeTime(seen.lastUsed)}, in Claude Code on this machine. ${basis}`;
}
