import { describe, expect, it } from "vitest";
import { realWords, refinements, unfinishedLines } from "./coach";
import { tagLabel } from "./tags";

const starter = `## When to use this

Use this when …

## Steps

1. Read the relevant code before changing anything, and say which files you looked at.
2.
3.

## Context



## Done when

- The change builds and the existing tests pass.
-
`;

const ask = (over: Partial<Parameters<typeof refinements>[0]>) =>
  refinements({ title: "T", description: "", body: "", signals: 0, tagsLabel: tagLabel, ...over });

describe("refinements", () => {
  it("finds what a starter left unfilled, and nothing inside code", () => {
    expect(unfinishedLines(starter).map((u) => u.line)).toEqual([3, 8, 9, 11, 18]);
    expect(unfinishedLines("```\n1. \n…\n```\nDone.")).toEqual([]);
    expect(realWords(starter)).toBeLessThan(25);
  });

  it("puts the most useful refinement first, each with its action", () => {
    const r = ask({ description: "haha", body: starter });
    expect(r.map((x) => x.kind)).toEqual(["unfinished", "purpose", "instructions", "signals"]);
    expect(r[0]).toMatchObject({ text: "5 places still read like the starter.", line: 3 });
    expect(r[1]?.text).toBe("“haha” is all an agent reads before choosing this skill.");
  });

  it("offers the opening line as a purpose, and a technology the instructions keep naming", () => {
    const body =
      "Before approving a Liquibase changeset, check that every change can be rolled back safely.\n\nRead the Liquibase changelog.";
    const r = ask({ body });
    expect(r[0]).toMatchObject({ kind: "opening", action: "Use the opening line" });
    expect(r.find((x) => x.kind === "inferred")).toMatchObject({
      text: "Looks related to Liquibase projects.",
    });
  });

  it("says nothing once the skill is well made", () => {
    const body = `${"Check each migration for a rollback block and for locks on large tables before approving. ".repeat(4)}`;
    const r = ask({
      description: "Reviews Liquibase changesets. Use when a change adds or edits a changelog.",
      body,
      signals: 1,
    });
    expect(r).toEqual([]);
  });
});
