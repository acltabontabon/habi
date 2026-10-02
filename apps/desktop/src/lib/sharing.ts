/**
 * Where a contribution stands and what to do next, in words that never
 * overstate: a prepared branch is not a submission, a pushed branch is not a
 * review request, and a request's state is only stated as the Git host
 * reported it — with when Habi last asked.
 */
import type { AppInfo } from "../bindings/AppInfo";
import type { Contribution } from "../bindings/Contribution";
import type { Tone } from "./format";

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

/** "PR" / "MR" / "request", for dense labels. */
export function requestShort(c: Contribution): string {
  const host = c.review?.host ?? c.remote?.host;
  return host === "gitlab" ? "MR" : host === "github" ? "PR" : "request";
}

/** The request on the host, when one is known to exist and is not finished. */
export function openRequestUrl(c: Contribution): string | null {
  if (c.review) {
    return c.review.state === "merged" || c.review.state === "closed"
      ? null
      : (c.review.url ?? c.publishedUrl);
  }
  return c.publishedUrl;
}

export type SharingState =
  | "draft"
  | "ready"
  | "open"
  | "changesRequested"
  | "merged"
  | "closed"
  | "inLibrary"
  | "pushed"
  | "attention";

export type SharingChip = {
  state: SharingState;
  label: string;
  tone: Tone;
  /** When the host last confirmed this state (host-derived states only). */
  checkedAt: string | null;
};

/** One state per contribution, from what Habi did and what the host said. */
export function sharingChip(c: Contribution): SharingChip {
  const chip = (state: SharingState, label: string, tone: Tone, checkedAt: string | null = null) => ({
    state,
    label,
    tone,
    checkedAt,
  });
  if (c.attention) return chip("attention", "Needs attention", "danger");
  if (c.state === "draft") return chip("draft", "Draft", "muted");
  const review = c.review;
  if (review) {
    switch (review.state) {
      case "merged":
        return chip("merged", "Merged", "ok", review.checkedAt);
      case "closed":
        return chip("closed", "Closed", "muted", review.checkedAt);
      case "changesRequested":
        return chip("changesRequested", "Changes requested", "warn", review.checkedAt);
      default:
        return chip("open", `Open ${requestShort(c)}`, "thread", review.checkedAt);
    }
  }
  if (c.inLibrary) return chip("inLibrary", "In the library", "ok");
  if (c.state === "published") {
    // The host returned the request's address when it was opened.
    if (c.publishedUrl) return chip("open", `Open ${requestShort(c)}`, "thread", c.publishedAt);
    return chip("pushed", "Branch pushed", c.remote?.onThisMachine ? "thread" : "warn");
  }
  return chip("ready", "Ready to submit", "thread");
}

export type NextAction = { kind: "details"; label: string } | { kind: "open"; label: string; url: string };

/** The one thing to do next from Contributions. */
export function nextAction(c: Contribution): NextAction {
  const chip = sharingChip(c);
  if (chip.state === "attention") return { kind: "details", label: "Retry" };
  if (chip.state === "draft") return { kind: "details", label: "Continue editing" };
  const url = c.review?.url ?? c.publishedUrl;
  if (url && (chip.state === "open" || chip.state === "merged" || chip.state === "closed")) {
    return { kind: "open", label: `Open ${requestShort(c)}`, url };
  }
  return { kind: "details", label: "Review changes" };
}

export type FinalAction = {
  /** Names exactly what happens: "Create pull request", "Push branch"… */
  label: string;
  /** Ask the host (through gh/glab) to open a request after pushing. */
  openRequest: boolean;
  /** Why the action is what it is, when it is not the obvious one. */
  note: string | null;
};

/**
 * The action that sends a prepared contribution. It creates a request only
 * where the host is known and its command-line tool is installed; otherwise
 * it honestly pushes the branch (or a patch can be exported).
 */
export function finalAction(c: Contribution, info: AppInfo | undefined): FinalAction {
  const remote = c.remote;
  const word = requestWord(c);
  const host = hostName(c);
  if (!remote) {
    return { label: "Push branch", openRequest: false, note: "Habi cannot read the library's address." };
  }
  if (remote.onThisMachine) {
    return {
      label: "Push branch",
      openRequest: false,
      note: "The library is a repository on this machine: the branch is written there, to be reviewed there.",
    };
  }
  if (c.pushedCommit !== null && openRequestUrl(c)) {
    return {
      label: "Push revision",
      openRequest: false,
      note: `Habi checks the ${word} on ${host} first. If it is still open, it shows the new commit; no second request is opened.`,
    };
  }
  if (remote.requestUnavailable) {
    return { label: "Push branch", openRequest: false, note: remote.requestUnavailable };
  }
  const tool = remote.host === "github" ? "gh" : remote.host === "gitlab" ? "glab" : null;
  if (tool) {
    const installed = tool === "gh" ? info?.ghAvailable : info?.glabAvailable;
    if (installed) return { label: `Create ${word}`, openRequest: true, note: null };
    return {
      label: "Push branch",
      openRequest: false,
      note: `\`${tool}\` is not installed, so Habi cannot open the ${word}. It pushes the branch; open the ${word} on ${host}, or export a patch instead.`,
    };
  }
  if (info?.ghAvailable || info?.glabAvailable) {
    return {
      label: "Push branch",
      openRequest: true,
      note: "The address does not say which host this is. Habi asks gh or glab; if one is signed in to it, a review request is opened too.",
    };
  }
  return {
    label: "Push branch",
    openRequest: false,
    note: "Neither gh nor glab is installed, so Habi cannot open a review request. Open one on your Git host from the pushed branch, or export a patch instead.",
  };
}

/** The branch a request targets, as the host reported it or as configured. */
export function targetBranch(c: Contribution): string {
  if (c.review?.targetBranch) return c.review.targetBranch;
  const tracked = c.remote?.tracked;
  if (!tracked) return "unknown";
  switch (tracked.kind) {
    case "branch":
      return tracked.name;
    case "default":
    case "latestRelease":
      return "the repository's default branch";
    case "tag":
      return `none (the library follows tag ${tracked.name})`;
  }
}

/** Who can see the library, only when the host said so. */
export function visibilityText(c: Contribution): string {
  if (c.remote?.onThisMachine) return "On this machine";
  const v = c.review?.visibility;
  if (v) return `${v[0]?.toUpperCase()}${v.slice(1)} (reported by ${hostName(c)})`;
  return "Unknown — not checked";
}
