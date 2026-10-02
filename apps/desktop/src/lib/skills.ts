/** Small helpers for local skills: identifiers, attribution, validation hints. */

import type { Contribution } from "../bindings/Contribution";
import type { ContributionState } from "../bindings/ContributionState";
import type { SkillOrigin } from "../bindings/SkillOrigin";
import { relativeTime, type Tone } from "./format";

/** Mirrors the core's identifier derivation, for live suggestions only. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

/** The Agent Skills rule for `name`; the core enforces it, this explains it. */
export function identifierProblem(name: string): string | null {
  if (!name) return "Needed before the skill can be installed or shared.";
  if (name.length > 64) return "Keep it to 64 characters or fewer.";
  if (!/^[a-z0-9-]+$/.test(name)) return "Use lowercase letters, digits and hyphens only.";
  if (name.startsWith("-") || name.endsWith("-") || name.includes("--"))
    return "Hyphens go between words, one at a time.";
  return null;
}

export function lineRange(start: number, end: number): string {
  return start === end ? `line ${start}` : `lines ${start}–${end}`;
}

export function originText(origin: SkillOrigin): string {
  switch (origin.type) {
    case "created":
      return "Written here";
    case "createdForProject":
      return `Written here for ${origin.projectName}`;
    case "folder":
      return `Copied from ${origin.path}`;
    case "project":
      return `Copied from ${origin.projectName} · ${origin.path}`;
    case "library":
      return `Copied from ${origin.sourceName} to edit`;
    case "instructions":
      return `From ${origin.path} (${lineRange(origin.startLine, origin.endLine)}) in ${origin.projectName}`;
  }
}

export function originShort(origin: SkillOrigin): string {
  switch (origin.type) {
    case "created":
    case "createdForProject":
      return "Written here";
    case "folder":
      return "Copied from a folder";
    case "project":
      return `Copied from ${origin.projectName}`;
    case "library":
      return `From ${origin.sourceName}`;
    case "instructions":
      return `From ${origin.path}`;
  }
}

/**
 * What actually happened to a contribution, in words that never overstate:
 * a prepared branch is not a submission, a pushed branch is not a review.
 */
/** "GitHub" / "GitLab" / "your Git host". */
export function hostName(c: Contribution): string {
  const host = c.review?.host ?? c.remote?.host;
  return host === "github" ? "GitHub" : host === "gitlab" ? "GitLab" : "your Git host";
}

/** "pull request" on GitHub, "merge request" on GitLab. */
export function requestWord(c: Contribution): string {
  const host = c.review?.host ?? c.remote?.host;
  return host === "gitlab" ? "merge request" : host === "github" ? "pull request" : "review request";
}

/**
 * Where a contribution stands. A request's state is only stated as observed
 * (with when Habi last asked the host), never assumed.
 */
export function sharingStatus(c: Contribution): { text: string; tone: Tone; detail: string } {
  const host = hostName(c);
  if (c.state === "draft" && c.revising) {
    return {
      text: "Revision not sent yet",
      tone: "thread",
      detail:
        c.publishedUrl || c.review
          ? `The open ${requestWord(c)} still shows the previous version.`
          : "The branch still has the previous version.",
    };
  }
  const review = c.review;
  if (review && c.state !== "draft") {
    const checked = `Checked ${relativeTime(review.checkedAt)}.`;
    switch (review.state) {
      case "merged":
        return { text: "Merged", tone: "ok", detail: `Merged on ${host}. ${checked}` };
      case "closed":
        return { text: "Closed without merging", tone: "muted", detail: `Closed on ${host}. ${checked}` };
      case "changesRequested":
        return {
          text: "Changes requested",
          tone: "warn",
          detail: `A reviewer asked for changes. ${checked}`,
        };
      case "approved":
        return {
          text: "Approved",
          tone: "ok",
          detail: `Approved by ${review.approvedBy.join(", ")}. Merging is up to the maintainers. ${checked}`,
        };
      case "draft":
        return { text: "Draft request", tone: "thread", detail: `Marked as a draft on ${host}. ${checked}` };
      case "open":
        return { text: "In review", tone: "thread", detail: `Open on ${host}. ${checked}` };
    }
  }
  if (c.inLibrary && c.state !== "draft") {
    return {
      text: "In the library",
      tone: "ok",
      detail: `${c.sourceName} now contains these files.`,
    };
  }
  const map: Record<ContributionState, { text: string; tone: Tone; detail: string }> = {
    draft: {
      text: "Not prepared yet",
      tone: "muted",
      detail: "Nothing has left this machine.",
    },
    committed: c.revising
      ? {
          text: "Revision prepared",
          tone: "thread",
          detail:
            "Prepared in Habi's copy of the library. Reviewers see the previous version until you send this one.",
        }
      : {
          text: "Prepared locally",
          tone: "thread",
          detail: "A branch exists in Habi's copy of the library only. Nothing has been sent.",
        },
    exported: {
      text: "Patch exported",
      tone: "thread",
      detail: c.patchPath ? `Saved to ${c.patchPath}. Sending it is up to you.` : "Sending it is up to you.",
    },
    published: c.publishedUrl
      ? {
          text: "Review requested",
          tone: "thread",
          detail: `A ${requestWord(c)} was opened on ${host}. Check its status to see what happened since.`,
        }
      : c.remote?.onThisMachine
        ? {
            text: "Branch in the library",
            tone: "thread",
            detail: "The branch is in the library repository on this machine; review it there.",
          }
        : {
            text: "Branch pushed — no review request",
            tone: "warn",
            detail: c.publishedNote ?? "Open a request on your Git host from the pushed branch.",
          },
    discarded: { text: "Discarded", tone: "muted", detail: "" },
  };
  return map[c.state];
}
