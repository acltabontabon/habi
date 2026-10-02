import { describe, expect, it } from "vitest";
import type { Source } from "../bindings/Source";
import { DYE_COUNT, dyeMap } from "./dye";

function source(id: string, createdAt: string): Source {
  return {
    id,
    name: id,
    kind: "git",
    role: "team",
    location: `https://github.com/acme/${id}.git`,
    subdir: null,
    tracked: { kind: "default" },
    createdAt,
    snapshot: "abc",
    snapshotAt: createdAt,
    commitSummary: null,
    lastAttemptAt: null,
    lastError: null,
    warning: null,
    freshness: "current",
    sample: false,
    skillCount: 0,
    preview: false,
    catalogId: null,
    include: [],
    exclude: [],
    defaultBranch: null,
  };
}

const colors = (sources: Source[]) =>
  Object.fromEntries([...dyeMap(sources)].map(([id, dye]) => [id, dye.color]));

describe("library colors", () => {
  const team = source("3f1c9a2e-team", "2026-10-01T00:00:00Z");
  const sample = source("b07d5e11-sample", "2026-10-02T00:00:00Z");
  const docs = source("e94a6c03-docs", "2026-10-03T00:00:00Z");

  it("keeps each library's color when another is removed or added", () => {
    const before = colors([team, sample, docs]);
    expect(new Set(Object.values(before)).size).toBe(3);
    expect(colors([team, docs])).toEqual({ [team.id]: before[team.id], [docs.id]: before[docs.id] });
    const again = source("5a8e2f47-sample", "2026-10-04T00:00:00Z");
    const after = colors([team, docs, again]);
    expect(after[team.id]).toBe(before[team.id]);
    expect(after[docs.id]).toBe(before[docs.id]);
  });

  it("gives every library its own color while there are colors to spare", () => {
    const many = Array.from({ length: DYE_COUNT }, (_, i) =>
      source(`library-${i}`, `2026-10-0${i + 1}T00:00:00Z`),
    );
    expect(new Set(Object.values(colors(many))).size).toBe(DYE_COUNT);
  });
});
