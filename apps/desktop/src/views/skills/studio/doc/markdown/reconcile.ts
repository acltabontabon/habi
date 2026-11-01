/**
 * Document back to Markdown, spending the author's own bytes wherever it can.
 *
 * Blocks are matched to their past by what they mean, not by identity: a block
 * that didn't change, that moved, or that came back through undo writes out its
 * original text. Only what really changed is written new, so a Git diff shows
 * what the author did and nothing else.
 */
import type { Node as PMNode } from "prosemirror-model";
import { canonOf, listMarker } from "./canon";
import type { BaseBlock, Baseline } from "./parse";
import { sameMeaning } from "./verify";

export type Span = {
  /** Position of the block in the document. */
  pos: number;
  /** 1-based line of the block in the text. */
  line: number;
  /** How many lines it takes up. */
  lines: number;
};

export type Written = { text: string; spans: Span[] };

const LCS_LIMIT = 400_000;

/** For each node, the index of the base block that holds the same content, or -1. */
function align(canons: string[], bases: BaseBlock[]): Int32Array {
  const match = new Int32Array(canons.length).fill(-1);
  const used = new Uint8Array(bases.length);
  let head = 0;
  while (head < canons.length && head < bases.length && canons[head] === bases[head]?.canon) {
    match[head] = head;
    used[head] = 1;
    head++;
  }
  let a = canons.length - 1;
  let b = bases.length - 1;
  while (a >= head && b >= head && canons[a] === bases[b]?.canon) {
    match[a] = b;
    used[b] = 1;
    a--;
    b--;
  }
  const n = a - head + 1;
  const m = b - head + 1;
  if (n > 0 && m > 0 && n * m <= LCS_LIMIT) {
    // What's in the same order stays attached to its neighbours.
    const w = m + 1;
    const dp = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * w + j] =
          canons[head + i] === bases[head + j]?.canon
            ? (dp[(i + 1) * w + j + 1] ?? 0) + 1
            : Math.max(dp[(i + 1) * w + j] ?? 0, dp[i * w + j + 1] ?? 0);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (canons[head + i] === bases[head + j]?.canon) {
        match[head + i] = head + j;
        used[head + j] = 1;
        i++;
        j++;
      } else if ((dp[(i + 1) * w + j] ?? 0) >= (dp[i * w + j + 1] ?? 0)) i++;
      else j++;
    }
  }
  // What's left may have moved.
  const left = new Map<string, number[]>();
  bases.forEach((base, i) => {
    if (used[i]) return;
    const at = left.get(base.canon);
    if (at) at.push(i);
    else left.set(base.canon, [i]);
  });
  for (let i = 0; i < canons.length; i++) {
    if (match[i] !== -1) continue;
    const at = left.get(canons[i] ?? "");
    const hit = at?.shift();
    if (hit !== undefined) {
      match[i] = hit;
      used[hit] = 1;
    }
  }
  return match;
}

/** Edited blocks with the base they replaced: between matched neighbours, in order, same kind. */
function pair(nodes: PMNode[], bases: BaseBlock[], match: Int32Array): Int32Array {
  const paired = new Int32Array(nodes.length).fill(-1);
  const taken = new Uint8Array(bases.length);
  for (const m of match) if (m >= 0) taken[m] = 1;
  let i = 0;
  while (i < nodes.length) {
    if (match[i] !== -1) {
      i++;
      continue;
    }
    let end = i;
    while (end < nodes.length && match[end] === -1) end++;
    const before = i > 0 ? (match[i - 1] ?? -1) : -1;
    const after = end < nodes.length ? (match[end] ?? bases.length) : bases.length;
    let cursor = before + 1;
    for (let k = i; k < end; k++) {
      while (cursor < after && (taken[cursor] || bases[cursor]?.type !== nodes[k]?.type.name)) cursor++;
      if (cursor < after) {
        paired[k] = cursor;
        taken[cursor] = 1;
        cursor++;
      }
    }
    i = end;
  }
  return paired;
}

function indentRest(text: string, by: string): string {
  if (!by) return text;
  return text.replace(/\r?\n(?=[^\r\n])/g, (nl) => nl + by);
}

/**
 * The first line's marker reused, its number updated when the list counts. If the
 * new marker is wider than the old, the content below it would have to move, so
 * the caller writes the item fresh instead.
 */
function renumber(prefix: string, list: PMNode, index: number, sequential: boolean): string | null {
  if (list.type.name !== "ordered_list" || !sequential) return prefix;
  const number = (list.attrs.start as number) + index;
  const m = /^(\d+)([.)])(\s*)$/.exec(prefix);
  if (!m) return prefix;
  const next = `${number}${m[2] ?? "."}`;
  const padding = prefix.length - next.length;
  if (padding < 1) return null;
  return next + " ".repeat(padding);
}

