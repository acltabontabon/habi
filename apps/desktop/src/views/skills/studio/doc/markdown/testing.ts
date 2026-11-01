/** What the round-trip tests share: difficult documents, and edits made at random but repeatably. */
import type { Node as PMNode } from "prosemirror-model";
import { Transform } from "prosemirror-transform";
import { canonOf } from "./canon";
import type { Parsed } from "./parse";
import { write } from "./reconcile";
import { schema } from "./schema";
import { verifyOutput } from "./verify";

/** Everything here is made up, as fixtures must be. Each is a shape real skills use. */
export const HARD_DOCUMENTS: Record<string, string> = {
  empty: "",
  blank: "\n\n  \n",
  "one line, no newline": "Just a line",
  "wrapped paragraphs":
    "This paragraph is wrapped by hand\nso that it stays under a width,\nand every line break is the author's.\n\nA second one\n  with an indented continuation.\n",
  "emphasis styles":
    "One *star* and _under_ and **two** and __under__ and ***both*** and **_mixed_** and ~~gone~~ and ~one~.\n",
  "escapes and entities":
    "Literal \\*stars\\* and \\_under\\_, a \\[bracket\\], &copy; 2026, &nbsp;gap, &#35; hash, 2 * 3 = 6, a_b_c, <3 and 1 < 2 & 3.\n",
  "hard breaks": "Two spaces  \nbackslash\\\nend\n",
  headings: "# One\n\nTwo\n===\n\nThree\n---\n\n## Closed ##\n\n###### Six\n\n#\n",
  "bullets of every kind": "- dash\n- dash\n\n* star\n* star\n\n+ plus\n+ plus\n",
  "ordered lists":
    "1. one\n2. two\n3. three\n\n1. same\n1. same\n1. same\n\n7) seven\n8) eight\n\n9. nine\n10. ten\n",
  "loose and tight": "- tight\n- tight\n\ntext\n\n- loose\n\n- loose\n\n  with a second paragraph\n",
  "nested lists":
    "1. Step one\n   - detail\n   - detail\n     1. deep\n     2. deeper\n2. Step two\n\n   Continues here.\n\n   ```sh\n   echo hi\n   ```\n3. Step three\n",
  "wide markers": "-   wide\n-   wide\n\n1.  wide\n2.  wide\n",
  "task lists": "- [ ] todo\n- [x] done\n  - [ ] nested\n",
  "code everywhere":
    "```python\nprint('hi')\n```\n\n~~~ yaml title=x\na: 1\n~~~\n\n    indented code\n\n````md\n```\ninner\n```\n````\n\n```\n```\n",
  "unclosed fence": "Before\n\n```sh\nnever closed\n",
  tables:
    "| Name | Kind |\n| --- | :-: |\n| a | `x\\|y` |\n| **b** | [l](u) |\n\nNo edges | at all\n--- | ---\nq | r\n\n|Tight|Table|\n|:--|--:|\n|1|2|\n",
  quotes: "> A quote\n> over lines\n\n> Lazy\ncontinuation\n\n> - list in quote\n>\n> > nested\n",
  callouts: "> [!NOTE]\n> Worth knowing.\n\n> [!WARNING]\n> Careful\n> over lines.\n\n> [!TIP] Inline tip\n",
  links:
    "[plain](https://example.org) [titled](https://example.org \"T\") <https://example.org> https://example.org/a and www.example.org and me@example.org ![img](a.png) ![t](b.png 'x')\n",
  "reference links":
    'See [one][r], [two][], [r] and ![pic][p].\n\n[r]: https://example.org\n[two]: https://example.org "Two"\n[p]: a.png\n',
  footnotes:
    "A claim.[^1] Another.[^long]\n\n[^1]: The note.\n[^long]: First line\n\n    Second paragraph.\n",
  html: '<div class="x">\n  text\n</div>\n\nInline <b>bold</b> and <br> tag.\n\n<!-- a comment\nover lines -->\n\n<details>\n<summary>S</summary>\n\nInside.\n\n</details>\n',
  "xml tags with markdown":
    "<example>\nuser: hi\n\nassistant: hello\n</example>\n\n<instructions>\n\n- one\n- two\n\n</instructions>\n",
  "horizontal rules": "a\n\n---\n\nb\n\n***\n\nc\n\n___\n\nd\n\n- - -\n",
  "rule look-alikes": "Foo\n---\n\nFoo\n\n---\n\nFoo\n***\n",
  "frontmatter look-alike": "---\ntitle: not frontmatter\n---\n\nAfter\n",
  crlf: "# Title\r\n\r\nA wrapped\r\nparagraph.\r\n\r\n- one\r\n- two\r\n  - nested\r\n\r\n```sh\r\ncode\r\n```\r\n\r\n| a | b |\r\n| - | - |\r\n| 1 | 2 |\r\n",
  "mixed line endings": "one\r\ntwo\n\nthree\n",
  "tabs in lists": "- a\n\tmore\n-\tb\n\n\tindented code after list\n",
  "lazy list": "- a\ncontinues lazily\n- b\n",
  "many blank lines": "\n\n\na\n\n\n\nb\n\n\n",
  "trailing spaces": "line with spaces   \n\nanother  \n",
  "skill mentions":
    "When it matters, use the `security-review` skill.\n\nCall `superpowers:writing-plans` first. `not-a-skill` stays code, and the `api` skills too.\n\n**Then** use `a-b` skill, and `c-d` skill.\n",
  "code spans": "`a` ``b`c`` `` ` `` `  spaced  ` `` `` and **`bold code`** and *`em`*\n",
  "html comment splits lists": "- a\n<!-- x -->\n- b\n",
  "list then indented": "- a\n\n      code in item\n\n- b\n",
  "headings with marks": "# **Bold** title with `code`\n\n## A [link](u) here\n",
  "unicode and zero width": "Café — 日本語 🧵 and a hidden​space.\n",
  "ampersands and brackets": "AT&T [not a link] [x] and a ] alone, 5 > 3, a | b.\n",
};

