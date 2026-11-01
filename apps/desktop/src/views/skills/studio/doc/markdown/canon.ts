/**
 * The Markdown a node would be written as if nothing of its source were left:
 * how a new or edited block reaches the file. Cached per node, which ProseMirror
 * shares between states, so a keystroke only ever costs the block it changed.
 */
import type { Mark, Node as PMNode } from "prosemirror-model";

const cache = new WeakMap<PMNode, string>();

/** Canonical Markdown of a block, with `\n` line endings and no trailing newline. */
export function canonOf(node: PMNode): string {
  const known = cache.get(node);
  if (known !== undefined) return known;
  const text = writeBlock(node);
  cache.set(node, text);
  return text;
}

function indentRest(text: string, by: string): string {
  return text
    .split("\n")
    .map((line, i) => (i === 0 || line === "" ? line : by + line))
    .join("\n");
}

function prefixAll(text: string, by: string, blank: string): string {
  return text
    .split("\n")
    .map((line) => (line === "" ? blank : by + line))
    .join("\n");
}

/** The marker of the item at `index` in a list node. */
export function listMarker(list: PMNode, index: number): string {
  if (list.type.name === "ordered_list") {
    return `${(list.attrs.start as number) + index}${list.attrs.delim as string} `;
  }
  return `${list.attrs.marker as string} `;
}

function writeItem(item: PMNode, marker: string, between: string): string {
  const task = item.attrs.checked === null ? "" : item.attrs.checked ? "[x] " : "[ ] ";
  const parts: string[] = [];
  item.forEach((child) => {
    parts.push(canonOf(child));
  });
  const body = parts.join(between);
  return marker + task + indentRest(body, " ".repeat(marker.length));
}

function writeBlock(node: PMNode): string {
  switch (node.type.name) {
    case "paragraph":
      return writeInline(node, true);
    case "heading": {
      const text = writeInline(node, false);
      const level = node.attrs.level as number;
      if (node.attrs.setext && level <= 2 && text.length > 0)
        return `${text}\n${level === 1 ? "===" : "---"}`;
      return text ? `${"#".repeat(level)} ${text}` : "#".repeat(level);
    }
    case "blockquote": {
      const parts: string[] = [];
      node.forEach((child) => {
        parts.push(canonOf(child));
      });
      const kind = node.attrs.callout as string | null;
      const body = parts.join("\n\n");
      const text = kind ? (body ? `[!${kind}]\n${body}` : `[!${kind}]`) : body;
      return prefixAll(text, "> ", ">");
    }
    case "bullet_list":
    case "ordered_list": {
      const between = node.attrs.spread ? "\n\n" : "\n";
      const items: string[] = [];
      node.forEach((item, _o, i) => {
        items.push(writeItem(item, listMarker(node, i), node.attrs.spread ? "\n\n" : "\n"));
      });
      return items.join(between);
    }
    case "list_item":
      return writeItem(node, "- ", "\n");
    case "code_block": {
      const text = node.textContent;
      let fence = node.attrs.fence as string;
      // A fence has to be longer than any run of its character inside.
      const char = fence[0] ?? "`";
      const runs = text.match(new RegExp(`\\${char}{3,}`, "g")) ?? [];
      const longest = Math.max(fence.length, ...runs.map((r) => r.length + 1));
      fence = char.repeat(longest);
      const info = node.attrs.info as string;
      return text ? `${fence}${info}\n${text}\n${fence}` : `${fence}${info}\n${fence}`;
    }
    case "horizontal_rule":
      return node.attrs.style as string;
    case "opaque_block":
      return (node.attrs.raw as string).replace(/\r\n/g, "\n");
    case "table":
      return writeTable(node);
    case "table_row":
      return writeRow(node);
    default:
      return node.textContent;
  }
}

function writeRow(row: PMNode): string {
  const cells: string[] = [];
  row.forEach((cell) => {
    const text = writeInline(cell, false).replace(/\|/g, (m, at: number, all: string) =>
      all[at - 1] === "\\" ? m : "\\|",
    );
    cells.push(text);
  });
  return `| ${cells.join(" | ")} |`;
}