/**
 * Keeps an edited paragraph's wrapping: the old canon and old source agree except
 * in whitespace, so offsets carry across and only the changed span is replaced.
 */
function splice(oldCanon: string, raw: string, canon: string): string | null {
  const map = new Int32Array(oldCanon.length + 1);
  let r = 0;
  for (let c = 0; c < oldCanon.length; c++) {
    const want = oldCanon.charAt(c);
    const have = raw.charAt(r);
    map[c] = r;
    if (want === have) {
      r++;
      continue;
    }
    if (want === " " && /[ \t\r\n]/.test(have)) {
      while (/[ \t\r\n]/.test(raw.charAt(r))) r++;
      continue;
    }
    return null;
  }
  if (r !== raw.length) return null;
  map[oldCanon.length] = r;
  let p = 0;
  const limit = Math.min(oldCanon.length, canon.length);
  while (p < limit && oldCanon.charAt(p) === canon.charAt(p)) p++;
  let s = 0;
  while (s < limit - p && oldCanon.charAt(oldCanon.length - 1 - s) === canon.charAt(canon.length - 1 - s))
    s++;
  return raw.slice(0, map[p]) + canon.slice(p, canon.length - s) + raw.slice(map[oldCanon.length - s]);
}

const edits = new WeakMap<PMNode, { base: BaseBlock; text: string }>();

type Out = { text: string; spans: Span[] };

function lineCount(text: string): number {
  let n = 1;
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) n++;
  return n;
}

function fresh(text: string, eol: string): string {
  return eol === "\n" ? text : text.replace(/\n/g, eol);
}

function writeEdited(node: PMNode, base: BaseBlock, eol: string, pos: number): Out {
  const name = node.type.name;
  if (name === "paragraph" || name === "heading") {
    const hit = edits.get(node);
    if (hit?.base === base) return { text: hit.text, spans: [] };
    const canon = canonOf(node);
    let text: string | null =
      base.raw !== null && !base.raw.includes("\\\n") ? splice(base.canon, base.raw, canon) : null;
    if (text !== null && !sameMeaning(text.replace(/\r\n/g, "\n"), canon)) text = null;
    const result = text ?? fresh(canon, eol);
    edits.set(node, { base, text: result });
    return { text: result, spans: [] };
  }
  if ((name === "bullet_list" || name === "ordered_list") && base.kids) {
    const list = node;
    const items: PMNode[] = [];
    list.forEach((item) => {
      items.push(item);
    });
    return writeList(list, items, base, eol, pos);
  }
  if (name === "list_item" && base.kids && base.prefix) {
    const kids: PMNode[] = [];
    node.forEach((c) => {
      kids.push(c);
    });
    const inner = writeSiblings(kids, base.kids, eol, pos + 1, "\n\n");
    const pad = " ".repeat(base.prefix.length);
    return {
      text: base.prefix + indentRest(inner.text, pad),
      spans: inner.spans,
    };
  }
  if (name === "table" && base.kids && base.delimiter) {
    const rows: PMNode[] = [];
    node.forEach((row) => {
      rows.push(row);
    });
    const canon = canonOf(node);
    const delimiter = canon.split("\n")[1] ?? "";
    const firstRow = rows[0];
    if (!firstRow) return { text: fresh(canon, eol), spans: [] };
    const rest = writeSiblings(rows.slice(1), base.kids.slice(1), eol, pos + 1 + firstRow.nodeSize, "\n");
    const head =
      canonOf(firstRow) === base.kids[0]?.canon
        ? (base.kids[0]?.raw ?? fresh(canonOf(firstRow), eol))
        : fresh(canonOf(firstRow), eol);
    const line = delimiter === base.delimiter.canon ? base.delimiter.raw : delimiter;
    const parts = [head, line];
    if (rest.text) parts.push(rest.text);
    return { text: parts.join(eol), spans: [] };
  }
  return { text: fresh(canonOf(node), eol), spans: [] };
}

