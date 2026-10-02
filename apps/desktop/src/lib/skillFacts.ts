/** Small facts about a library item, said the same way everywhere. */
import type { Condition } from "../bindings/Condition";
import type { ItemFile } from "../bindings/ItemFile";
import { tagLabel } from "./tags";

/** Source files an agent could run. Schemas, templates and data under `scripts/` are not code. */
const CODE_FILE = /\.(py|sh|bash|zsh|fish|js|mjs|cjs|ts|mts|rb|pl|php|ps1|lua|go|rs|swift|kts?)$/i;

export function isCode(file: ItemFile): boolean {
  return file.executable || CODE_FILE.test(file.path);
}

/** Files in the package an agent could run. */
export function codeFiles(item: { files: ItemFile[] }): number {
  return item.files.filter(isCode).length;
}

/** What the author declared and where the terms are; never an interpretation. */
export function licenseText(declared: string | null, file: string | null): string {
  if (declared && file) return `${declared} (terms: ${file})`;
  if (declared) return declared;
  if (file) return `see ${file}`;
  return "none found";
}

/** A rule, in words. */
export function describeCondition(c: Condition): string {
  switch (c.op) {
    case "all":
      return c.items.map(describeCondition).join(" and ");
    case "any":
      return `(${c.items.map(describeCondition).join(" or ")})`;
    case "not":
      return `not ${describeCondition(c.item)}`;
    case "dependency":
      return `depends on ${c.name}${c.version ? ` ${c.version}` : ""}`;
    case "file":
      return `has files matching ${c.glob}`;
    case "tag":
      return tagLabel(c.tag);
  }
}

/** "github.com/obra/superpowers#brainstorming@8ca22db" → parts to show. */
export function lineageParts(value: string): { library: string; item: string; version: string } {
  const [library = value, rest = ""] = value.split("#");
  const [item = "", version = ""] = rest.split("@");
  return { library, item, version };
}

/*
 * Many SKILL.md descriptions are written for the agent: what the skill is,
 * then when to trigger it, in detail. The person reading needs the first
 * part. This is presentation only — the full description stays one click
 * away, exactly as written.
 */
const AGENT_CUES =
  /\s*(?:\bTRIGGER\b|\bSKIP\b|\bTrigger (?:on|when|if)\b|\bUse (?:this skill |it )?(?:when|whenever|if|for|before|after)\b|\bThis skill should be used\b|\bInvoke (?:when|whenever)\b|\bActivate (?:when|whenever)\b)/i;
const LIMIT = 200;

export function summarize(description: string): { text: string; shortened: boolean } {
  const full = description.replace(/\s+/g, " ").trim();
  let text = full;
  const cue = full.search(AGENT_CUES);
  if (cue >= 24) text = full.slice(0, cue);
  if (text.length > LIMIT) {
    const window = text.slice(0, LIMIT);
    const sentence = Math.max(window.lastIndexOf(". "), window.lastIndexOf("; "));
    text = sentence >= 60 ? window.slice(0, sentence + 1) : `${window.slice(0, window.lastIndexOf(" "))}…`;
  }
  text = text.replace(/[\s—–:;,-]+$/, "");
  if (text !== full && !/[.…!?]$/.test(text)) text += ".";
  return { text, shortened: text.replace(/[.…]$/, "") !== full.replace(/[.…]$/, "") };
}

/* ---------- The shape of a package ---------- */

/**
 * Folder names that mean a programming language. Used only when a package
 * has two or more of them side by side — then they are clearly variants of
 * the same material, and Habi can say "8 languages" instead of "8 folders".
 */
const LANGUAGES: Record<string, string> = {
  bash: "Bash",
  c: "C",
  cpp: "C++",
  csharp: "C#",
  curl: "cURL",
  dart: "Dart",
  dotnet: ".NET",
  elixir: "Elixir",
  go: "Go",
  golang: "Go",
  java: "Java",
  javascript: "JavaScript",
  js: "JavaScript",
  kotlin: "Kotlin",
  node: "Node.js",
  nodejs: "Node.js",
  php: "PHP",
  powershell: "PowerShell",
  python: "Python",
  py: "Python",
  ruby: "Ruby",
  rust: "Rust",
  scala: "Scala",
  shell: "Shell",
  swift: "Swift",
  ts: "TypeScript",
  typescript: "TypeScript",
};

export type PackageGroup = {
  /** The top-level folder ("" for files at the root). */
  folder: string;
  /** How to name it: the folder, or its language. */
  label: string;
  files: ItemFile[];
  code: number;
};

export type PackageShape = {
  count: number;
  /** Files at the root, the main document first. */
  root: ItemFile[];
  /** Top-level folders that are languages (only when there are two or more). */
  languages: PackageGroup[];
  /** Every other top-level folder. */
  folders: PackageGroup[];
  /** Files an agent could run, wherever they are. */
  code: ItemFile[];
};

function topFolder(path: string): string {
  return path.includes("/") ? path.slice(0, path.indexOf("/")) : "";
}

export function packageShape(files: ItemFile[], main = "SKILL.md"): PackageShape {
  const byFolder = new Map<string, ItemFile[]>();
  for (const f of files) {
    const top = topFolder(f.path);
    byFolder.set(top, [...(byFolder.get(top) ?? []), f]);
  }
  const root = (byFolder.get("") ?? []).sort((a, b) =>
    a.path === main ? -1 : b.path === main ? 1 : a.path.localeCompare(b.path),
  );
  const groups = [...byFolder.entries()]
    .filter(([folder]) => folder !== "")
    .map(([folder, members]) => ({
      folder,
      label: folder,
      files: members.sort((a, b) => a.path.localeCompare(b.path)),
      code: members.filter(isCode).length,
    }))
    .sort((a, b) => a.folder.localeCompare(b.folder));
  const languageGroups = groups.filter((g) => LANGUAGES[g.folder.toLowerCase()]);
  const isLanguages = languageGroups.length >= 2;
  return {
    count: files.length,
    root,
    languages: isLanguages
      ? languageGroups.map((g) => ({ ...g, label: LANGUAGES[g.folder.toLowerCase()] ?? g.folder }))
      : [],
    folders: isLanguages ? groups.filter((g) => !LANGUAGES[g.folder.toLowerCase()]) : groups,
    code: files.filter(isCode),
  };
}
