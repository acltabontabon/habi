/** Small helpers for local skills: identifiers, attribution, validation hints. */

import type { SkillOrigin } from "../bindings/SkillOrigin";

/** Mirrors the core's identifier derivation, for live suggestions only. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

/** The Agent Skills rule for `name`; the core enforces it, this explains it. */
export function identifierProblem(name: string): string | null {
  if (!name) return "Needed before the skill can be installed or shared.";
  if (name.length > 64) return "Keep it to 64 characters or fewer.";
  if (!/^[a-z0-9-]+$/.test(name)) return "Use lowercase letters, digits and hyphens only.";
  if (name.startsWith("-") || name.endsWith("-") || name.includes("--"))
    return "Hyphens go between words, one at a time.";
  return null;
}

export function lineRange(start: number, end: number): string {
  return start === end ? `line ${start}` : `lines ${start}–${end}`;
}

export function originText(origin: SkillOrigin): string {
  switch (origin.type) {
    case "created":
      return "Written here";
    case "createdForProject":
      return `Written here for ${origin.projectName}`;
    case "folder":
      return `Copied from ${origin.path}`;
    case "project":
      return `Copied from ${origin.projectName} · ${origin.path}`;
    case "library":
      return `Copied from ${origin.sourceName} to edit`;
    case "instructions":
      return `From ${origin.path} (${lineRange(origin.startLine, origin.endLine)}) in ${origin.projectName}`;
  }
}

export function originShort(origin: SkillOrigin): string {
  switch (origin.type) {
    case "created":
    case "createdForProject":
      return "Written here";
    case "folder":
      return "Copied from a folder";
    case "project":
      return `Copied from ${origin.projectName}`;
    case "library":
      return `From ${origin.sourceName}`;
    case "instructions":
      return `From ${origin.path}`;
  }
}