function writeList(list: PMNode, items: PMNode[], base: BaseBlock, eol: string, pos: number): Out {
  const kids = base.kids ?? [];
  const canons = items.map(canonOf);
  const match = align(canons, kids);
  const paired = pair(items, kids, match);
  const fallback = list.attrs.spread ? `${eol}${eol}` : eol;
  let text = "";
  const spans: Span[] = [];
  let at = pos + 1;
  let line = 1;
  items.forEach((item, i) => {
    const m = match[i] ?? -1;
    const p = paired[i] ?? -1;
    const own = m >= 0 ? kids[m] : p >= 0 ? kids[p] : undefined;
    let piece: string;
    let inner: Span[] = [];
    if (m >= 0 && own?.raw != null) {
      piece = own.raw;
      if (own.prefix) {
        const next = renumber(own.prefix, list, i, base.sequential === true);
        if (next === null) piece = writeItemFresh(item, list, i, eol);
        else if (next !== own.prefix) piece = next + own.raw.slice(own.prefix.length);
      } else if (list.type.name === "ordered_list" && base.sequential) {
        piece = renumberRaw(own.raw, list, i) ?? writeItemFresh(item, list, i, eol);
      }
    } else if (p >= 0 && own) {
      const written = writeEdited(item, own, eol, at);
      piece = written.text;
      inner = written.spans;
      if (own.prefix) {
        const next = renumber(own.prefix, list, i, base.sequential === true);
        if (next === null) piece = writeItemFresh(item, list, i, eol);
        else if (next !== own.prefix) piece = next + piece.slice(own.prefix.length);
      } else if (piece === fresh(canonOf(item), eol)) {
        piece = writeItemFresh(item, list, i, eol);
      }
    } else {
      piece = writeItemFresh(item, list, i, eol);
    }
    spans.push({ pos: at, line, lines: lineCount(piece) });
    for (const s of inner) spans.push({ ...s, line: s.line + line - 1 });
    text += piece;
    line += lineCount(piece) - 1;
    if (i < items.length - 1) {
      const nextBase = (match[i + 1] ?? -1) >= 0 ? (match[i + 1] ?? -1) : (paired[i + 1] ?? -1);
      const ownAt = m >= 0 ? m : p;
      const gap = ownAt >= 0 && nextBase === ownAt + 1 ? (kids[ownAt]?.gapAfter ?? fallback) : fallback;
      text += gap;
      line += lineCount(gap) - 1;
    }
    at += item.nodeSize;
  });
  return { text, spans };
}

function renumberRaw(raw: string, list: PMNode, index: number): string | null {
  const m = /^(\d+)([.)])/.exec(raw);
  if (!m) return raw;
  const next = `${(list.attrs.start as number) + index}${m[2] ?? "."}`;
  if (next.length !== m[0].length) return null;
  return next + raw.slice(m[0].length);
}

function writeItemFresh(item: PMNode, list: PMNode, index: number, eol: string): string {
  const marker = listMarker(list, index);
  const canon = canonOf(item);
  // An item's canon is written with a two-column `- ` marker: re-seat it under its real one.
  const body = canon.slice(2);
  const pad = " ".repeat(marker.length);
  const lines = body.split("\n").map((l, i) => {
    if (i === 0 || l === "") return l;
    return pad + l.replace(/^ {2}/, "");
  });
  return fresh(marker + lines.join("\n"), eol);
}

function writeSiblings(
  nodes: PMNode[],
  bases: BaseBlock[],
  eol: string,
  startPos: number,
  fallbackGap: string,
): Out {
  const canons = nodes.map(canonOf);
  const match = align(canons, bases);
  const paired = pair(nodes, bases, match);
  const fallback = fresh(fallbackGap, eol);
  const spans: Span[] = [];
  let text = "";
  let line = 1;
  let pos = startPos;
  let lastBase = -2;
  let any = false;
  nodes.forEach((node, i) => {
    const size = node.nodeSize;
    const canon = canons[i] ?? "";
    const m = match[i] ?? -1;
    const p = paired[i] ?? -1;
    if (canon === "" && node.type.name === "paragraph") {
      // An empty paragraph is the caret's place to be, not content.
      pos += size;
      return;
    }
    const own = m >= 0 ? m : p;
    if (any) {
      const gap =
        own >= 0 && lastBase >= 0 && own === lastBase + 1
          ? (bases[lastBase]?.gapAfter ?? fallback)
          : fallback;
      text += gap;
      line += lineCount(gap) - 1;
    }
    let piece: string;
    let inner: Span[] = [];
    const base = m >= 0 ? bases[m] : undefined;
    if (base && base.raw !== null) piece = base.raw;
    else if (p >= 0 && bases[p]) {
      const written = writeEdited(node, bases[p] as BaseBlock, eol, pos);
      piece = written.text;
      inner = written.spans;
    } else piece = fresh(canon, eol);
    const lines = lineCount(piece);
    spans.push({ pos, line, lines });
    for (const s of inner) spans.push({ ...s, line: s.line + line - 1 });
    text += piece;
    line += lines - 1;
    lastBase = own;
    any = true;
    pos += size;
  });
  return { text, spans };
}

/** The text for a document, given what it was loaded from. */
export function write(doc: PMNode, baseline: Baseline): Written {
  const nodes: PMNode[] = [];
  doc.forEach((child) => {
    nodes.push(child);
  });
  const body = writeSiblings(nodes, baseline.blocks, baseline.eol, 0, "\n\n");
  const leadLines = lineCount(baseline.lead) - 1;
  const spans = leadLines ? body.spans.map((s) => ({ ...s, line: s.line + leadLines })) : body.spans;
  return { text: baseline.lead + body.text + baseline.trail, spans };
}
