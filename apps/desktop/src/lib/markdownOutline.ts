/**
 * The headings of a Markdown document, read from its source so an outline
 * can follow the text while it is being written (the reader's outline reads
 * rendered headings instead). Headings inside fenced code are not headings.
 */

export type OutlineHeading = {
  /** 1–6. */
  level: number;
  text: string;
  /** 1-based line of the heading in the source. */
  line: number;
};

const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;

/** Inline Markdown reduced to the words a reader sees. */
function plain(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_]+/g, "")
    .trim();
}

export function markdownOutline(source: string): OutlineHeading[] {
  const lines = source.split(/\r?\n/);
  const out: OutlineHeading[] = [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const opened = FENCE.exec(line);
    if (fence) {
      if (opened?.[1] && opened[1][0] === fence[0] && opened[1].length >= fence.length) fence = null;
      continue;
    }
    if (opened?.[1]) {
      fence = opened[1];
      continue;
    }
    const atx = ATX.exec(line);
    if (atx?.[1]) {
      const text = plain(atx[2] ?? "");
      if (text) out.push({ level: atx[1].length, text, line: i + 1 });
      continue;
    }
    // "Title\n=====" — only when the line above is ordinary text.
    const next = lines[i + 1];
    const underline = next === undefined ? null : SETEXT.exec(next);
    if (underline?.[1] && line.trim() !== "" && !/^ {0,3}([-*+]|\d+[.)]|>)\s/.test(line)) {
      // A bare "---" under text could be a thematic break in a list item; the
      // common case in skills is a heading.
      out.push({ level: underline[1].startsWith("=") ? 1 : 2, text: plain(line), line: i + 1 });
      i++;
    }
  }
  return out;
}

/** The heading whose section contains `line` (1-based), if any. */
export function sectionAt(outline: OutlineHeading[], line: number): OutlineHeading | null {
  let current: OutlineHeading | null = null;
  for (const h of outline) {
    if (h.line > line) break;
    current = h;
  }
  return current;
}
