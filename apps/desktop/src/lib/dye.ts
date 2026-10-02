/**
 * Each library has its own dye: the color of its warp thread wherever its
 * items appear. Colors follow the order libraries were connected in, so they
 * stay put as libraries are added. My skills are spun from plain ink.
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

export function dyeMap(sources: Source[]): Map<string, Dye> {
  const ordered = [...sources].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
  return new Map(
    ordered.map((s, i) => [
      s.id,
      { color: `var(--dye-${i % DYE_COUNT})`, community: s.role === "community" },
    ]),
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
