/**
 * What a skill brings with it, as the author thinks of it rather than as the
 * package stores it: scripts, examples, references, assets — read from where
 * each file sits and what it is, never asked for. What a file is for comes
 * from the instructions themselves when they say so (the line that mentions
 * it), else from the file's own first comment. Every inference here is plain
 * and deterministic, so the Studio can always say why.
 */
import type { SkillFileEntry } from "../bindings/SkillFileEntry";
import type { ConditionKind } from "./applicability";
import { TAG_LABELS, tagFromInput } from "./tags";

export type MaterialKind = "script" | "example" | "reference" | "asset" | "other";

export const KIND_NAME: Record<MaterialKind, { one: string; many: string }> = {
  script: { one: "script", many: "scripts" },
  example: { one: "example", many: "examples" },
  reference: { one: "reference", many: "references" },
  asset: { one: "asset", many: "assets" },
  other: { one: "file", many: "files" },
};

/** A small mark per kind, set in the machine face. */
export const KIND_GLYPH: Record<MaterialKind, string> = {
  script: "▶",
  example: "‹›",
  reference: "¶",
  asset: "◫",
  other: "▤",
};

export const KIND_ORDER: MaterialKind[] = ["script", "example", "reference", "asset", "other"];

const DOC = /\.(md|markdown|txt|rst|adoc|pdf|html?)$/i;
const IMAGE = /\.(png|jpe?g|gif|webp|svg|ico)$/i;
const NOTICE = /^(license|licence|notice|copying)(\.|$)/i;

/** The package's own files (SKILL.md and habi.yaml) are the skill, not material. */
export function isMaterial(path: string): boolean {
  return path !== "SKILL.md" && !/^habi\.ya?ml$/.test(path);
}

export function materialKind(path: string, executable = false): MaterialKind {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const top = path.includes("/") ? path.slice(0, path.indexOf("/")).toLowerCase() : "";
  if (NOTICE.test(name)) return "other";
  if (top === "examples" || top === "example" || /(^|[_.-])examples?([_.-]|$)/i.test(name)) return "example";
  if (top === "scripts" || top === "bin" || executable) return "script";
  if (top === "references" || top === "reference" || top === "docs") return "reference";
  if (top === "assets" || top === "templates" || IMAGE.test(name)) return "asset";
  if (DOC.test(name)) return "reference";
  return "other";
}

