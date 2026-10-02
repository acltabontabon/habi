import { describe, expect, it } from "vitest";
import { markdownOutline, sectionAt } from "./markdownOutline";

describe("markdownOutline", () => {
  it("reads ATX and setext headings with their lines", () => {
    const doc = "# Review\n\nIntro\n\n## Before you start\n\nSteps\n-----\n\n### `Report` *now*\n";
    expect(markdownOutline(doc)).toEqual([
      { level: 1, text: "Review", line: 1 },
      { level: 2, text: "Before you start", line: 5 },
      { level: 2, text: "Steps", line: 7 },
      { level: 3, text: "Report now", line: 10 },
    ]);
  });

  it("ignores headings inside fenced code and closing hashes", () => {
    const doc = "## Run ##\n\n```sh\n# not a heading\n```\n\n~~~\n## nor this\n~~~\n## After\n";
    expect(markdownOutline(doc).map((h) => h.text)).toEqual(["Run", "After"]);
  });

  it("keeps link text and drops list items above dashes", () => {
    const doc = "## See [the guide](references/a.md)\n\n- item\n---\n";
    expect(markdownOutline(doc)).toEqual([{ level: 2, text: "See the guide", line: 1 }]);
  });

  it("finds the section a line belongs to", () => {
    const outline = markdownOutline("intro\n## A\ntext\n## B\nmore\n");
    expect(sectionAt(outline, 1)).toBeNull();
    expect(sectionAt(outline, 3)?.text).toBe("A");
    expect(sectionAt(outline, 5)?.text).toBe("B");
  });
});
