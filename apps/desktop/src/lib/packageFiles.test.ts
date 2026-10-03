import { describe, expect, it } from "vitest";
import type { SkillFileEntry } from "../bindings/SkillFileEntry";
import { innerDir, kindOf, packageTree, runCommand, withExtension } from "./packageFiles";

const file = (path: string, executable = false): SkillFileEntry => ({
  path,
  size: 1,
  digest: path,
  executable,
  text: true,
});

describe("packageTree", () => {
  const files = [
    file("assets/logo.png"),
    file("SKILL.md"),
    file("examples/a.py"),
    file("references/guide.md"),
    file("habi.yaml"),
    file("LICENSE.txt"),
    file("scripts/check.py", true),
  ];

  it("puts the skill first, then the standard folders, then the rest", () => {
    const tree = packageTree(files);
    expect(tree.core.map((f) => f.path)).toEqual(["SKILL.md", "habi.yaml"]);
    expect(tree.root.map((f) => f.path)).toEqual(["LICENSE.txt"]);
    expect(tree.folders.map((f) => f.name)).toEqual(["scripts", "references", "assets", "examples"]);
  });

  it("filters by path, keeping the shape", () => {
    const tree = packageTree(files, "PY");
    expect(tree.core).toEqual([]);
    expect(tree.folders.map((f) => f.name)).toEqual(["scripts", "examples"]);
  });
});

describe("files", () => {
  it("knows what each file is for", () => {
    expect(kindOf("SKILL.md")).toBe("instructions");
    expect(kindOf("habi.yml")).toBe("rules");
    expect(kindOf("tools/run", true)).toBe("script");
    expect(kindOf("references/a.md")).toBe("reference");
    expect(innerDir("references/deep/a.md")).toBe("deep/");
    expect(innerDir("references/a.md")).toBe("");
  });

  it("says how a person would run a script, from its shebang or extension", () => {
    expect(runCommand("scripts/check.py")).toBe("python3 scripts/check.py");
    expect(runCommand("scripts/x", "#!/usr/bin/env bash")).toBe("bash scripts/x");
    expect(runCommand("scripts/x", "#!/bin/zsh")).toBe("zsh scripts/x");
    expect(runCommand("scripts/tool")).toBe("./scripts/tool");
  });

  it("adds the extension only when none was typed", () => {
    expect(withExtension("check", ".py")).toBe("check.py");
    expect(withExtension("check.sh", ".py")).toBe("check.sh");
    expect(withExtension("v1.2/run", ".py")).toBe("v1.2/run.py");
  });
});
