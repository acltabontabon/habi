/**
 * The document the Studio edits. Everything in it maps to ordinary Markdown,
 * and anything that doesn't is kept as a raw node holding the author's text:
 * `opaque_block` between blocks, `inline_raw` inside a line. Style details an
 * author chose (`_x_` over `*x*`, `*` bullets, `~~~` fences) live in attrs, so
 * an edited block is written back the way it was found.
 */
import { type DOMOutputSpec, type MarkSpec, type NodeSpec, Schema } from "prosemirror-model";
import { tableNodes } from "prosemirror-tables";

const table = tableNodes({
  tableGroup: "block",
  cellContent: "inline*",
  cellAttributes: {
    align: {
      default: null,
      getFromDOM: (dom) => (dom as HTMLElement).style.textAlign || null,
      setDOMAttr: (value, attrs) => {
        if (value) attrs.style = `${(attrs.style as string) ?? ""}text-align:${value as string};`;
      },
    },
  },
});

const nodes: Record<string, NodeSpec> = {
  doc: { content: "block+" },
  paragraph: {
    content: "inline*",
    group: "block",
    parseDOM: [{ tag: "p" }],
    toDOM: () => ["p", 0],
  },
  heading: {
    attrs: { level: { default: 2 }, setext: { default: false } },
    content: "inline*",
    group: "block",
    defining: true,
    parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({ tag: `h${level}`, attrs: { level } })),
    toDOM: (node) => [`h${node.attrs.level as number}`, 0],
  },
  blockquote: {
    attrs: { callout: { default: null } },
    content: "block+",
    group: "block",
    defining: true,
    parseDOM: [{ tag: "blockquote" }],
    toDOM: (node) => {
      const kind = node.attrs.callout as string | null;
      return kind
        ? ["blockquote", { class: `doc-callout is-${kind.toLowerCase()}`, "data-kind": kind }, 0]
        : ["blockquote", 0];
    },
  },
  bullet_list: {
    attrs: { marker: { default: "-" }, spread: { default: false } },
    content: "list_item+",
    group: "block",
    parseDOM: [{ tag: "ul" }],
    toDOM: () => ["ul", 0],
  },
  ordered_list: {
    attrs: { start: { default: 1 }, delim: { default: "." }, spread: { default: false } },
    content: "list_item+",
    group: "block",
    parseDOM: [
      {
        tag: "ol",
        getAttrs: (dom) => ({ start: Number((dom as HTMLElement).getAttribute("start") ?? 1) || 1 }),
      },
    ],
    toDOM: (node) => (node.attrs.start === 1 ? ["ol", 0] : ["ol", { start: node.attrs.start as number }, 0]),
  },
  list_item: {
    attrs: { checked: { default: null } },
    content: "block+",
    defining: true,
    parseDOM: [{ tag: "li" }],
    toDOM: (node) => {
      const checked = node.attrs.checked as boolean | null;
      return checked === null ? ["li", 0] : ["li", { class: "doc-task", "data-checked": String(checked) }, 0];
    },
  },
  code_block: {
    attrs: { info: { default: "" }, fence: { default: "```" } },
    content: "text*",
    marks: "",
    group: "block",
    code: true,
    defining: true,
    parseDOM: [
      {
        tag: "pre",
        preserveWhitespace: "full",
        getAttrs: (dom) => ({ info: (dom as HTMLElement).dataset.info ?? "" }),
      },
    ],
    toDOM: (node) => ["pre", { "data-info": node.attrs.info as string }, ["code", 0]],
  },
  horizontal_rule: {
    attrs: { style: { default: "---" } },
    group: "block",
    parseDOM: [{ tag: "hr" }],
    toDOM: () => ["hr"],
  },
  /** What the editor doesn't understand, kept exactly as written. */
  opaque_block: {
    attrs: { raw: { default: "" }, kind: { default: "html" } },
    group: "block",
    atom: true,
    selectable: true,
    defining: true,
    isolating: true,
    parseDOM: [
      {
        tag: "pre[data-opaque]",
        getAttrs: (dom) => ({
          raw: (dom as HTMLElement).textContent ?? "",
          kind: (dom as HTMLElement).dataset.opaque ?? "html",
        }),
      },
    ],
    // Always literal text: imported HTML is never rendered.
    toDOM: (node): DOMOutputSpec => [
      "pre",
      { "data-opaque": node.attrs.kind as string, class: "doc-opaque" },
      node.attrs.raw as string,
    ],
  },
  ...table,
  text: { group: "inline" },
  image: {
    attrs: { src: { default: "" }, alt: { default: "" }, title: { default: null } },
    inline: true,
    group: "inline",
    atom: true,
    draggable: true,
    parseDOM: [
      {
        tag: "span[data-image]",
        getAttrs: (dom) => {
          const d = (dom as HTMLElement).dataset;
          return { src: d.src ?? "", alt: d.alt ?? "", title: d.title ?? null };
        },
      },
    ],
    // Loading happens in the node view, which only ever reads the skill's own files.
    toDOM: (node): DOMOutputSpec => [
      "span",
      {
        "data-image": "",
        "data-src": node.attrs.src as string,
        "data-alt": node.attrs.alt as string,
        ...(node.attrs.title ? { "data-title": node.attrs.title as string } : {}),
      },
      (node.attrs.alt as string) || (node.attrs.src as string),
    ],
  },
  hard_break: {
    attrs: { style: { default: "backslash" } },
    inline: true,
    group: "inline",
    selectable: false,
    parseDOM: [{ tag: "br" }],
    toDOM: () => ["br"],
  },
  /** Inline Markdown the editor doesn't model (HTML, footnotes, `[a][b]`). */
  inline_raw: {
    attrs: { raw: { default: "" }, display: { default: null }, kind: { default: "html" } },
    inline: true,
    group: "inline",
    atom: true,
    parseDOM: [
      {
        tag: "span[data-raw]",
        getAttrs: (dom) => {
          const d = (dom as HTMLElement).dataset;
          return { raw: d.raw ?? "", display: d.display ?? null, kind: d.kind ?? "html" };
        },
      },
    ],
    toDOM: (node): DOMOutputSpec => [
      "span",
      {
        "data-raw": node.attrs.raw as string,
        "data-kind": node.attrs.kind as string,
        ...(node.attrs.display != null ? { "data-display": node.attrs.display as string } : {}),
        class: `doc-raw is-${node.attrs.kind as string}`,
      },
      (node.attrs.display as string | null) ?? (node.attrs.raw as string),
    ],
  },
  /**
   * One mention of another skill. `name` is the identity (written `` `name` skill ``
   * or, with a plugin, `` `plugin:name` ``). `role` says the author deliberately
   * composed it, and `from` where they found it. Both travel with the chip through
   * moves, copies and undo, and neither is ever written into the Markdown.
   */
  skill_ref: {
    attrs: {
      name: { default: "" },
      plugin: { default: null },
      role: { default: null },
      from: { default: null },
    },
    inline: true,
    group: "inline",
    atom: true,
    draggable: true,
    selectable: true,
    parseDOM: [
      {
        tag: "span[data-skill-ref]",
        getAttrs: (dom) => {
          const d = (dom as HTMLElement).dataset;
          return {
            name: d.skillRef ?? "",
            plugin: d.plugin ?? null,
            role: d.role ?? null,
            from: d.from ?? null,
          };
        },
      },
    ],
    toDOM: (node): DOMOutputSpec => [
      "span",
      {
        "data-skill-ref": node.attrs.name as string,
        ...(node.attrs.plugin ? { "data-plugin": node.attrs.plugin as string } : {}),
        ...(node.attrs.role ? { "data-role": node.attrs.role as string } : {}),
        ...(node.attrs.from ? { "data-from": node.attrs.from as string } : {}),
      },
      node.attrs.name as string,
    ],
  },
};

