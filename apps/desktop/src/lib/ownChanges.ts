/**
 * Habi's own writes to a project (installs, updates, removals, restores) are
 * not "files changed in this project": the watcher would otherwise report
 * them and suggest the recommendations are out of date right after Habi
 * refreshed them. While Habi applies a plan, and for a short while after (the
 * watcher debounces), change events for that project are ignored.
 */
const AFTER_MS = 4000;
const quietUntil = new Map<string, number>();

export function beginOwnChange(projectId: string) {
  quietUntil.set(projectId, Number.POSITIVE_INFINITY);
}

export function endOwnChange(projectId: string) {
  quietUntil.set(projectId, Date.now() + AFTER_MS);
}

export function isOwnChange(projectId: string, now = Date.now()): boolean {
  const until = quietUntil.get(projectId);
  return until !== undefined && now < until;
}

/** The query key of the "files changed" notice for a project. */
export const staleKey = (projectId: string) => ["overviewStale", projectId] as const;
