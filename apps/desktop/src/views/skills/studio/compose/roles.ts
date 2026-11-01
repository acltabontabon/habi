/**
 * How one skill contributes to another, in words a person would use, and how
 * that reads in the instructions. The sentence is what the agent gets. The role
 * is what the author meant, so Habi can show it and change it, and it never asks
 * an agent to do anything but read.
 */
import type { Node as PMNode } from "prosemirror-model";
import type { ComposeEntry } from "../../../../bindings/ComposeEntry";
import type { ComposeSource } from "../../../../bindings/ComposeSource";
import { canonOf } from "../doc/markdown/canon";

export type RoleId = "when-relevant" | "before" | "after" | "if-available" | "alongside";

/** A mention whose job Habi doesn't know: outside edits changed it, or it was never said. */
export const USED_HERE = "used";

export type RoleInfo = {
  id: RoleId;
  /** What the author picks. */
  label: string;
  /** How it reads beside the skill's name. */
  short: string;
  /** The sentence, around a mention. `…` is the part only the author can fill in. */
  before: string;
  after: string;
};

export const ROLES: RoleInfo[] = [
  {
    id: "when-relevant",
    label: "When it's relevant",
    short: "when relevant",
    before: "When …, use the ",
    after: ".",
  },
  { id: "before", label: "Before something", short: "before", before: "Before …, check the ", after: "." },
  {
    id: "after",
    label: "Afterwards",
    short: "afterwards",
    before: "When that's done, continue with the ",
    after: ".",
  },
  {
    id: "if-available",
    label: "If it's available",
    short: "if available",
    before: "If you have the ",
    after: ", use it for ….",
  },
  {
    id: "alongside",
    label: "Alongside the work",
    short: "alongside",
    before: "Follow the ",
    after: " as you work.",
  },
];

export const roleInfo = (id: string | null | undefined): RoleInfo | undefined =>
  ROLES.find((r) => r.id === id);

export function roleWords(id: string | null | undefined): string {
  return roleInfo(id)?.short ?? "used here";
}

/** Whether a skill is optional: only when every use of it says so. */
export function isOptional(roles: readonly string[]): boolean {
  return roles.length > 0 && roles.every((r) => r === "if-available");
}

const escapeForPattern = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function patternFor(role: RoleInfo, mention: string): RegExp {
  const blank = "(.+?)";
  const left = escapeForPattern(role.before).replace("…", blank);
  const right = escapeForPattern(role.after).replace("…", blank);
  return new RegExp(`^${left}${escapeForPattern(mention)}${right}$`);
}

export type TemplateMatch = { role: RoleId; blank: string | null };

/**
 * The role a sentence says, if it's word for word one of Habi's own. Exact on
 * purpose: an author's sentence is never interpreted, so "Never use the X skill"
 * can't be read as a use of it.
 */
export function matchTemplate(markdown: string, mention: string): TemplateMatch | null {
  const line = markdown.trim();
  for (const role of ROLES) {
    const m = patternFor(role, mention).exec(line);
    if (m) return { role: role.id, blank: m[1] ?? null };
  }
  return null;
}

/** The sentence for a role, keeping what the author filled in if the new wording has room for it. */
export function sentenceFor(id: RoleId, mention: string, blank: string | null = null): string {
  const role = roleInfo(id) ?? (ROLES[0] as RoleInfo);
  const fill = blank && blank !== "…" ? blank : "…";
  return `${role.before.replace("…", fill)}${mention}${role.after.replace("…", fill)}`;
}

export const mentionOf = (name: string) => `\`${name}\` skill`;

// ----- one skill, several uses

export type { ComposeEntry, ComposeSource };

export type Occurrence = {
  name: string;
  plugin: string | null;
  role: string | null;
  from: ComposeSource | null;
  /** Position in the document. */
  pos: number;
  /** The textblock holding it, and that block's position. */
  block: PMNode;
  blockPos: number;
};

/** Every mention of a skill in the document, in order. */
export function occurrencesIn(doc: PMNode): Occurrence[] {
  const out: Occurrence[] = [];
  doc.descendants((node, pos, parent) => {
    if (node.type.name !== "skill_ref") return true;
    const fromAttr = node.attrs.from as string | null;
    let from: ComposeSource | null = null;
    if (fromAttr) {
      try {
        from = JSON.parse(fromAttr) as ComposeSource;
      } catch {
        from = null;
      }
    }
    let blockPos = pos;
    doc.nodesBetween(pos, pos + 1, (n, p) => {
      if (n.isTextblock) blockPos = p;
      return true;
    });
    out.push({
      name: node.attrs.name as string,
      plugin: node.attrs.plugin as string | null,
      role: node.attrs.role as string | null,
      from,
      pos,
      block: parent ?? doc,
      blockPos,
    });
    return false;
  });
  return out;
}

/**
 * What the document composes. A use is deliberate when its chip carries a role;
 * a dependency is one per skill however often it's used, and goes only when its
 * last use does.
 *
 * Entries with no use at all stay, unless this editing session removed the last
 * one: those came from an edit outside the page, and dropping them silently would
 * lose something the author deliberately wrote.
 */
export function deriveComposes(
  doc: PMNode,
  loaded: readonly ComposeEntry[],
  hadChipThisSession: ReadonlySet<string>,
): ComposeEntry[] {
  const uses = new Map<string, { roles: string[]; from: ComposeSource | null }>();
  for (const o of occurrencesIn(doc)) {
    if (o.role === null) continue;
    const entry = uses.get(o.name) ?? { roles: [], from: null };
    entry.roles.push(o.role);
    entry.from = entry.from ?? o.from;
    uses.set(o.name, entry);
  }
  const out: ComposeEntry[] = [];
  const seen = new Set<string>();
  for (const old of loaded) {
    seen.add(old.skill);
    const now = uses.get(old.skill);
    if (now) {
      const from = old.from ?? now.from ?? undefined;
      out.push(from ? { ...old, roles: now.roles, from } : { skill: old.skill, roles: now.roles });
    } else if (!hadChipThisSession.has(old.skill)) out.push(old);
  }
  for (const [skill, now] of uses) {
    if (seen.has(skill)) continue;
    out.push(now.from ? { skill, roles: now.roles, from: now.from } : { skill, roles: now.roles });
  }
  return out;
}

/**
 * Gives each mention of a composed skill its role when a document opens. The
 * sentence wins if it's one of Habi's; otherwise the saved roles, by position, if
 * the count still matches; otherwise "used here", because guessing could say
 * something the author never meant.
 */
export function rolesForOpening(
  doc: PMNode,
  loaded: readonly ComposeEntry[],
): Map<number, { role: string; from: string | null }> {
  const byName = new Map(loaded.map((e) => [e.skill, e]));
  const counts = new Map<string, number>();
  const all = occurrencesIn(doc);
  for (const o of all) counts.set(o.name, (counts.get(o.name) ?? 0) + 1);
  const seen = new Map<string, number>();
  const out = new Map<number, { role: string; from: string | null }>();
  for (const o of all) {
    const entry = byName.get(o.name);
    if (!entry) continue;
    const index = seen.get(o.name) ?? 0;
    seen.set(o.name, index + 1);
    const stated = matchTemplate(canonOf(o.block), mentionOf(o.name));
    const positional = counts.get(o.name) === entry.roles.length ? entry.roles[index] : undefined;
    out.set(o.pos, {
      role: stated?.role ?? positional ?? USED_HERE,
      from: entry.from ? JSON.stringify(entry.from) : null,
    });
  }
  return out;
}

export const composesKey = (entries: readonly ComposeEntry[]) => JSON.stringify(entries);
