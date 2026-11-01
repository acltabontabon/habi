/** The composition as a whole, read from the document: which part of the instructions uses which skill. */
import type { Node as PMNode } from "prosemirror-model";
import { occurrencesIn } from "./roles";

export type OverviewRow = { title: string; pos: number; level: number };
export type OverviewUse = { row: number; name: string; role: string | null; pos: number };
export type Overview = { rows: OverviewRow[]; names: string[]; uses: OverviewUse[] };

/**
 * Sections are the document's own headings. Text before the first heading is its
 * own row, called by what it is, since an author never named it.
 */
export function overviewOf(doc: PMNode): Overview {
  const headings: { pos: number; title: string; level: number }[] = [];
  doc.forEach((child, offset) => {
    if (child.type.name === "heading") {
      headings.push({
        pos: offset,
        title: child.textContent.trim() || "Untitled section",
        level: child.attrs.level as number,
      });
    }
  });
  const rows: OverviewRow[] = headings.map((h) => ({ title: h.title, pos: h.pos, level: h.level }));
  const occurrences = occurrencesIn(doc).filter((o) => o.role !== null);
  const beforeFirst = occurrences.some((o) => o.pos < (headings[0]?.pos ?? Number.POSITIVE_INFINITY));
  if (beforeFirst || rows.length === 0) rows.unshift({ title: "Opening", pos: 0, level: 1 });
  const offset = rows[0]?.title === "Opening" && rows[0].pos === 0 && beforeFirst ? 1 : 0;
  const uses: OverviewUse[] = occurrences.map((o) => {
    let row = offset - 1;
    for (let i = 0; i < headings.length; i++) {
      if ((headings[i]?.pos ?? 0) < o.pos) row = i + offset;
      else break;
    }
    return { row: Math.max(row, 0), name: o.name, role: o.role, pos: o.pos };
  });
  const names: string[] = [];
  for (const u of uses) if (!names.includes(u.name)) names.push(u.name);
  return { rows, names, uses };
}
