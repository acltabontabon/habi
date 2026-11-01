/**
 * What a piece of Markdown means, with how it happens to be written taken out.
 * Two texts with the same meaning read the same to an agent, whatever their
 * wrapping, bullet characters or emphasis markers. This is the check behind
 * every promise the editor makes about a file.
 */
import type { Node as PMNode } from "prosemirror-model";
import { canonOf } from "./canon";
import { parseMdast } from "./mdast";

type Any = { type: string; [key: string]: unknown };
type Run = { t?: string; m?: string; x?: unknown };

function flatten(children: Any[], marks: string[], out: Run[]): void {
  for (const child of children) {
    const kids = (child.children ?? []) as Any[];
    switch (child.type) {
      case "text":
        out.push({ t: child.value as string, m: marks.join() });
        break;
      case "inlineCode":
        out.push({ t: child.value as string, m: [...marks, "code"].sort().join() });
        break;
      case "emphasis":
        flatten(kids, [...marks, "em"].sort(), out);
        break;
      case "strong":
        flatten(kids, [...marks, "strong"].sort(), out);
        break;
      case "delete":
        flatten(kids, [...marks, "del"].sort(), out);
        break;
      case "link":
        flatten(kids, [...marks, `link:${child.url as string}|${(child.title as string) ?? ""}`].sort(), out);
        break;
      case "linkReference":
        out.push({ x: ["ref", child.identifier, child.referenceType] });
        flatten(kids, [...marks, "ref"].sort(), out);
        break;
      case "image":
        out.push({ x: ["img", child.url, child.alt ?? "", child.title ?? ""], m: marks.join() });
        break;
      case "imageReference":
        out.push({ x: ["imgref", child.identifier, child.alt ?? ""], m: marks.join() });
        break;
      case "break":
        out.push({ x: "br", m: marks.join() });
        break;
      case "html":
        out.push({ x: ["html", child.value], m: marks.join() });
        break;
      case "footnoteReference":
        out.push({ x: ["fn", child.identifier], m: marks.join() });
        break;
      default:
        out.push({ x: child.type });
    }
  }
}

/** Inline content as runs of text and marks: nesting order and wrapping don't change meaning. */
function inline(children: Any[]): Run[] {
  const raw: Run[] = [];
  flatten(children, [], raw);
  const merged: Run[] = [];
  for (const run of raw) {
    const last = merged[merged.length - 1];
    if (run.t !== undefined && last?.t !== undefined && last.m === run.m) last.t += run.t;
    else merged.push({ ...run });
  }
  for (const run of merged) {
    if (run.t !== undefined) run.t = run.t.replace(/[ \t]*\r?\n[ \t]*/g, " ");
  }
  const first = merged[0];
  if (first?.t !== undefined) first.t = first.t.replace(/^[ \t]+/, "");
  const last = merged[merged.length - 1];
  if (last?.t !== undefined) last.t = last.t.replace(/[ \t]+$/, "");
  return merged.filter((r) => r.t !== "");
}

function normal(node: Any): unknown {
  const kids = (node.children ?? []) as Any[];
  switch (node.type) {
    case "paragraph":
      return ["p", inline(kids)];
    case "heading":
      return ["h", node.depth, inline(kids)];
    case "blockquote":
      return ["q", kids.map(normal)];
    case "list":
      return ["l", node.ordered ? (node.start ?? 1) : 0, kids.map(normal)];
    case "listItem":
      return ["i", node.checked ?? null, kids.map(normal)];
    case "code":
      return ["c", node.lang ?? "", node.meta ?? "", ((node.value as string) ?? "").replace(/\r\n/g, "\n")];
    case "thematicBreak":
      return ["hr"];
    case "html":
      return ["html", ((node.value as string) ?? "").replace(/\r\n/g, "\n")];
    case "table":
      return ["t", node.align, kids.map(normal)];
    case "tableRow":
      return kids.map(normal);
    case "tableCell":
      return inline(kids);
    case "definition":
      return ["def", node.identifier, node.url, node.title ?? ""];
    case "footnoteDefinition":
      return ["fnd", node.identifier, kids.map(normal)];
    default:
      return [node.type, node.value ?? null, kids.map(normal)];
  }
}

/** One meaning per top-level block of `markdown`. */
export function meaningsOf(markdown: string): string[] {
  const root = parseMdast(markdown) as unknown as Any;
  return ((root.children ?? []) as Any[]).map((c) => JSON.stringify(normal(c)));
}

export function sameMeaning(a: string, b: string): boolean {
  if (a === b) return true;
  return meaningsOf(a).join("\n") === meaningsOf(b).join("\n");
}

/** The words of a meaning, for telling a changed mark from changed content. */
function wordsOf(meanings: string[]): string {
  const words: string[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      const t = (v as Run).t;
      if (t !== undefined) words.push(t);
      else if ((v as Run).x) walk((v as Run).x);
    } else if (typeof v === "string") words.push(v);
  };
  for (const m of meanings) walk(JSON.parse(m));
  return words.join("").replace(/\s+/g, "");
}

export type Verdict =
  /** The file says what the editor shows. */
  | "same"
  /** Every word is there, but a mark reads differently: the editor should adopt the file's reading. */
  | "words"
  /** Reading the file back gives something else. It must not be saved. */
  | "differs";

/** What a document says, as one text. Read whole, not block by block: a `[link][ref]` needs its definition. */
export function canonText(doc: PMNode): string {
  const canons: string[] = [];
  doc.forEach((child) => {
    const canon = canonOf(child);
    if (canon) canons.push(canon);
  });
  return canons.join("\n\n");
}

export function verifyText(output: string, canon: string): Verdict {
  const want = meaningsOf(canon);
  const got = meaningsOf(output);
  if (got.length === want.length && got.every((m, i) => m === want[i])) return "same";
  return wordsOf(got) === wordsOf(want) ? "words" : "differs";
}

/** Whether `output` reads back as the document on screen. Run at save time, never per keystroke. */
export function verifyOutput(output: string, doc: PMNode): Verdict {
  return verifyText(output, canonText(doc));
}
