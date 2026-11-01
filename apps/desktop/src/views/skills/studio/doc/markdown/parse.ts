/**
 * Markdown to document, remembering where everything came from. The baseline
 * keeps each block's source, so `reconcile` can give back the author's own bytes
 * for whatever they didn't touch.
 *
 * A block only becomes rich if writing it back would mean the same thing. If not,
 * that block alone stays raw on the page: one odd construct never costs the
 * author the rest of their document.
 */
import type { Nodes, Parent, PhrasingContent, RootContent, TableCell } from "mdast";
import type { Mark, Node as PMNode } from "prosemirror-model";
import { canonOf } from "./canon";
import { parseMdast } from "./mdast";
import { schema } from "./schema";
import { sameMeaning } from "./verify";

export type BaseBlock = {
  /** Which kind of node this was, so an edited block pairs with its own past. */
  type: string;
  /** Source relative to the block's own column; null if lines can't be cleanly lifted out. */
  raw: string | null;
  canon: string;
  /** Whitespace up to the next sibling, as written. */
  gapAfter: string;
  /** A list's items, an item's blocks, or a table's rows. */
  kids?: BaseBlock[];
  /** An item's marker and padding exactly as written (`1.  `). */
  prefix?: string;
  /** A table's delimiter line, as written, and its canonical form. */
  delimiter?: { raw: string; canon: string };
  /** Whether an ordered list counted 1, 2, 3 rather than repeating a number. */
  sequential?: boolean;
};

export type Baseline = {
  source: string;
  eol: "\n" | "\r\n";
  lead: string;
  trail: string;
  blocks: BaseBlock[];
};

export type Parsed = {
  doc: PMNode;
  baseline: Baseline;
  /** How many top-level blocks are rich, and how many stayed raw. */
  stats: { rich: number; raw: number };
};

/** A valid skill name: lowercase words joined by single hyphens. */
export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NAMESPACED = /^([a-z][a-z0-9-]*):([a-z0-9]+(?:-[a-z0-9]+)*)$/;
const ENTITY = /(?<!\\)&(#\d+|#[xX][\da-fA-F]+|[A-Za-z][A-Za-z\d]*);/g;
const CALLOUT = /^\[!([A-Za-z]+)\][ \t]*(?:\r?\n[ \t]*)?/;

const nodes = schema.nodes;
const marks = schema.marks;

type Ctx = { source: string; strict: boolean };

function rawOf(node: Nodes, ctx: Ctx): string {
  const start = node.position?.start.offset ?? 0;
  const end = node.position?.end.offset ?? start;
  return ctx.source.slice(start, end);
}

/** Lines after the first with `column - 1` spaces removed; null if one lacks them. */
function lift(text: string, column: number): string | null {
  if (column <= 1) return text;
  const lines = text.split("\n");
  const pad = " ".repeat(column - 1);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      lines[i] = line.startsWith(pad) ? line.slice(pad.length) : line.replace(/^ +/, "");
      continue;
    }
    if (!line.startsWith(pad)) return null;
    lines[i] = line.slice(pad.length);
  }
  return lines.join("\n");
}

function decodeEntity(entity: string): string {
  const first = parseMdast(entity).children[0];
  const inner = first && "children" in first ? first.children[0] : undefined;
  return inner?.type === "text" ? inner.value : entity;
}

