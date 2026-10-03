/**
 * Words and small derivations for catalog libraries. Everything shown comes
 * from the catalog entry or from what was fetched; nothing here supplies a
 * number or a claim of its own.
 */
import type { CatalogEntry } from "../bindings/CatalogEntry";
import type { LibraryItem } from "../bindings/LibraryItem";
import type { LibraryLicense } from "../bindings/LibraryLicense";
import type { Signal } from "../bindings/Signal";
import type { SignalSeverity } from "../bindings/SignalSeverity";

export type EntryGroup = "builders" | "community";

export const groupOfEntry = (e: CatalogEntry): EntryGroup =>
  e.publisher.kind === "builder" ? "builders" : "community";

/** What "official" rests on, in a few words. Ownership only: never "safe". */
export function ownershipShort(e: CatalogEntry): string | null {
  if (!e.ownership) return null;
  return e.ownership.method === "github-verified-org" ? "official" : "official · not GitHub-verified";
}

export function licenseLabel(l: LibraryLicense | null | undefined): string | null {
  if (!l) return null;
  return l.spdx ?? `see ${l.file}`;
}

export function shortCommit(snapshot: string | null | undefined): string {
  return snapshot ? snapshot.slice(0, 7) : "";
}

/* ---------- Signals ---------- */

const rank: Record<SignalSeverity, number> = { info: 0, notice: 1, caution: 2 };

export function worstSignal(item: LibraryItem): SignalSeverity | null {
  let worst: SignalSeverity | null = null;
  for (const s of item.signals) {
    if (worst === null || rank[s.severity] > rank[worst]) worst = s.severity;
  }
  return worst;
}

export function countSignals(item: LibraryItem): { caution: number; notice: number } {
  let caution = 0;
  let notice = 0;
  for (const s of item.signals) {
    if (s.severity === "caution") caution += 1;
    else if (s.severity === "notice") notice += 1;
  }
  return { caution, notice };
}

/** A signal's file, relative to its skill's folder (the form the reader opens), if it is inside it. */
export function signalFile(item: LibraryItem, signal: Signal): string | null {
  if (!signal.path) return null;
  const prefix = item.path ? `${item.path}/` : "";
  if (!signal.path.startsWith(prefix)) return null;
  const rel = signal.path.slice(prefix.length);
  return rel === "" ? null : rel;
}

export const severityWord: Record<SignalSeverity, string> = {
  caution: "Caution",
  notice: "Notice",
  info: "Note",
};

/* ---------- Grouping inside a library ---------- */

/** The folder name at `segment` of a path, if the path goes deeper than it (as in Rust). */
export function groupOfPath(path: string, segment: number | null): string | null {
  if (segment === null) return null;
  const parts = path.split("/");
  return parts.length > segment + 1 ? (parts[segment] ?? null) : null;
}

/** Items in group order (groups alphabetical, ungrouped last), each group's items alphabetical. */
export function groupItems(
  items: LibraryItem[],
  segment: number | null,
): { name: string | null; items: LibraryItem[] }[] {
  if (segment === null) return [{ name: null, items }];
  const byGroup = new Map<string | null, LibraryItem[]>();
  for (const item of items) {
    const g = groupOfPath(item.path, segment);
    byGroup.set(g, [...(byGroup.get(g) ?? []), item]);
  }
  const named = [...byGroup.entries()]
    .filter((e): e is [string, LibraryItem[]] => e[0] !== null)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, list]) => ({ name, items: list }));
  const rest = byGroup.get(null);
  return rest ? [...named, { name: null, items: rest }] : named;
}
