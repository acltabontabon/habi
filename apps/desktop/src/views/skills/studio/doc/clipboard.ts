/** Copy gives Markdown, so a skill's text means the same pasted anywhere. Paste reads Markdown, and code. */
import { Fragment, type Node as PMNode, type ResolvedPos, Slice } from "prosemirror-model";
import { sliceFromMarkdown } from "./commands";
import { canonOf } from "./markdown/canon";
import { schema } from "./markdown/schema";

const { nodes } = schema;

const CODE_LINE =
  /[;{}]\s*$|^\s*(?:def|class|function|const|let|var|import|from|return|if|for|while|#include|public|private)\b|=>|^\s{2,}\S|^\$ /;

/** Whether pasted text is code rather than prose: several lines, most shaped like code, no Markdown structure. */
export function looksLikeCode(text: string): boolean {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 3) return false;
  if (/^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|```|~~~|\|)/m.test(text)) return false;
  return lines.filter((l) => CODE_LINE.test(l)).length / lines.length >= 0.6;
}

function hasSharedIndent(text: string): string {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  const indents = lines.map((l) => /^[ \t]*/.exec(l)?.[0].length ?? 0);
  const least = Math.min(...indents);
  return least > 0
    ? text
        .split("\n")
        .map((l) => l.slice(least))
        .join("\n")
    : text;
}

export function clipboardTextParser(text: string, $context: ResolvedPos, plain: boolean): Slice {
  if ($context.parent.type.spec.code || plain) {
    const clean = text.replace(/\r\n/g, "\n");
    if ($context.parent.type.spec.code) return new Slice(Fragment.from(schema.text(clean || " ")), 0, 0);
    const lines = clean.split("\n").map((l) => nodes.paragraph.create(null, l ? schema.text(l) : null));
    return lines.length === 1
      ? new Slice(Fragment.from(lines[0]), 1, 1)
      : new Slice(Fragment.from(lines), 0, 0);
  }
  if (looksLikeCode(text)) {
    const code = hasSharedIndent(text.replace(/\r\n/g, "\n")).replace(/\n+$/, "");
    return new Slice(Fragment.from(nodes.code_block.create(null, code ? schema.text(code) : null)), 0, 0);
  }
  return sliceFromMarkdown(text);
}

function canonAny(node: PMNode): string {
  if (node.isBlock) return canonOf(node);
  return canonOf(nodes.paragraph.create(null, node));
}

export function clipboardTextSerializer(slice: Slice): string {
  const content = slice.content;
  const allInline = content.firstChild?.isInline === true;
  if (allInline) return canonOf(nodes.paragraph.create(null, content));
  const parts: string[] = [];
  content.forEach((child) => {
    parts.push(canonAny(child));
  });
  return parts.join("\n\n");
}

/** Characters that change meaning without showing: kept as they are, but never hidden from the author. */
export const INVISIBLE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿­]/g;