export type Material = SkillFileEntry & {
  kind: MaterialKind;
  name: string;
  /** The instructions mention it, so agents can find it. */
  referenced: boolean;
  /** What it is for, in the instructions' own words, when they say. */
  described: string | null;
};

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** Whether the instructions point at a file: by its path, or by its name when that is unmistakable. */
export function mentions(body: string, path: string, all: string[] = []): boolean {
  if (body.includes(path)) return true;
  const name = baseName(path);
  if (name.length < 4 || all.filter((p) => baseName(p) === name).length > 1) return false;
  return new RegExp(`(^|[\\s\`'"(/\\[])${escapeRe(name)}($|[\\s\`'")\\],.:;])`, "m").test(body);
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Inline Markdown reduced to words. */
function plain(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** "- `scripts/x.py` - Manages the server" → "Manages the server". */
export function describedIn(body: string, path: string): string | null {
  const name = baseName(path);
  for (const line of body.split(/\r?\n/)) {
    const hit = line.includes(path) ? path : name;
    if (!line.includes(path) && !line.includes(`\`${name}\``) && !line.includes(`[${name}]`)) continue;
    const rest = line
      .slice(line.indexOf(hit) + hit.length)
      .replace(/^[`*_\])]*(\([^)]*\))?/, "")
      .trim();
    const said = /^(?:[-–—:]|\s)+(.+)$/.exec(rest)?.[1];
    if (said && /[a-z]/i.test(said)) return sentence(plain(said));
  }
  return null;
}

function sentence(text: string): string {
  const t = text.replace(/[.:;,\s]+$/, "");
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

/** A file's own first line of explanation: a docstring, a comment, a heading. */
export function fileLede(text: string): string | null {
  const lines = text.split(/\r?\n/).slice(0, 40);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#!") || /^#\s*-\*-/.test(line) || /^(import|from|use|package)\s/.test(line))
      continue;
    const said =
      /^(?:"""|''')\s*(.+?)(?:"""|''')?$/.exec(line)?.[1] ??
      /^(?:#+|\/\/+|\/\*+|\*|--|;+|<!--)\s*(.+?)(?:\s*\*\/|\s*-->)?$/.exec(line)?.[1];
    if (said === undefined) return null;
    const cleaned = plain(said).replace(/^(example|script|usage|note|about)\s*[:—–-]\s*/i, "");
    if (cleaned.length >= 6 && /[a-z]/i.test(cleaned)) return sentence(cleaned);
  }
  return null;
}

export function materialsOf(files: SkillFileEntry[], body: string): Material[] {
  const paths = files.map((f) => f.path);
  return files
    .filter((f) => isMaterial(f.path))
    .map((f) => ({
      ...f,
      kind: materialKind(f.path, f.executable),
      name: baseName(f.path),
      referenced: mentions(body, f.path, paths),
      described: describedIn(body, f.path),
    }))
    .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.path.localeCompare(b.path));
}

/** "1 script · 3 examples · LICENSE.txt" — what comes with a skill, in one line. */
export function materialsLine(materials: Material[]): string {
  const parts: string[] = [];
  for (const kind of KIND_ORDER) {
    const of = materials.filter((m) => m.kind === kind);
    if (of.length === 0) continue;
    if (kind === "other" && of.length <= 2) parts.push(...of.map((m) => m.name));
    else parts.push(`${of.length} ${of.length === 1 ? KIND_NAME[kind].one : KIND_NAME[kind].many}`);
  }
  return parts.join(" · ");
}

// ----- signals: what Habi looks for before suggesting a skill

export type Signal = { kind: ConditionKind; value: string };

/** A signal as a fact about a project: "Playwright is used". */
export function signalWords(s: Signal): { text: string; code?: string } {
  if (s.kind === "tag") {
    const label = TAG_LABELS[s.value];
    if (!label) return { text: "Tagged", code: s.value };
    if (s.value.startsWith("lang:")) return { text: `${label} code is present` };
    if (s.value === "api:openapi") return { text: "An OpenAPI specification is present" };
    return { text: `${label} is used` };
  }
  if (s.kind === "dependency") return { text: "Depends on", code: s.value };
  return { text: "Has files matching", code: s.value };
}

/** The same fact inside a sentence: "suggest it when Playwright is used", "… when it depends on x". */
export function signalClause(s: Signal): string {
  const w = signalWords(s);
  const text = s.kind === "tag" ? w.text : `it ${w.text.charAt(0).toLowerCase()}${w.text.slice(1)}`;
  return w.code ? `${text} ${w.code}` : text;
}

export type Proposal = Signal & { why: string };

/**
 * What Habi could look for, from a few words: a technology it detects, a
 * dependency, a file pattern. The author picks one; nothing is guessed silently.
 */
export function proposeSignals(input: string): Proposal[] {
  const text = input.trim();
  if (!text) return [];
  const out: Proposal[] = [];
  const lower = text.toLowerCase();
  const exact = tagFromInput(text);
  if (exact) out.push({ kind: "tag", value: exact, why: "Detected in the project" });
  for (const [tag, label] of Object.entries(TAG_LABELS)) {
    if (tag === exact || out.length >= 3) continue;
    const l = label.toLowerCase();
    if (lower.length >= 2 && (l.startsWith(lower) || (lower.length >= 4 && l.includes(lower)))) {
      out.push({ kind: "tag", value: tag, why: "Detected in the project" });
    }
  }
  // A few letters of a technology's name are that technology, not a package called "playw".
  const partial = out.length > 0 && !exact;
  if (partial) return out;
  const glob = /[*/]/.test(text) || /^[^\s]+\.[a-z0-9]{1,6}$/i.test(text);
  const coordinate = /^(@[\w.-]+\/[\w.-]+|[\w.-]+:[\w.-]+(:[\w.-]+)?)$/.test(text);
  const word = /^[\w.@/-]+$/.test(text) && !text.includes("*");
  if (coordinate || (word && !glob)) {
    out.push({ kind: "dependency", value: coordinate ? text : lower, why: "A declared dependency" });
  }
  if (glob && !text.startsWith("@")) {
    out.push({ kind: "file", value: text, why: "A file in the project" });
  } else if (word && !coordinate && /^[a-z][\w-]*$/i.test(text)) {
    out.push({ kind: "file", value: `**/${lower}.config.*`, why: "Its configuration file" });
  }
  return out;
}

const AMBIGUOUS = new Set(["lang:go", "lang:csharp", "framework:vue", "framework:next", "lang:rust"]);

/**
 * Technologies the instructions keep talking about: a hint that the skill
 * belongs with projects that use them. Two mentions at least, ambiguous
 * words never, the most-mentioned first.
 */
export function technologiesIn(body: string): string[] {
  const text = body.replace(/```[\s\S]*?```/g, " ");
  const counts: [string, number][] = [];
  for (const [tag, label] of Object.entries(TAG_LABELS)) {
    if (AMBIGUOUS.has(tag) || label.length < 3) continue;
    const n = (text.match(new RegExp(`\\b${escapeRe(label)}\\b`, "gi")) ?? []).length;
    if (n >= 2) counts.push([tag, n]);
  }
  return counts.sort((a, b) => b[1] - a[1]).map(([tag]) => tag);
}

/** The first top-level heading, which is what most skills are called. */
export function firstHeading(body: string): string | null {
  const line = /^ {0,3}#[ \t]+(.+?)[ \t#]*$/m.exec(body)?.[1];
  return line ? plain(line) : null;
}

/** The opening of the instructions, when it reads as what the skill is for. */
export function openingSentence(body: string): string | null {
  const text = body.replace(/```[\s\S]*?```/g, "\n");
  for (const block of text.split(/\n\s*\n/)) {
    const line = block.trim();
    if (!line || /^(#|[-*+] |\d+\. |>|\||<)/.test(line)) continue;
    const words = plain(line);
    if (words.length < 30) return null;
    const end = words.search(/[.!?](\s|$)/);
    const first = end > 0 ? words.slice(0, end + 1) : words;
    return first.length <= 300 ? first : `${first.slice(0, 297).replace(/\s+\S*$/, "")}…`;
  }
  return null;
}
