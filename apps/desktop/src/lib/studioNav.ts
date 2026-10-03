/**
 * Places inside the Skill Studio a problem, a dialog or the palette can send
 * the author to — the field, layer, file or line that fixes it.
 */
import type { Diagnostic } from "../bindings/Diagnostic";

/**
 * The layers of one skill: the knowledge itself, when Habi suggests it, what
 * comes with it, and — for those who ask — the package as files.
 */
export type StudioLayer = "skill" | "when" | "materials" | "source";
export type StudioField = "title" | "description" | "identifier";

export type NavTarget = {
  layer?: StudioLayer;
  /** A field of the skill's identity. */
  field?: StudioField;
  /** A package file (opens it with the materials). */
  path?: string;
  /** 1-based line in the instructions or the file. */
  line?: number;
};

export function targetLabel(t: NavTarget): string {
  if (t.field === "description") return "Edit the purpose";
  if (t.field === "identifier") return "Change the identifier";
  if (t.field === "title") return "Edit the title";
  if (t.layer === "when") return "Open When to use";
  if (t.layer === "skill") return t.line ? `Go to line ${t.line}` : "Open the instructions";
  if (t.path) return `Open ${t.path.split("/").pop()}`;
  return "Open Materials";
}

const isMetadata = (path: string | null) => path !== null && /(^|\/)habi\.ya?ml$/.test(path);

/** Validator wording rephrased for the author, with where it is fixed. */
export function plainProblem(d: Diagnostic): { text: string; target: NavTarget | null } {
  const m = d.message;
  const line = d.line ?? undefined;
  switch (d.code) {
    case "missingDescription":
      return {
        text: "Describe what the skill helps with and when an agent should use it. Agents decide whether to load a skill from this text alone.",
        target: { field: "description" },
      };
    case "descriptionTooLong":
      return {
        text: "The purpose is longer than the 1024 characters the format allows.",
        target: { field: "description" },
      };
    case "invalidName":
    case "duplicateName":
      return { text: `The identifier needs attention: ${m}`, target: { field: "identifier" } };
    case "invalidMetadata":
      return { text: `When to use needs attention: ${m}`, target: { layer: "when" } };
    case "brokenLink":
    case "missingReferencedFile":
      return d.path === "SKILL.md" || d.path === null
        ? { text: m, target: { layer: "skill", line } }
        : { text: `${d.path}: ${m}`, target: { path: d.path, line } };
    default:
      break;
  }
  // Diagnostics without a code (older cores, library checks) by their wording.
  if (m === "SKILL.md has no `description`") return plainProblem({ ...d, code: "missingDescription" });
  if (m === "SKILL.md has no `name`" || m.startsWith("`name` ")) {
    return {
      text: `Give the skill a valid identifier${m.startsWith("`name` ") ? ` — it ${m.slice(7)}` : ""}.`,
      target: { field: "identifier" },
    };
  }
  if (isMetadata(d.path)) {
    return { text: `When to use needs attention: ${m}`, target: { layer: "when" } };
  }
  if (d.path === "SKILL.md") return { text: m, target: { layer: "skill", line } };
  return { text: d.path ? `${d.path}: ${m}` : m, target: d.path ? { path: d.path, line } : null };
}