/** The delimiter line of a table: `| --- | :-: |`. */
export function delimiterRow(table: PMNode): string {
  const first = table.firstChild;
  const cols: string[] = [];
  first?.forEach((cell) => {
    const align = cell.attrs.align as string | null;
    cols.push(align === "center" ? ":---:" : align === "right" ? "---:" : align === "left" ? ":---" : "---");
  });
  return `| ${cols.join(" | ")} |`;
}

function writeTable(table: PMNode): string {
  const rows: string[] = [];
  table.forEach((row, _o, i) => {
    rows.push(writeRow(row));
    if (i === 0) rows.push(delimiterRow(table));
  });
  return rows.join("\n");
}

const PUNCT = /[!-/:-@[-`{-~]/;
const WORD = /[\p{L}\p{N}]/u;

/** Escapes text so it reads back as itself, touching as little as possible. */
export function escapeText(text: string, atStart: boolean): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i);
    const prev = text.charAt(i - 1);
    const next = text.charAt(i + 1);
    switch (c) {
      case "\\":
        out += PUNCT.test(next) || next === "" ? "\\\\" : c;
        break;
      case "`":
        out += "\\`";
        break;
      case "*":
        out += (prev === "" || /\s/.test(prev)) && (next === "" || /\s/.test(next)) && i > 0 ? c : "\\*";
        break;
      case "_":
        out +=
          WORD.test(prev) && WORD.test(next)
            ? c
            : /\s/.test(prev || " ") && /\s/.test(next || " ")
              ? c
              : "\\_";
        break;
      case "~":
        out += next === "~" || prev === "~" ? "\\~" : c;
        break;
      case "[":
        out += text.indexOf("]", i) >= 0 || next === "" ? "\\[" : c;
        break;
      case "]":
        out += "\\]";
        break;
      case "!":
        out += next === "[" ? "\\!" : c;
        break;
      case "<":
        out += /[A-Za-z/!?]/.test(next) || next === "" ? "\\<" : c;
        break;
      case "&":
        out += /^&(#\d+|#[xX][\da-fA-F]+|[A-Za-z][A-Za-z\d]*);/.test(text.slice(i)) ? "\\&" : c;
        break;
      default:
        out += c;
    }
  }
  if (!atStart) return out;
  // What a line can't start with and stay a paragraph.
  return out
    .replace(/^(\s*)(#{1,6})(?=\s|$)/, "$1\\$2")
    .replace(/^(\s*)>/, "$1\\>")
    .replace(/^(\s*)([-+])(?=\s|$)/, "$1\\$2")
    .replace(/^(\s*)(\d{1,9})([.)])(?=\s|$)/, "$1$2\\$3")
    .replace(/^(\s*)(=+)(\s*)$/, "$1\\$2$3")
    .replace(/^(\s*)(-{3,}|_{3,}|\*{3,})(\s*)$/, "$1\\$2$3")
    .replace(/^(\s*)((?:- *){3,})$/, "$1\\$2")
    .replace(/^(\s*)(~~~|```)/, "$1\\$2")
    .replace(/^ {4,}/, "");
}

const rankOf = (mark: Mark) =>
  mark.type.spec === undefined
    ? 0
    : (({ link: 0, strike: 1, strong: 2, em: 3, code: 4 } as Record<string, number>)[mark.type.name] ?? 9);

type Run = { text: string; marks: readonly Mark[]; literal: boolean };

function open(mark: Mark): string {
  switch (mark.type.name) {
    case "link":
      return "[";
    case "code":
      return "";
    default:
      return mark.attrs.marker as string;
  }
}

function close(mark: Mark): string {
  switch (mark.type.name) {
    case "link": {
      const href = (mark.attrs.href as string).replace(/([()\s])/g, (c) => (c === " " ? "%20" : `\\${c}`));
      const title = mark.attrs.title as string | null;
      return title ? `](${href} "${title.replace(/(["\\])/g, "\\$1")}")` : `](${href})`;
    }
    case "code":
      return "";
    default:
      return mark.attrs.marker as string;
  }
}

