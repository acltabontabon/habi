import { describe, expect, it } from "vitest";
import type { ItemFile } from "../bindings/ItemFile";
import { codeFiles, packageShape, summarize } from "./skillFacts";

const file = (path: string, executable = false): ItemFile => ({ path, digest: "", size: 1, executable });

describe("skill facts", () => {
  it("keeps what a skill is and leaves trigger instructions for the full description", () => {
    const s = summarize(
      "Reference for the Claude API / Anthropic SDK — model ids, pricing, params. TRIGGER — read BEFORE opening the target file; SKIP when another provider is used.",
    );
    expect(s.text).toBe("Reference for the Claude API / Anthropic SDK — model ids, pricing, params.");
    expect(s.shortened).toBe(true);
    expect(summarize("Review JPA entity mappings. Use when entity classes change.").text).toBe(
      "Review JPA entity mappings.",
    );
    expect(summarize("A short, plain description.")).toEqual({
      text: "A short, plain description.",
      shortened: false,
    });
  });

  it("shortens long descriptions at a sentence, never mid-word", () => {
    const long = `${"Word ".repeat(30)}ends here. ${"More text ".repeat(20)}`;
    const s = summarize(long);
    expect(s.text.length).toBeLessThanOrEqual(201);
    expect(s.text.endsWith("ends here.")).toBe(true);
    expect(s.shortened).toBe(true);
  });

  it("counts code, not everything under scripts/", () => {
    const files = [
      file("scripts/run.py"),
      file("scripts/schema.xsd"),
      file("scripts/templates/a.xml"),
      file("bin/tool", true),
    ];
    expect(codeFiles({ files })).toBe(2);
  });

  it("recognizes language folders only when there are several side by side", () => {
    const shape = packageShape([
      file("SKILL.md"),
      file("LICENSE.txt"),
      file("java/claude-api/README.md"),
      file("python/claude-api/README.md"),
      file("shared/models.md"),
      file("shared/evals/report.mjs"),
    ]);
    expect(shape.root.map((f) => f.path)).toEqual(["SKILL.md", "LICENSE.txt"]);
    expect(shape.languages.map((g) => g.label)).toEqual(["Java", "Python"]);
    expect(shape.folders.map((g) => g.folder)).toEqual(["shared"]);
    expect(shape.code.map((f) => f.path)).toEqual(["shared/evals/report.mjs"]);

    const single = packageShape([file("SKILL.md"), file("python/helper.py"), file("references/a.md")]);
    expect(single.languages).toEqual([]);
    expect(single.folders.map((g) => g.folder)).toEqual(["python", "references"]);
  });
});