function textRuns(value: string, raw: string, active: readonly Mark[]): PMNode[] {
  const flat = value.replace(/[ \t]*\r?\n[ \t]*/g, " ");
  const plain = () => (flat ? [schema.text(flat, active)] : []);
  if (!raw.includes("&") || !ENTITY.test(raw)) return plain();
  ENTITY.lastIndex = 0;
  // The author wrote an entity: keep it as they wrote it, showing what it means.
  const out: PMNode[] = [];
  let at = 0;
  let joined = "";
  const unescape = (s: string) => s.replace(/\\([!-/:-@[-`{-~])/g, "$1").replace(/[ \t]*\r?\n[ \t]*/g, " ");
  for (const m of raw.matchAll(ENTITY)) {
    const before = unescape(raw.slice(at, m.index));
    if (before) {
      out.push(schema.text(before, active));
      joined += before;
    }
    const entity = m[0];
    const shown = decodeEntity(entity);
    joined += shown;
    if (shown === entity) out.push(schema.text(entity, active));
    else out.push(nodes.inline_raw.create({ raw: entity, display: shown, kind: "entity" }, null, active));
    at = m.index + entity.length;
  }
  const after = unescape(raw.slice(at));
  if (after) {
    out.push(schema.text(after, active));
    joined += after;
  }
  return joined === flat ? out : plain();
}

function plainText(node: Nodes): string {
  if ("value" in node) return node.value;
  if ("children" in node) return (node.children as Nodes[]).map(plainText).join("");
  return "";
}

function inlineOf(children: readonly PhrasingContent[], active: readonly Mark[], ctx: Ctx): PMNode[] {
  const out: PMNode[] = [];
  const list = [...children];
  for (let i = 0; i < list.length; i++) {
    const child = list[i];
    if (!child) continue;
    switch (child.type) {
      case "text": {
        out.push(...textRuns(child.value, rawOf(child, ctx), active));
        break;
      }
      case "emphasis": {
        const marker = ctx.source.charAt(child.position?.start.offset ?? 0) === "_" ? "_" : "*";
        out.push(...inlineOf(child.children, marks.em.create({ marker }).addToSet(active), ctx));
        break;
      }
      case "strong": {
        const marker = ctx.source.charAt(child.position?.start.offset ?? 0) === "_" ? "__" : "**";
        out.push(...inlineOf(child.children, marks.strong.create({ marker }).addToSet(active), ctx));
        break;
      }
      case "delete": {
        const marker = ctx.source.slice(child.position?.start.offset ?? 0).startsWith("~~") ? "~~" : "~";
        out.push(...inlineOf(child.children, marks.strike.create({ marker }).addToSet(active), ctx));
        break;
      }
      case "link": {
        const mark = marks.link.create({ href: child.url, title: child.title ?? null });
        out.push(...inlineOf(child.children, mark.addToSet(active), ctx));
        break;
      }
      case "inlineCode": {
        const next = list[i + 1];
        // A skill is named as `` `name` skill ``. Anything else in backticks stays code.
        if (
          SKILL_NAME.test(child.value) &&
          next?.type === "text" &&
          /^ skill(?![\p{L}\p{N}_-])/u.test(next.value)
        ) {
          out.push(nodes.skill_ref.create({ name: child.value }, null, active));
          const rest = next.value.slice(" skill".length);
          const start = next.position?.start.offset ?? 0;
          const end = next.position?.end.offset ?? start;
          list[i + 1] = {
            type: "text",
            value: rest,
            position: next.position && {
              start: { ...next.position.start, offset: Math.min(start + " skill".length, end) },
              end: next.position.end,
            },
          };
          break;
        }
        const ns = NAMESPACED.exec(child.value);
        if (ns) {
          out.push(nodes.skill_ref.create({ name: ns[2], plugin: ns[1] }, null, active));
          break;
        }
        if (child.value) out.push(schema.text(child.value, marks.code.create().addToSet(active)));
        else out.push(nodes.inline_raw.create({ raw: rawOf(child, ctx), kind: "code" }, null, active));
        break;
      }
      case "break": {
        const style = rawOf(child, ctx).startsWith("\\") ? "backslash" : "spaces";
        out.push(nodes.hard_break.create({ style }, null, active));
        break;
      }
      case "image":
        out.push(
          nodes.image.create(
            { src: child.url, alt: child.alt ?? "", title: child.title ?? null },
            null,
            active,
          ),
        );
        break;
      case "linkReference":
        out.push(
          nodes.inline_raw.create(
            { raw: rawOf(child, ctx), display: plainText(child), kind: "reference" },
            null,
            active,
          ),
        );
        break;
      case "imageReference":
      case "footnoteReference":
        out.push(nodes.inline_raw.create({ raw: rawOf(child, ctx), kind: "reference" }, null, active));
        break;
      default:
        out.push(nodes.inline_raw.create({ raw: rawOf(child, ctx), kind: "html" }, null, active));
    }
  }
  return out;
}

function opaque(node: Nodes, ctx: Ctx, kind?: string): PMNode {
  return nodes.opaque_block.create({
    raw: rawOf(node, ctx),
    kind:
      kind ??
      (node.type === "html"
        ? "html"
        : node.type === "definition"
          ? "definition"
          : node.type === "footnoteDefinition"
            ? "footnote"
            : "other"),
  });
}

function tableOf(node: Extract<Nodes, { type: "table" }>, ctx: Ctx): PMNode {
  const align = node.align ?? [];
  const rows = node.children.map((row, r) => {
    const cells = row.children.map((cell: TableCell, c) =>
      (r === 0 ? nodes.table_header : nodes.table_cell).create(
        { align: align[c] ?? null },
        inlineOf(cell.children, [], ctx),
      ),
    );
    return nodes.table_row.create(null, cells);
  });
  return nodes.table.create(null, rows);
}

function blockOf(node: RootContent, ctx: Ctx): PMNode {
  switch (node.type) {
    case "paragraph":
      return nodes.paragraph.create(null, inlineOf(node.children, [], ctx));
    case "heading": {
      const raw = rawOf(node, ctx);
      return nodes.heading.create(
        { level: node.depth, setext: !raw.startsWith("#") },
        inlineOf(node.children, [], ctx),
      );
    }
    case "blockquote": {
      const first = node.children[0];
      const lead = first?.type === "paragraph" ? first.children[0] : undefined;
      const hit = lead?.type === "text" ? CALLOUT.exec(lead.value) : null;
      if (!hit || !lead || lead.type !== "text" || first?.type !== "paragraph") {
        return nodes.blockquote.create(null, childBlocks(node, ctx));
      }
      // `> [!NOTE]` is a callout on GitHub and stays a plain quote everywhere else.
      const rest = lead.value.slice(hit[0].length);
      const start = lead.position?.start.offset ?? 0;
      const kids: PhrasingContent[] = [
        ...(rest
          ? [
              {
                type: "text",
                value: rest,
                position: lead.position && {
                  start: { ...lead.position.start, offset: start + hit[0].length },
                  end: lead.position.end,
                },
              } as PhrasingContent,
            ]
          : []),
        ...first.children.slice(1),
      ];
      const content = [
        ...(kids.length ? [nodes.paragraph.create(null, inlineOf(kids, [], ctx))] : []),
        ...node.children.slice(1).map((c) => guarded(c, ctx)),
      ];
      return nodes.blockquote.create(
        { callout: (hit[1] ?? "NOTE").toUpperCase() },
        content.length ? content : [nodes.paragraph.create()],
      );
    }
    case "list": {
      const items = node.children.map((item) => {
        const content = item.children.length ? childBlocks(item, ctx) : [nodes.paragraph.create()];
        return nodes.list_item.create({ checked: item.checked ?? null }, content);
      });
      const first = rawOf(node, ctx);
      if (node.ordered) {
        const delim = /^\s*\d+\)/.test(first) ? ")" : ".";
        return nodes.ordered_list.create(
          { start: node.start ?? 1, delim, spread: node.spread ?? false },
          items,
        );
      }
      const marker = first.charAt(0);
      return nodes.bullet_list.create(
        { marker: marker === "*" || marker === "+" ? marker : "-", spread: node.spread ?? false },
        items,
      );
    }
    case "code": {
      const raw = rawOf(node, ctx);
      const fence = /^(`{3,}|~{3,})([^\r\n]*)/.exec(raw);
      const value = node.value.replace(/\r\n/g, "\n");
      const content = value ? schema.text(value) : null;
      return nodes.code_block.create(
        {
          info: fence?.[2]?.trimEnd() ?? (node.lang ? ` ${node.lang}`.trimStart() : ""),
          fence: fence?.[1] ?? "```",
        },
        content,
      );
    }
    case "thematicBreak":
      return nodes.horizontal_rule.create({ style: rawOf(node, ctx).trim() });
    case "table":
      return tableOf(node, ctx);
    default:
      return opaque(node, ctx);
  }
}

/** In strict mode, every nested block has to survive on its own or it stays raw. */
function guarded(node: RootContent, ctx: Ctx): PMNode {
  const made = blockOf(node, ctx);
  if (!ctx.strict) return made;
  const raw = lift(rawOf(node, ctx), node.position?.start.column ?? 1);
  if (raw === null) return opaque(node, ctx, "other");
  return sameMeaning(raw.replace(/\r\n/g, "\n"), canonOf(made)) ? made : opaque(node, ctx);
}

function childBlocks(parent: Parent, ctx: Ctx): PMNode[] {
  return (parent.children as RootContent[]).map((c) => guarded(c, ctx));
}

function gapBetween(a: Nodes, b: Nodes | undefined, column: number, ctx: Ctx): string {
  if (!b) return "";
  const gap = ctx.source.slice(a.position?.end.offset ?? 0, b.position?.start.offset ?? 0);
  return lift(gap, column) ?? gap;
}

function baseOf(mdast: RootContent, node: PMNode, ctx: Ctx, next: RootContent | undefined): BaseBlock {
  const column = mdast.position?.start.column ?? 1;
  const base: BaseBlock = {
    type: node.type.name,
    raw: lift(rawOf(mdast, ctx), column),
    canon: canonOf(node),
    gapAfter: gapBetween(mdast, next, column, ctx),
  };
  if (mdast.type === "list" && (node.type.name === "ordered_list" || node.type.name === "bullet_list")) {
    base.sequential = !mdast.ordered || isSequential(mdast, ctx);
    base.kids = mdast.children.map((item, i) => {
      const pm = node.child(i);
      const itemBase = baseOf(
        item as unknown as RootContent,
        pm,
        ctx,
        mdast.children[i + 1] as RootContent | undefined,
      );
      return itemBase;
    });
    return base;
  }
  if (mdast.type === ("listItem" as string) && node.type.name === "list_item") {
    const item = mdast as unknown as Extract<Nodes, { type: "listItem" }>;
    const first = item.children[0];
    if (item.checked == null && first?.position && first.position.start.line === item.position?.start.line) {
      const width = first.position.start.column - column;
      const prefix = base.raw?.slice(0, width);
      if (prefix && !prefix.includes("\n") && item.children.length === node.childCount) {
        base.prefix = prefix;
        base.kids = item.children.map((child, i) =>
          baseOf(child as RootContent, node.child(i), ctx, item.children[i + 1] as RootContent | undefined),
        );
      }
    }
    return base;
  }
  if (mdast.type === "table" && node.type.name === "table") {
    const firstRow = mdast.children[0];
    const secondRow = mdast.children[1];
    const from = firstRow?.position?.end.offset ?? 0;
    const to = secondRow?.position?.start.offset ?? mdast.position?.end.offset ?? from;
    const between = ctx.source.slice(from, to);
    base.kids = mdast.children.map((row, i) =>
      baseOf(
        row as unknown as RootContent,
        node.child(i),
        ctx,
        mdast.children[i + 1] as unknown as RootContent | undefined,
      ),
    );
    const first = base.kids[0];
    if (first) first.gapAfter = "\n";
    base.delimiter = { raw: between.trim(), canon: delimiterCanon(node) };
  }
  return base;
}

function delimiterCanon(table: PMNode): string {
  return canonOf(table).split("\n")[1] ?? "";
}

function isSequential(list: Extract<Nodes, { type: "list" }>, ctx: Ctx): boolean {
  const numbers = list.children.map((item) => Number.parseInt(rawOf(item, ctx), 10));
  return numbers.every((n, i) => n === (numbers[0] ?? 1) + i);
}

function plainFallback(source: string, eol: "\n" | "\r\n"): Parsed {
  // Whatever happened, the author still gets their document, whole and untouched.
  const lead = /^\s*/.exec(source)?.[0] ?? "";
  const trail = /\s*$/.exec(source.slice(lead.length))?.[0] ?? "";
  const raw = source.slice(lead.length, source.length - trail.length);
  const node = nodes.opaque_block.create({ raw, kind: "other" });
  return {
    doc: nodes.doc.create(null, [node]),
    baseline: {
      source,
      eol,
      lead,
      trail,
      blocks: [{ type: "opaque_block", raw, canon: canonOf(node), gapAfter: "" }],
    },
    stats: { rich: 0, raw: 1 },
  };
}

export function parseBody(source: string): Parsed {
  const eol = /\r\n/.test(source) && !/(^|[^\r])\n/.test(source) ? "\r\n" : "\n";
  const root = parseMdast(source);
  if (root.children.length === 0) {
    return {
      doc: nodes.doc.create(null, [nodes.paragraph.create()]),
      baseline: { source, eol, lead: source, trail: "", blocks: [] },
      stats: { rich: 0, raw: 0 },
    };
  }
  const ctx: Ctx = { source, strict: false };
  const strict: Ctx = { source, strict: true };
  const made: PMNode[] = [];
  const blocks: BaseBlock[] = [];
  const stats = { rich: 0, raw: 0 };
  root.children.forEach((child, i) => {
    const raw = rawOf(child, ctx);
    let node = blockOf(child, ctx);
    const faithful = () => {
      const canon = canonOf(node);
      const lf = raw.replace(/\r\n/g, "\n");
      return canon === lf || sameMeaning(lf, canon);
    };
    if (!faithful() && "children" in child) {
      // Keep what can be kept: only the part that won't survive goes raw.
      node = blockOf(child, strict);
    }
    if (!faithful()) node = opaque(child, ctx);
    if (node.type.name === "opaque_block") stats.raw++;
    else stats.rich++;
    made.push(node);
    blocks.push(baseOf(child, node, ctx, root.children[i + 1]));
  });
  const firstAt = root.children[0]?.position?.start.offset ?? 0;
  const lastAt = root.children[root.children.length - 1]?.position?.end.offset ?? source.length;
  const baseline: Baseline = {
    source,
    eol,
    lead: source.slice(0, firstAt),
    trail: source.slice(lastAt),
    blocks,
  };
  // Every byte has to be accounted for, or the source can't be trusted as a map.
  const rebuilt = baseline.lead + blocks.map((b) => (b.raw ?? "") + b.gapAfter).join("") + baseline.trail;
  if (rebuilt !== source) return plainFallback(source, eol);
  try {
    return { doc: nodes.doc.create(null, made), baseline, stats };
  } catch {
    return plainFallback(source, eol);
  }
}
