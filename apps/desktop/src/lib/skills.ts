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
    case "library": {
      const from = origin.upstream
        ? `${origin.sourceName} · ${origin.upstream.path}${origin.upstream.url ? ` in ${repoName(origin.upstream.url)}` : ""} @ ${origin.snapshot.slice(0, 7)}`
        : origin.sourceName;
      return `Copied from ${from} to edit`;
    }
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

/** "https://github.com/acme/skills" → "acme/skills". */
export function repoName(url: string): string {
  return url.replace(/^https?:\/\/(www\.)?(github\.com|gitlab\.com|codeberg\.org)\//, "").replace(/\/$/, "");
}

/**
 * Where the original of an adopted skill lives, as a web address, when it can
 * be said exactly: a GitHub repository, a full commit and the skill's path.
 */
export function upstreamUrl(origin: SkillOrigin): string | null {
  if (origin.type !== "library" || !origin.upstream?.url) return null;
  const { url, path } = origin.upstream;
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(url)) return null;
  if (!/^[0-9a-f]{40}$/.test(origin.snapshot)) return null;
  return `${url}/tree/${origin.snapshot}/${path}`;
}

/** The trail back to the original, in one sentence. */
export function provenanceText(origin: SkillOrigin): string | null {
  if (origin.type !== "library" || !origin.upstream) return null;
  const u = origin.upstream;
  const parts = [
    `Adapted from ${u.path}${u.url ? ` in ${repoName(u.url)}` : ` in ${origin.sourceName}`}`,
    origin.snapshot.length >= 7 && /^[0-9a-f]+$/.test(origin.snapshot) ? origin.snapshot.slice(0, 7) : null,
    u.license ? u.license : "licence not stated",
    u.publisher ? `published by ${u.publisher}` : null,
  ];
  return parts.filter(Boolean).join(" · ");
}

/** The first sentence of a description: what it is for, without when to use it. */
export function purpose(description: string): string {
  const text = description.trim();
  const end = text.search(/[.!?](\s|$)/);
  return end > 0 ? text.slice(0, end + 1) : text;
}