const marks: Record<string, MarkSpec> = {
  link: {
    attrs: { href: {}, title: { default: null } },
    inclusive: false,
    parseDOM: [
      {
        tag: "a[href]",
        getAttrs: (dom) => ({
          href: (dom as HTMLElement).getAttribute("href"),
          title: (dom as HTMLElement).getAttribute("title"),
        }),
      },
    ],
    // Never navigates by itself: opening a link is a deliberate ⌘-click handled by the editor.
    toDOM: (mark) => [
      "a",
      { href: mark.attrs.href as string, title: mark.attrs.title as string | null, rel: "noreferrer" },
      0,
    ],
  },
  em: {
    attrs: { marker: { default: "*" } },
    parseDOM: [{ tag: "em" }, { tag: "i" }],
    toDOM: () => ["em", 0],
  },
  strong: {
    attrs: { marker: { default: "**" } },
    parseDOM: [{ tag: "strong" }, { tag: "b" }],
    toDOM: () => ["strong", 0],
  },
  strike: {
    attrs: { marker: { default: "~~" } },
    parseDOM: [{ tag: "del" }, { tag: "s" }],
    toDOM: () => ["del", 0],
  },
  code: {
    parseDOM: [{ tag: "code" }],
    toDOM: () => ["code", 0],
  },
};

type NodeName =
  | "doc"
  | "paragraph"
  | "heading"
  | "blockquote"
  | "bullet_list"
  | "ordered_list"
  | "list_item"
  | "code_block"
  | "horizontal_rule"
  | "opaque_block"
  | "table"
  | "table_row"
  | "table_cell"
  | "table_header"
  | "text"
  | "image"
  | "hard_break"
  | "inline_raw"
  | "skill_ref";
type MarkName = "link" | "em" | "strong" | "strike" | "code";

export const schema = new Schema<NodeName, MarkName>({
  nodes: nodes as Record<NodeName, NodeSpec>,
  marks: marks as Record<MarkName, MarkSpec>,
});
