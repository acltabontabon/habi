/**
 * Each library has its own dye: the color of its warp thread wherever its
 * items appear. The color comes from the library's id, so it stays put when
 * other libraries are added or removed, or the sample workspace is made
 * again. When two ids land on the same color, the later library takes the
 * next free one; only a library that had to step aside can move. My skills
 * are spun from plain ink.
 */
import { useCallback, useMemo } from "react";
import type { Source } from "../bindings/Source";
import { useSources } from "./queries";

export const DYE_COUNT = 8;
const LOCAL_SOURCE_ID = "local";

export type Dye = {
  /** A CSS color (a custom property reference). */
  color: string;
  /** Community libraries are stitched, not solid: their content was not reviewed by the team. */
  community: boolean;
};

const INK: Dye = { color: "var(--ink-soft)", community: false };

/** FNV-1a: a small, stable string hash. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function dyeMap(sources: Source[]): Map<string, Dye> {
  const ordered = [...sources].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
  const taken = new Set<number>();
  return new Map(
    ordered.map((s) => {
      let slot = hash(s.id) % DYE_COUNT;
      // With every color in use, libraries share; until then each has its own.
      while (taken.size < DYE_COUNT && taken.has(slot)) slot = (slot + 1) % DYE_COUNT;
      taken.add(slot);
      return [s.id, { color: `var(--dye-${slot})`, community: s.role === "community" }];
    }),
  );
}

/** Looks up the dye of a library by source id. */
export function useDyes(): (sourceId: string) => Dye {
  const sources = useSources();
  const map = useMemo(() => dyeMap(sources.data ?? []), [sources.data]);
  return useCallback(
    (sourceId: string) =>
      sourceId === LOCAL_SOURCE_ID
        ? INK
        : (map.get(sourceId) ?? { color: "var(--hairline-strong)", community: false }),
    [map],
  );
}
