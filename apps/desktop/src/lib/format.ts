/** Plain-language labels and small formatting helpers. */
import type { Applicability } from "../bindings/Applicability";
import type { CheckStatus } from "../bindings/CheckStatus";
import type { ClientId } from "../bindings/ClientId";
import type { EvidenceState } from "../bindings/EvidenceState";
import type { Freshness } from "../bindings/Freshness";
import type { Group } from "../bindings/Group";
import type { InstallState } from "../bindings/InstallState";
import type { ItemKind } from "../bindings/ItemKind";
import type { PrerequisiteStatus } from "../bindings/PrerequisiteStatus";
import type { PruneReport } from "../bindings/PruneReport";
import type { ReadinessState } from "../bindings/ReadinessState";
import type { Source } from "../bindings/Source";

export type Tone = "ok" | "unknown" | "warn" | "danger" | "muted" | "thread";

export const applicabilityLabel: Record<Applicability, string> = {
  applies: "Applies",
  doesNotApply: "Does not apply",
  needsInformation: "Needs information",
  undeclared: "No rules for when it applies",
};

export const applicabilityTone: Record<Applicability, Tone> = {
  applies: "ok",
  doesNotApply: "muted",
  needsInformation: "unknown",
  undeclared: "muted",
};

/** One phrase, everywhere, for an item whose author declared no rules for when it applies. */
export const NO_RULES_PHRASE = "No rules for when it applies — use it deliberately";

export const checkStatusLabel: Record<CheckStatus, string> = {
  passed: "Passed",
  failed: "Failed",
  timedOut: "Timed out",
  cancelled: "Cancelled",
  error: "Could not run",
};

export const checkStatusTone: Record<CheckStatus, Tone> = {
  passed: "ok",
  failed: "danger",
  timedOut: "warn",
  cancelled: "muted",
  error: "danger",
};

/** Validator diagnostic levels in plain words. */
export function levelLabel(level: string): string {
  if (level === "error") return "Error";
  if (level === "warning" || level === "warn") return "Warning";
  return "Note";
}

export const readinessLabel: Record<ReadinessState, string> = {
  ready: "Ready",
  missing: "Prerequisite missing",
  unknown: "Not established",
  noRequirements: "No prerequisites",
};

export const readinessTone: Record<ReadinessState, Tone> = {
  ready: "ok",
  missing: "warn",
  unknown: "unknown",
  noRequirements: "muted",
};

export const installLabel: Record<InstallState, string> = {
  notInstalled: "Not installed",
  current: "Installed",
  updateAvailable: "Update available",
  locallyModified: "Edited locally",
  conflict: "Edited · update conflicts",
  sourceUnavailable: "Library not connected",
};

export const installTone: Record<InstallState, Tone> = {
  notInstalled: "muted",
  current: "ok",
  updateAvailable: "thread",
  locallyModified: "unknown",
  conflict: "danger",
  sourceUnavailable: "warn",
};

export const evidenceLabel: Record<EvidenceState, string> = {
  authorDeclared: "Declared by author",
  locallyChecked: "Checked here",
  failed: "Check failed",
  stale: "Check out of date",
  notEvaluated: "Not evaluated",
};

export const evidenceTone: Record<EvidenceState, Tone> = {
  authorDeclared: "muted",
  locallyChecked: "ok",
  failed: "danger",
  stale: "warn",
  notEvaluated: "muted",
};

export const prerequisiteLabel: Record<PrerequisiteStatus, string> = {
  present: "Found",
  missing: "Missing",
  configured: "Configured",
  notConfigured: "Not configured here",
  unknown: "Not established",
};

export const prerequisiteTone: Record<PrerequisiteStatus, Tone> = {
  present: "ok",
  missing: "warn",
  configured: "ok",
  notConfigured: "warn",
  unknown: "unknown",
};

