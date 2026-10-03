/**
 * A skill package as a small tree: SKILL.md and habi.yaml first, then the
 * standard folders (scripts, references, assets), then anything else an
 * imported package brought along — and what each kind of file is for.
 */
import type { SkillFileEntry } from "../bindings/SkillFileEntry";

export type FileKind = "instructions" | "rules" | "script" | "reference" | "asset" | "file";

export function kindOf(path: string, executable = false): FileKind {
  if (path === "SKILL.md") return "instructions";
  if (/^habi\.ya?ml$/.test(path)) return "rules";
  if (path.startsWith("scripts/") || executable) return "script";
  if (path.startsWith("references/")) return "reference";
  if (path.startsWith("assets/")) return "asset";
  return "file";
}

export type TreeFolder = { name: string; path: string; files: SkillFileEntry[] };

export type PackageTree = {
  /** SKILL.md and habi.yaml. */
  core: SkillFileEntry[];
  /** Files at the package root, other than the core. */
  root: SkillFileEntry[];
  /** Top-level folders: the standard three first, then the rest by name. */
  folders: TreeFolder[];
};

const STANDARD = ["scripts", "references", "assets"];

export function packageTree(files: SkillFileEntry[], filter = ""): PackageTree {
  const q = filter.trim().toLowerCase();
  const shown = q ? files.filter((f) => f.path.toLowerCase().includes(q)) : files;
  const core = shown.filter((f) => kindOf(f.path) === "instructions" || kindOf(f.path) === "rules");
  const rest = shown.filter((f) => !core.includes(f));
  const root = rest.filter((f) => !f.path.includes("/"));
  const byFolder = new Map<string, SkillFileEntry[]>();
  for (const f of rest.filter((f) => f.path.includes("/"))) {
    const top = f.path.slice(0, f.path.indexOf("/"));
    byFolder.set(top, [...(byFolder.get(top) ?? []), f]);
  }
  const names = [...byFolder.keys()].sort((a, b) => {
    const ia = STANDARD.indexOf(a);
    const ib = STANDARD.indexOf(b);
    if (ia >= 0 || ib >= 0) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    return a.localeCompare(b);
  });
  return {
    core: core.sort((a) => (a.path === "SKILL.md" ? -1 : 1)),
    root,
    folders: names.map((name) => ({ name, path: name, files: byFolder.get(name) ?? [] })),
  };
}

/** The file name after its folder. */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Where a file sits inside its top-level folder ("" for files directly in it). */
export function innerDir(path: string): string {
  const parts = path.split("/");
  return parts.length > 2 ? `${parts.slice(1, -1).join("/")}/` : "";
}

/**
 * How a person would run a script themselves, from the skill's folder. Habi
 * never runs it; this is only words to copy.
 */
export function runCommand(path: string, firstLine = ""): string {
  const shebang = /^#!\s*(?:\/usr\/bin\/env\s+)?(\S+)/.exec(firstLine)?.[1];
  const ext = path.includes(".") ? path.slice(path.lastIndexOf(".") + 1).toLowerCase() : "";
  const runner =
    (shebang ? baseName(shebang) : null) ??
    (
      {
        py: "python3",
        sh: "bash",
        bash: "bash",
        zsh: "zsh",
        js: "node",
        mjs: "node",
        cjs: "node",
        rb: "ruby",
        ts: "npx tsx",
      } as Record<string, string>
    )[ext];
  return runner ? `${runner} ${path}` : `./${path}`;
}

export type NewFileShape = {
  id: string;
  label: string;
  hint: string;
  folder: string;
  ext: string;
  body: (name: string) => string;
  executable: boolean;
};

const stem = (name: string) =>
  baseName(name)
    .replace(/\.[^.]+$/, "")
    .replace(/[-_]+/g, " ");

/** What "New file" can start: scripts with a useful header, a reference, an example, a blank file. */
export const NEW_FILE_SHAPES: NewFileShape[] = [
  {
    id: "python",
    label: "Python script",
    hint: "scripts/ · with a main and argument parsing",
    folder: "scripts",
    ext: ".py",
    executable: true,
    body: (name) =>
      `#!/usr/bin/env python3\n"""${stem(name)}: what it does, in one line.\n\nUsage: python3 scripts/${baseName(name)} [args]\n"""\nimport argparse\nimport sys\n\n\ndef main() -> int:\n    parser = argparse.ArgumentParser(description=__doc__)\n    parser.parse_args()\n    return 0\n\n\nif __name__ == "__main__":\n    sys.exit(main())\n`,
  },
  {
    id: "shell",
    label: "Shell script",
    hint: "scripts/ · strict mode on",
    folder: "scripts",
    ext: ".sh",
    executable: true,
    body: (name) =>
      `#!/usr/bin/env bash\n# ${stem(name)}: what it does, in one line.\n# Usage: bash scripts/${baseName(name)} [args]\nset -euo pipefail\n\n`,
  },
  {
    id: "javascript",
    label: "JavaScript script",
    hint: "scripts/ · Node, no dependencies",
    folder: "scripts",
    ext: ".mjs",
    executable: true,
    body: (name) =>
      `#!/usr/bin/env node\n// ${stem(name)}: what it does, in one line.\n// Usage: node scripts/${baseName(name)} [args]\n\nconst args = process.argv.slice(2);\n`,
  },
  {
    id: "script",
    label: "Empty script",
    hint: "scripts/",
    folder: "scripts",
    ext: "",
    executable: false,
    body: () => "",
  },
  {
    id: "reference",
    label: "Reference",
    hint: "references/ · Markdown the instructions point to",
    folder: "references",
    ext: ".md",
    executable: false,
    body: (name) => `# ${stem(name).replace(/^\w/, (c) => c.toUpperCase())}\n\n`,
  },
  {
    id: "example",
    label: "Example",
    hint: "examples/ · a worked example the instructions point to",
    folder: "examples",
    ext: ".py",
    executable: false,
    body: (name) => `# Example: ${stem(name)} — what it shows, in one line.\n\n`,
  },
  {
    id: "blank",
    label: "Blank file",
    hint: "anywhere — use a/b.txt for folders",
    folder: "",
    ext: "",
    executable: false,
    body: () => "",
  },
];

/** The file name with the shape's extension, unless one was typed. */
export function withExtension(name: string, ext: string): string {
  const raw = name.trim();
  if (!raw || !ext || /\.[^./]+$/.test(baseName(raw))) return raw;
  return `${raw}${ext}`;
}
