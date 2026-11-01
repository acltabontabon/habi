import { describe, expect, it } from "vitest";
import { purposeHint, realWords, refinements, unfinishedLines } from "./coach";

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
  refinements({ description: "", body: "", ...over });

describe("refinements", () => {
  it("finds what a starter left unfilled, and nothing inside code", () => {
    expect(unfinishedLines(starter).map((u) => u.line)).toEqual([3, 8, 9, 11, 18]);
    expect(unfinishedLines("```\n1. \n…\n```\nDone.")).toEqual([]);
    expect(realWords(starter)).toBeLessThan(25);
  });

  it("puts the most useful refinement first, each with its action", () => {
    const r = ask({ description: "haha", body: starter });
    expect(r.map((x) => x.kind)).toEqual(["unfinished"]);
    expect(r[0]).toMatchObject({ text: "5 places still read like the starter.", line: 3 });
  });

  it.each([
    "Review code",
    "Reviews changes for correctness and security",
    "Summarize meeting notes into decisions and next steps",
  ])("accepts a description without requiring trigger words: %s", (description) => {
    expect(ask({ description })).toEqual([]);
  });

  it("accepts concise finished instructions without a minimum word count", () => {
    expect(ask({ description: "Summarize notes", body: "Return three bullet points." })).toEqual([]);
  });

  it("offers an opening line only when the description is missing", () => {
    const body =
      "Before approving a Liquibase changeset, check that every change can be rolled back safely.\n\nRead the Liquibase changelog.";
    const r = ask({ body });
    expect(r[0]).toMatchObject({ kind: "opening", action: "Use the opening line" });
    expect(r).toHaveLength(1);
  });

  it("asks for a trigger under the purpose, and for the key use first once it is long", () => {
    expect(purposeHint("")).toMatch(/Agents read only this/);
    expect(purposeHint("Reviews Liquibase changesets for safe rollback and locks")).toMatch(/No trigger yet/);
    expect(purposeHint("Reviews Liquibase changesets. Use when a change edits a changelog.")).toMatch(
      /Agents read only this/,
    );
    expect(purposeHint(`Use when ${"reviewing ".repeat(60)}`)).toMatch(/Key use first/);
    const r = ask({ description: `Use when ${"reviewing ".repeat(60)}`, body: "" });
    expect(r).toEqual([]);
  });

  it("says nothing once the skill is well made", () => {
    const body = `${"Check each migration for a rollback block and for locks on large tables before approving. ".repeat(4)}`;
    const r = ask({
      description: "Reviews Liquibase changesets. Use when a change adds or edits a changelog.",
      body,
    });
    expect(r).toEqual([]);
  });
});

it.each(["Return three bullet points.", "Review the Liquibase changelog."])(
  "does not require optional project conditions: %s",
  (body) => {
    expect(ask({ description: "Review changes", body })).toEqual([]);
  },
);
