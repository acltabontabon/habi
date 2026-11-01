/** Actionable unfinished content. Optional configuration is never an improvement. */
import { openingSentence } from "./materials";

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
  | { kind: "unfinished"; text: string; action: string; line: number };

const WHEN = /\b(when|whenever|if|before|after|during|while|once)\b/i;

/** Past this a purpose is long enough that the key use should come first: tools cut and drop long ones. */
const LONG_PURPOSE = 500;

/** The one thing to say under the purpose while it is typed. */
export function purposeHint(description: string): string {
  const purpose = description.trim();
  if (purpose.length > LONG_PURPOSE) return "Long purposes can be cut in an agent's list. Key use first.";
  if (purpose.split(/\s+/).length >= 6 && !WHEN.test(purpose))
    return "No trigger yet: say when to reach for it, as in “Use when…”.";
  return "Agents read only this to decide whether to use it.";
}

export function refinements(input: { description: string; body: string }): Refinement[] {
  const { description, body } = input;
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

  return out;
}