/** A small repeatable generator, so a failure can be replayed from its seed. */
export function randomFrom(seed: number) {
  let s = seed >>> 0 || 1;
  return (below: number) => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s % below;
  };
}

export type Located = { from: number; to: number };

/** Where each top-level block sits in the source, in 0-based line numbers. */
export function blockLines(parsed: Parsed): Located[] {
  const { baseline } = parsed;
  const out: Located[] = [];
  let at = baseline.lead.length;
  const count = (upto: number) => baseline.source.slice(0, upto).split("\n").length - 1;
  for (const block of baseline.blocks) {
    const end = at + (block.raw?.length ?? 0);
    out.push({ from: count(at), to: count(end) });
    at = end + block.gapAfter.length;
  }
  return out;
}

/** The first and last line of `before` that differ from `after`, or null if none do. */
export function changedLines(before: string, after: string): Located | null {
  if (before === after) return null;
  const a = before.split("\n");
  const b = after.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;
  return { from: head, to: a.length - 1 - tail };
}

export type TextSite = { pos: number; node: PMNode; top: number };

/** Every block of text in the document, with which top-level block holds it. */
export function textSites(doc: PMNode): TextSite[] {
  const sites: TextSite[] = [];
  doc.forEach((top, _offset, index) => {
    if (top.isTextblock && top.type.name !== "code_block")
      sites.push({ pos: _offset + 1, node: top, top: index });
    top.descendants((node, pos) => {
      if (node.isTextblock && node.type.name !== "code_block")
        sites.push({ pos: _offset + pos + 2, node, top: index });
      return true;
    });
  });
  return sites;
}

export const WORDS = [
  "word",
  "two words",
  "a*b",
  "x_y",
  "`tick",
  "[box]",
  "<tag>",
  "&amp;",
  "1. no",
  "# no",
  "- no",
  "|pipe|",
  "~~",
  "\\",
  "![",
];

/** Inserts text into a random block, returning the block it landed in. */
export function insertAt(doc: PMNode, rnd: (n: number) => number): { doc: PMNode; top: number } | null {
  const sites = textSites(doc);
  if (sites.length === 0) return null;
  const site = sites[rnd(sites.length)];
  if (!site) return null;
  const offset = rnd(site.node.content.size + 1);
  const word = WORDS[rnd(WORDS.length)] ?? "word";
  const tr = new Transform(doc).insert(site.pos + offset, schema.text(` ${word} `));
  return { doc: tr.doc, top: site.top };
}

export type RoundTripReport = {
  failures: string[];
  edits: number;
  richBlocks: number;
  rawBlocks: number;
};

/** Runs the promises against one document, and says what broke. */
export function checkDocument(
  name: string,
  parsed: Parsed,
  source: string,
  seed: number,
  runs: number,
): RoundTripReport {
  const failures: string[] = [];
  const rnd = randomFrom(seed);
  const same = write(parsed.doc, parsed.baseline).text;
  if (same !== source) failures.push(`${name}: unchanged document isn't byte-identical`);
  const lines = blockLines(parsed);
  let edits = 0;
  for (let run = 0; run < runs; run++) {
    const edited = insertAt(parsed.doc, rnd);
    if (!edited) break;
    edits++;
    const out = write(edited.doc, parsed.baseline).text;
    const verdict = verifyOutput(out, edited.doc);
    if (verdict === "differs") failures.push(`${name}#${run}: output reads differently\n${out}`);
    const changed = changedLines(source, out);
    const allowed = lines[edited.top];
    if (changed && allowed && (changed.from < allowed.from || changed.to > allowed.to)) {
      failures.push(
        `${name}#${run}: change at lines ${changed.from}-${changed.to}, block ${edited.top} is ${allowed.from}-${allowed.to}\n--- out\n${out}`,
      );
    }
  }
  return { failures, edits, richBlocks: parsed.stats.rich, rawBlocks: parsed.stats.raw };
}

export { canonOf };
