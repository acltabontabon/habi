/**
 * The one thing a page suggests next. Read only from the shape of the document,
 * so it can say what's there and what isn't, and never pretends to understand it.
 * Suggestions are never stored: typing anything else makes them go away.
 */
import type { Node as PMNode } from "prosemirror-model";

const RESULT = /\b(result|output|outcome|example|sample|format|done|good|deliver)/i;
const APPROACH = /\b(step|approach|process|how|procedure|workflow|method)/i;

export const PROMPTS = {
  /** No purpose yet, no words yet. */
  start: "What should the agent do? Start anywhere.",
  approach: "How should the agent approach this?",
  result: "What does a good result look like?",
} as const;

export function nextPrompt(doc: PMNode, purpose: string): string | null {
  let words = 0;
  let hasList = false;
  let approach = false;
  let result = false;
  let hasCode = false;
  doc.descendants((node) => {
    if (node.isText) words += (node.text ?? "").trim().split(/\s+/).filter(Boolean).length;
    if (node.type.name === "ordered_list") hasList = true;
    if (node.type.name === "code_block") hasCode = true;
    if (node.type.name === "heading") {
      if (APPROACH.test(node.textContent)) approach = true;
      if (RESULT.test(node.textContent)) result = true;
    }
    return true;
  });
  if (words === 0) return purpose.trim() ? PROMPTS.approach : PROMPTS.start;
  if (!hasList && !approach && words < 40) return PROMPTS.approach;
  if (!result && !hasCode && words >= 12) return PROMPTS.result;
  return null;
}
