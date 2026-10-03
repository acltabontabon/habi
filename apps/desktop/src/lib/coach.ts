/**
 * What would make a skill better, beyond being valid: the parts a starter
 * left unfilled, a purpose too thin for an agent to choose by, instructions
 * too short to follow, no way for Habi to suggest it. Every suggestion is
 * read from the skill itself — deterministic, explainable, never a guess
 * about quality — and comes with the one action that addresses it, most
 * useful first.
 */
import { openingSentence, type Signal, technologiesIn } from "./materials";

/** A line still as a starter left it. */
export type Unfinished = { line: number; why: string };

const EMPTY_ITEM = /^\s*(\d+[.)]|[-*+])\s*$/;
const OPEN_ITEM = /^\s*(\d+[.)]|[-*+])\s.*:\s+$/;
const EMPTY_ROW = /^\s*\|(\s*\|)+\s*$/;
const HEADING = /^ {0,3}#{1,6}\s+(.*)$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

export function unfinishedLines(body: string): Unfinished[] {
  const lines = body.split(/\r?\n/);
  const out: Unfinished[] = [];
  let fence = false;
  lines.forEach((text, i) => {
    if (FENCE.test(text)) fence = !fence;
    if (fence) return;
    const line = i + 1;
    if (EMPTY_ITEM.test(text)) out.push({ line, why: "An empty item" });
    else if (OPEN_ITEM.test(text)) out.push({ line, why: "Unfinished" });
    else if (EMPTY_ROW.test(text)) out.push({ line, why: "An empty row" });
    else if (text.includes("…") || /\.\.\.\s*$/.test(text)) out.push({ line, why: "Still a placeholder" });
    else {
      const heading = HEADING.exec(text);
      if (!heading) return;
      // A section with nothing under it before the next heading (or the end).
      let j = i + 1;
      while (j < lines.length && (lines[j] ?? "").trim() === "") j++;
      if (j >= lines.length || HEADING.test(lines[j] ?? "")) out.push({ line, why: "An empty section" });
    }
  });
  return out;
}

/** Words an agent can act on: no headings, markup, or starter leftovers. */
export function realWords(body: string): number {
  const skip = new Set(unfinishedLines(body).map((u) => u.line));
  return body
    .split(/\r?\n/)
    .filter((t, i) => !skip.has(i + 1) && !HEADING.test(t) && !FENCE.test(t))
    .join(" ")
    .replace(/[`*_#>|[\]()-]/g, " ")
    .split(/\s+/)
    .filter((w) => /[a-z]{2,}/i.test(w)).length;
}

export type Refinement =
  | { kind: "opening"; text: string; action: string; sentence: string }
  | { kind: "unfinished"; text: string; action: string; line: number }
  | { kind: "purpose"; text: string; action: string }
  | { kind: "instructions"; text: string; action: string }
  | { kind: "inferred"; text: string; action: string; signal: Signal }
  | { kind: "signals"; text: string; action: string };

const WHEN = /\b(when|whenever|if|before|after|during|while|once)\b/i;

export function refinements(input: {
  title: string;
  description: string;
  body: string;
  /** Signals the sentences can edit, or null when the rules are YAML or invalid. */
  signals: number | null;
  tagsLabel: (tag: string) => string;
}): Refinement[] {
  const { description, body, signals } = input;
  const out: Refinement[] = [];
  const purpose = description.trim();
  const opening = purpose ? null : openingSentence(body);
  if (opening) {
    out.push({ kind: "opening", text: "No purpose yet.", action: "Use the opening line", sentence: opening });
  }

  const unfinished = unfinishedLines(body);
  if (unfinished.length > 0) {
    out.push({
      kind: "unfinished",
      text:
        unfinished.length === 1
          ? "One place still reads like the starter."
          : `${unfinished.length} places still read like the starter.`,
      action: "Show me",
      line: unfinished[0]?.line ?? 1,
    });
  }

  const words = purpose.split(/\s+/).filter(Boolean).length;
  if (purpose && words < 6) {
    out.push({
      kind: "purpose",
      text: `“${purpose.length > 24 ? `${purpose.slice(0, 24)}…` : purpose}” is all an agent reads before choosing this skill.`,
      action: "Say what it helps with",
    });
  } else if (purpose && !WHEN.test(purpose)) {
    out.push({
      kind: "purpose",
      text: "The purpose says what it does, not when to reach for it.",
      action: "Add when to use it",
    });
  }

  const real = realWords(body);
  if (body.trim() && real < 40) {
    out.push({
      kind: "instructions",
      text: "The instructions are brief. Steps, checks and what done looks like help agents most.",
      action: "Keep writing",
    });
  }

  if (signals === 0) {
    const tag = technologiesIn(body)[0];
    if (tag) {
      out.push({
        kind: "inferred",
        text: `Looks related to ${input.tagsLabel(tag)} projects.`,
        action: "Suggest it there",
        signal: { kind: "tag", value: tag },
      });
    } else if (body.trim()) {
      out.push({
        kind: "signals",
        text: "Not suggested in any project yet.",
        action: "Add a signal",
      });
    }
  }
  return out;
}
