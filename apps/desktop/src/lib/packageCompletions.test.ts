import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { fileKind, packageCompletions, pathAt } from "./packageCompletions";

describe("pathAt", () => {
  it("finds a path being typed in a link or a code span", () => {
    expect(pathAt("See [the guide](refer")).toEqual({ typed: "refer", inCode: false });
    expect(pathAt("Run `scripts/ch")).toEqual({ typed: "scripts/ch", inCode: true });
    expect(pathAt("Plain text")).toBeNull();
    // A closed code span is not being typed in.
    expect(pathAt("Run `ls` then")).toBeNull();
  });
});

describe("packageCompletions", () => {
  const complete = (doc: string, explicit = false) => {
    const state = EditorState.create({ doc });
    const source = packageCompletions(() => ["SKILL.md", "habi.yaml", "scripts/check.py", "references/a.md"]);
    return source(new CompletionContext(state, doc.length, explicit));
  };

  it("offers the package's own files, not SKILL.md or the rules", () => {
    const result = complete("Read [this](");
    expect(result?.options.map((o) => o.label)).toEqual(["scripts/check.py", "references/a.md"]);
    expect(result?.options[0]?.detail).toBe(fileKind("scripts/check.py"));
  });

  it("waits for something path-like inside code", () => {
    expect(complete("Use `x")).toBeNull();
    expect(complete("Use `scripts/")).not.toBeNull();
  });
});