export const groupLabel: Record<Group, string> = {
  required: "Team requirements",
  relevant: "Fits this project",
  needsInformation: "Needs information",
  available: "Available to use manually",
  notApplicable: "Does not apply",
};

export const groupHint: Record<Group, string> = {
  required: "Designated required by the team. Always listed, whatever the match.",
  relevant: "Conditions declared by the author hold for this project.",
  needsInformation: "Habi could not establish everything a condition needs.",
  available: "No rules for when they apply — use them deliberately. Habi does not match these.",
  notApplicable: "Conditions do not hold, or an exclusion applies.",
};

export const kindLabel: Record<ItemKind, string> = {
  skill: "Skill",
  workflow: "Workflow",
  instructions: "Project instructions",
};

export const clientLabel: Record<ClientId, string> = {
  "claude-code": "Claude Code",
  cursor: "Cursor",
  codex: "Codex",
  "gemini-cli": "Gemini CLI",
  copilot: "GitHub Copilot",
  opencode: "OpenCode",
  junie: "Junie",
};

export const ALL_CLIENTS: ClientId[] = [
  "claude-code",
  "cursor",
  "codex",
  "gemini-cli",
  "copilot",
  "opencode",
  "junie",
];

export function clientsPhrase(clients: ClientId[]): string {
  const names = clients.map((c) => clientLabel[c]);
  if (names.length <= 1) return names[0] ?? "no client";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function shortId(id: string): string {
  const s = id.startsWith("sha256:") ? id.slice(7) : id;
  return s.slice(0, 10);
}

export function relativeTime(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "never";
  const then = new Date(iso);
  const seconds = Math.round((now.getTime() - then.getTime()) / 1000);
  if (Number.isNaN(seconds)) return iso;
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days} day${days === 1 ? "" : "s"} ago`;
  return then.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function freshnessText(source: Source): { text: string; tone: Tone } {
  const map: Record<Freshness, { text: string; tone: Tone }> = {
    neverFetched: { text: "Not fetched yet", tone: "unknown" },
    fetchFailed: { text: "First fetch failed", tone: "danger" },
    current: { text: `Refreshed ${relativeTime(source.snapshotAt)}`, tone: "muted" },
    stale: { text: `Offline copy from ${relativeTime(source.snapshotAt)}`, tone: "warn" },
  };
  return map[source.freshness];
}

/** 4200 → "4.2k", 1500000 → "1.5M": a count at a glance. */
export function compactCount(n: number): string {
  const trim = (x: number) => x.toFixed(1).replace(/\.0$/, "");
  if (n >= 1_000_000) return `${trim(n / 1_000_000)}M`;
  if (n >= 1_000) return `${trim(n / 1_000)}k`;
  return String(n);
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Bytes in a short human form (one decimal from MB up). */
export function sizeLabel(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

/** What Free up space did, in one or two sentences. */
export function pruneSummary(r: PruneReport): string {
  const parts = [
    r.operationsRemoved > 0 ? plural(r.operationsRemoved, "old operation record") : null,
    r.previewsRemoved > 0 ? plural(r.previewsRemoved, "unused library preview") : null,
    r.snapshotsRemoved > 0 ? plural(r.snapshotsRemoved, "old library snapshot") : null,
    r.objectsRemoved > 0 ? plural(r.objectsRemoved, "stored file version") : null,
  ].filter((p): p is string => p !== null);
  const last = parts.pop();
  const removed = last ? (parts.length > 0 ? `${parts.join(", ")} and ${last}` : last) : null;
  const freed = sizeLabel(r.bytesFreed);
  let done = "Nothing to clean up.";
  if (removed) done = `Removed ${removed}, freed ${freed}.`;
  else if (r.bytesFreed > 0) done = `Freed ${freed}.`;
  if (r.skippedBusy === 0) return done;
  const busy =
    r.skippedBusy === 1 ? "1 project or library was" : `${r.skippedBusy} projects or libraries were`;
  return `${done} ${busy} in use and skipped; try again later.`;
}
