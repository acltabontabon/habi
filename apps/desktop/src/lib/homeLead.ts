/**
 * The line under the home page's headline: the one thing about this machine
 * most worth knowing right now, said plainly, with a way to act on it. It is
 * computed from what Habi really holds, never invented, and when nothing needs
 * saying it is the static line.
 */
import type { Contribution } from "../bindings/Contribution";
import type { LocalSkillSummary } from "../bindings/LocalSkillSummary";
import { plural } from "./format";
import type { Route } from "./nav";

export const STATIC_LEAD = "Find what applies. Improve what works. Share what you learn.";

export type Lead = { text: string; action?: { label: string; to: Route } };

export type HomeFacts = {
  /** Projects that still exist; `fits` is `null` until one has been looked at. */
  projects: { id: string; name: string; fits: number | null }[];
  /** Libraries that have been read; `null` while that is not yet known. */
  libraries: number | null;
  /** Libraries with something newer waiting; `null` while that is not yet known. */
  newer: { id: string; name: string }[] | null;
  /** Skills written here that no one has been sent to a library; `null` while not yet known. */
  unshared: number | null;
};

/** "a", "a and b", "a, b and c", "a, b and 2 more". */
export function nameList(names: string[], room = 3): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length <= room) return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const shown = names.slice(0, room - 1);
  return `${shown.join(", ")} and ${names.length - shown.length} more`;
}

export function homeLead(facts: HomeFacts): Lead {
  const { projects } = facts;

  if (projects.length > 0 && facts.libraries === 0) {
    return {
      text: "No library is connected yet, so nothing can be matched to your projects.",
      action: { label: "Connect a library", to: { name: "sources" } },
    };
  }

  const bare = projects.filter((p) => p.fits === 0);
  if (bare[0]) {
    return {
      text: `${nameList(bare.map((p) => p.name))} ${bare.length === 1 ? "has" : "have"} nothing matched yet.`,
      action: {
        label: bare.length === 1 ? "Open it" : `Open ${bare[0].name}`,
        to: { name: "project", projectId: bare[0].id, tab: "recommendations" },
      },
    };
  }

  const newer = facts.newer ?? [];
  if (newer[0]) {
    return {
      text: `${nameList(newer.map((s) => s.name))} ${newer.length === 1 ? "has a newer version" : "have newer versions"}.`,
      action: {
        label: newer.length === 1 ? "See what changed" : `Open ${newer[0].name}`,
        to: { name: "sources", sourceId: newer[0].id },
      },
    };
  }

  if (facts.unshared) {
    return {
      text: `${plural(facts.unshared, "skill")} of yours ${facts.unshared === 1 ? "has" : "have"} not been shared with a library.`,
      action: { label: "Open My skills", to: { name: "skills" } },
    };
  }

  return { text: STATIC_LEAD };
}

/** How many skills written here have never been put forward to a library. */
export function countUnshared(skills: LocalSkillSummary[], contributions: Contribution[]): number {
  const shared = new Set(
    contributions
      .filter((c) => c.state !== "discarded" && c.origin.type === "localSkill")
      .map((c) => (c.origin.type === "localSkill" ? c.origin.skillId : "")),
  );
  return skills.filter(
    (s) =>
      s.deletedAt === null &&
      (s.origin.type === "created" || s.origin.type === "createdForProject") &&
      !shared.has(s.id),
  ).length;
}