function codeSpan(text: string): string {
  const runs = text.match(/`+/g) ?? [];
  let ticks = 1;
  while (runs.some((r) => r.length === ticks)) ticks++;
  const fence = "`".repeat(ticks);
  const pad = text.startsWith("`") || text.endsWith("`") || (/^ .* $/.test(text) && text.trim() !== "");
  return pad ? `${fence} ${text} ${fence}` : `${fence}${text}${fence}`;
}

/** A link whose text is its address is how an autolink reads back. */
function autolink(run: Run): boolean {
  const link = run.marks.find((m) => m.type.name === "link");
  if (!link || link.attrs.title) return false;
  const href = link.attrs.href as string;
  return (
    run.marks.length === 1 && run.text === href && /^https?:\/\/[^\s<>()*_~`[\]]+[A-Za-z0-9/]$/.test(href)
  );
}

function runsOf(parent: PMNode): Run[] {
  const runs: Run[] = [];
  parent.forEach((child) => {
    const marks = [...child.marks].sort((a, b) => rankOf(a) - rankOf(b));
    if (child.isText) {
      runs.push({ text: child.text ?? "", marks, literal: false });
      return;
    }
    let text: string;
    switch (child.type.name) {
      case "hard_break":
        text = child.attrs.style === "spaces" ? "  \n" : "\\\n";
        break;
      case "inline_raw":
        text = child.attrs.raw as string;
        break;
      case "image": {
        const title = child.attrs.title as string | null;
        const src = (child.attrs.src as string).replace(/([()\s])/g, (c) => (c === " " ? "%20" : `\\${c}`));
        const alt = (child.attrs.alt as string).replace(/([[\]\\])/g, "\\$1");
        text = title ? `![${alt}](${src} "${title.replace(/(["\\])/g, "\\$1")}")` : `![${alt}](${src})`;
        break;
      }
      case "skill_ref": {
        const name = child.attrs.name as string;
        const plugin = child.attrs.plugin as string | null;
        text = plugin ? `\`${plugin}:${name}\`` : `\`${name}\` skill`;
        break;
      }
      default:
        text = child.textContent;
    }
    runs.push({ text, marks, literal: true });
  });
  return runs;
}

/** Inline content as Markdown: marks opened and closed around runs, whitespace outside them. */
function writeInline(parent: PMNode, atStart: boolean): string {
  const runs = runsOf(parent);
  let out = "";
  const stack: Mark[] = [];
  const closeTo = (keep: number, tail: string) => {
    let closing = "";
    while (stack.length > keep) {
      const mark = stack.pop();
      if (mark) closing += close(mark);
    }
    out += closing + tail;
  };
  runs.forEach((run, i) => {
    if (autolink(run)) {
      closeTo(0, "");
      out += run.text;
      return;
    }
    const code = run.marks.some((m) => m.type.name === "code");
    const hasWrap = run.marks.some((m) => m.type.name !== "code" && m.type.name !== "link");
    let body = run.text;
    let lead = "";
    let trail = "";
    if (hasWrap && !run.literal && !code) {
      // `** a **` isn't emphasis: spaces go outside the markers.
      const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(body);
      lead = m?.[1] ?? "";
      body = m?.[2] ?? body;
      trail = m?.[3] ?? "";
    }
    // Keep what's still open, and close the rest.
    let keep = 0;
    while (keep < stack.length) {
      const mark = stack[keep];
      if (mark && run.marks.some((m) => m.eq(mark))) keep++;
      else break;
    }
    closeTo(keep, "");
    if (lead) {
      closeTo(0, "");
      keep = 0;
      out += lead;
    }
    for (const mark of run.marks) {
      if (mark.type.name === "code") continue;
      if (!stack.some((m) => m.eq(mark))) {
        out += open(mark);
        stack.push(mark);
      }
    }
    if (code) out += codeSpan(body);
    else if (run.literal) out += body;
    else out += escapeText(i === 0 ? body.trimStart() : body, atStart && out.trim() === "" && i === 0);
    if (trail) {
      closeTo(0, trail);
    }
  });
  closeTo(0, "");
  // Spaces around a line mean nothing, and at the start they would shift a list item's content.
  const last = runs[runs.length - 1];
  const breaks = last?.literal && last.text.endsWith("\n");
  return breaks ? out.trimStart() : out.trim();
}
