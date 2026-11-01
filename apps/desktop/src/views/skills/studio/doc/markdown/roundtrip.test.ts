import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Transform } from "prosemirror-transform";
import { describe, expect, it } from "vitest";
import { parseBody } from "./parse";
import { write } from "./reconcile";
import { schema } from "./schema";
import { changedLines, checkDocument, HARD_DOCUMENTS, randomFrom, textSites } from "./testing";
import { sameMeaning, verifyOutput } from "./verify";

describe("a document nobody edits", () => {
  for (const [name, source] of Object.entries(HARD_DOCUMENTS)) {
    it(`is byte-identical: ${name}`, () => {
      const parsed = parseBody(source);
      expect(write(parsed.doc, parsed.baseline).text).toBe(source);
    });
  }
});

describe("what is rich reads the same when written fresh", () => {
  for (const [name, source] of Object.entries(HARD_DOCUMENTS)) {
    it(name, () => {
      const parsed = parseBody(source);
      const fresh = parseBody("");
      expect(fresh.stats.rich).toBe(0);
      // Written with no source to reuse, a document must still say the same thing.
      expect(sameMeaning(write(parsed.doc, fresh.baseline).text, source)).toBe(true);
    });
  }
});

describe("one edit", () => {
  for (const [name, source] of Object.entries(HARD_DOCUMENTS)) {
    it(`stays in its block: ${name}`, () => {
      const report = checkDocument(name, parseBody(source), source, 7, 40);
      expect(report.failures).toEqual([]);
    });
  }

  it("keeps a wrapped paragraph's lines", () => {
    const source = "First line of it\nsecond line of it\nthird line of it\n\nAfter.\n";
    const parsed = parseBody(source);
    const at = "First line of it second ".length + 1;
    const doc = new Transform(parsed.doc).insert(at, schema.text("NEW ")).doc;
    expect(write(doc, parsed.baseline).text).toBe(
      "First line of it\nsecond NEW line of it\nthird line of it\n\nAfter.\n",
    );
  });

  it("keeps the emphasis markers the author used", () => {
    const source = "Some _under_ and __strong__ here.\n";
    const parsed = parseBody(source);
    const doc = new Transform(parsed.doc).insert(1, schema.text("Now ")).doc;
    expect(write(doc, parsed.baseline).text).toBe("Now Some _under_ and __strong__ here.\n");
  });

  it("changes one list item and leaves its neighbours' odd spacing", () => {
    const source = "-   wide\n-   wide two\n-   wide three\n";
    const parsed = parseBody(source);
    const list = parsed.doc.child(0);
    const second = 1 + list.child(0).nodeSize + 2;
    const doc = new Transform(parsed.doc).insert(second, schema.text("x")).doc;
    expect(write(doc, parsed.baseline).text).toBe("-   wide\n-   xwide two\n-   wide three\n");
  });

  it("changes one cell's row and leaves the table's other rows", () => {
    const source = "|Name  |Kind|\n|:--|--:|\n|aaa   |b|\n|ccc   |d|\n";
    const parsed = parseBody(source);
    const table = parsed.doc.child(0);
    const firstRow = table.child(0);
    const secondRow = table.child(1);
    const at = 1 + firstRow.nodeSize + secondRow.nodeSize + 2;
    const doc = new Transform(parsed.doc).insert(at, schema.text("z")).doc;
    expect(write(doc, parsed.baseline).text).toBe("|Name  |Kind|\n|:--|--:|\n|aaa   |b|\n| zccc | d |\n");
  });

  it("keeps CRLF in what it writes", () => {
    const source = "a\r\n\r\nb\r\n";
    const parsed = parseBody(source);
    const doc = new Transform(parsed.doc).insert(
      parsed.doc.content.size,
      schema.nodes.paragraph.create(null, schema.text("c")),
    ).doc;
    expect(write(doc, parsed.baseline).text).toBe("a\r\n\r\nb\r\n\r\nc\r\n");
    expect(write(doc, parsed.baseline).text).not.toMatch(/[^\r]\n/);
  });
});

describe("structure", () => {
  it("undo gives back the original bytes", () => {
    const source = "Odd  spacing   kept\n\n\n* star\n* star\n";
    const parsed = parseBody(source);
    const tr = new Transform(parsed.doc).insert(1, schema.text("x"));
    const back = tr.steps[0]?.invert(parsed.doc).apply(tr.doc).doc;
    expect(back).toBeTruthy();
    if (back) expect(write(back, parsed.baseline).text).toBe(source);
  });

  it("moving a block keeps both blocks' bytes", () => {
    const source = "Para  one\n\n\n* star\n* star\n\nPara three\n";
    const parsed = parseBody(source);
    const first = parsed.doc.child(0);
    const tr = new Transform(parsed.doc);
    tr.delete(0, first.nodeSize);
    tr.insert(tr.doc.content.size, first);
    const out = write(tr.doc, parsed.baseline).text;
    expect(out).toContain("* star\n* star");
    expect(out).toContain("Para  one");
    expect(out.endsWith("Para  one\n")).toBe(true);
    expect(verifyOutput(out, tr.doc)).toBe("same");
  });

  it("deleting a block leaves the others' bytes", () => {
    const source = "* a\n* b\n\nMiddle\n\n- c\n- d\n";
    const parsed = parseBody(source);
    const mid = parsed.doc.child(1);
    const from = parsed.doc.child(0).nodeSize;
    const doc = new Transform(parsed.doc).delete(from, from + mid.nodeSize).doc;
    expect(write(doc, parsed.baseline).text).toBe("* a\n* b\n\n- c\n- d\n");
  });

  it("a separator doesn't turn the block above into a heading when it moves", () => {
    const source = "Foo\n\n---\n\nBar\n";
    const parsed = parseBody(source);
    const rule = parsed.doc.child(1);
    const at = parsed.doc.child(0).nodeSize;
    const tr = new Transform(parsed.doc).delete(at, at + rule.nodeSize);
    const out = write(tr.doc, parsed.baseline).text;
    expect(out).toBe("Foo\n\nBar\n");
    const out2 = write(tr.insert(tr.doc.content.size, rule).doc, parsed.baseline).text;
    expect(verifyOutput(out2, tr.doc)).toBe("same");
  });

  it("renumbers a counted list and leaves a repeating one", () => {
    const counted = parseBody("1. a\n2. b\n3. c\n");
    const list = counted.doc.child(0);
    const first = list.child(0);
    const tr = new Transform(counted.doc).delete(1, 1 + first.nodeSize);
    expect(write(tr.doc, counted.baseline).text).toBe("1. b\n2. c\n");

    const repeating = parseBody("1. a\n1. b\n1. c\n");
    const rFirst = repeating.doc.child(0).child(0);
    const rTr = new Transform(repeating.doc).delete(1, 1 + rFirst.nodeSize);
    expect(write(rTr.doc, repeating.baseline).text).toBe("1. b\n1. c\n");
  });

  it("an empty trailing paragraph isn't content", () => {
    const source = "Text\n";
    const parsed = parseBody(source);
    const doc = new Transform(parsed.doc).insert(
      parsed.doc.content.size,
      schema.nodes.paragraph.create(),
    ).doc;
    expect(write(doc, parsed.baseline).text).toBe(source);
  });
});

describe("what stays raw", () => {
  const raws = (source: string) => {
    const kinds: string[] = [];
    parseBody(source).doc.descendants((n) => {
      if (n.type.name === "opaque_block" || n.type.name === "inline_raw") kinds.push(n.attrs.raw as string);
      return true;
    });
    return kinds;
  };

  it("keeps HTML as text and everything around it rich", () => {
    const parsed = parseBody('Before\n\n<div onclick="x">hi</div>\n\n- after\n');
    expect(parsed.doc.child(0).type.name).toBe("paragraph");
    expect(parsed.doc.child(1).type.name).toBe("opaque_block");
    expect(parsed.doc.child(1).attrs.raw).toBe('<div onclick="x">hi</div>');
    expect(parsed.doc.child(2).type.name).toBe("bullet_list");
  });

  it("keeps entities, reference links and inline HTML as written", () => {
    expect(raws("&nbsp;")).toEqual(["&nbsp;"]);
    expect(raws("[a][b]\n\n[b]: u\n")).toContain("[a][b]");
    expect(raws("x <b>y</b>")).toEqual(["<b>", "</b>"]);
  });

  it("isolates a block rather than giving up on the document", () => {
    const parsed = parseBody(HARD_DOCUMENTS.html ?? "");
    expect(parsed.stats.rich).toBeGreaterThan(0);
  });
});

describe("skills in prose", () => {
  const refs = (source: string) => {
    const found: string[] = [];
    parseBody(source).doc.descendants((n) => {
      if (n.type.name === "skill_ref")
        found.push(n.attrs.plugin ? `${n.attrs.plugin}:${n.attrs.name}` : n.attrs.name);
      return true;
    });
    return found;
  };

  it("recognizes the two ways a skill is named", () => {
    expect(refs("Use the `security-review` skill.")).toEqual(["security-review"]);
    expect(refs("Call `superpowers:writing-plans`.")).toEqual(["superpowers:writing-plans"]);
  });

  it("leaves other code alone", () => {
    expect(refs("Run `npm`. The `api` skills. A `Bad-Name` skill. A `x` skillful.")).toEqual([]);
    expect(refs("```\nthe `security-review` skill\n```")).toEqual([]);
  });

  it("a role never reaches the Markdown", () => {
    const parsed = parseBody("Use the `a-b` skill.\n");
    const para = parsed.doc.child(0);
    let at = 1;
    para.forEach((child, offset) => {
      if (child.type.name === "skill_ref") at = 1 + offset;
    });
    const doc = new Transform(parsed.doc).setNodeAttribute(at, "role", "before").doc;
    expect(write(doc, parsed.baseline).text).toBe("Use the `a-b` skill.\n");
  });
});

describe("the safety net", () => {
  it("reports when a file would read differently", () => {
    const parsed = parseBody("One\n\nTwo\n");
    expect(verifyOutput("One\n\nTwo\n", parsed.doc)).toBe("same");
    expect(verifyOutput("One\n\nThree\n", parsed.doc)).toBe("differs");
    expect(verifyOutput("**One**\n\nTwo\n", parsed.doc)).toBe("words");
  });
});

describe("random edits on every difficult document", () => {
  it("never lose a word or leave their block", () => {
    const failures: string[] = [];
    let edits = 0;
    for (let seed = 1; seed <= 25; seed++) {
      for (const [name, source] of Object.entries(HARD_DOCUMENTS)) {
        const report = checkDocument(`${name}@${seed}`, parseBody(source), source, seed * 7919, 12);
        failures.push(...report.failures);
        edits += report.edits;
      }
    }
    expect(edits).toBeGreaterThan(5000);
    expect(failures.slice(0, 8)).toEqual([]);
  }, 120_000);

  it("deleting any stretch of text inside a block stays inside it", () => {
    const failures: string[] = [];
    for (const [name, source] of Object.entries(HARD_DOCUMENTS)) {
      const parsed = parseBody(source);
      const rnd = randomFrom(99);
      for (const site of textSites(parsed.doc)) {
        const size = site.node.content.size;
        if (size < 2) continue;
        const from = rnd(size - 1);
        const to = from + 1 + rnd(size - from - 1);
        let tr: Transform;
        try {
          tr = new Transform(parsed.doc).delete(site.pos + from, site.pos + to);
        } catch {
          continue;
        }
        const out = write(tr.doc, parsed.baseline).text;
        if (verifyOutput(out, tr.doc) === "differs") failures.push(`${name}: ${JSON.stringify(out)}`);
        if (!changedLines(source, out)) continue;
      }
    }
    expect(failures).toEqual([]);
  });
});

/** Real skills on this machine, never committed. HABI_CORPUS=dir[:dir] pnpm vitest run roundtrip */
const corpus = process.env.HABI_CORPUS;
describe.skipIf(!corpus)("the local corpus", () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      try {
        if (statSync(path).isDirectory()) {
          if (entry !== "node_modules" && entry !== ".git") walk(path);
        } else if (entry === "SKILL.md") files.push(path);
      } catch {
        // A dangling link in someone's skills folder isn't this test's business.
      }
    }
  };
  for (const dir of (corpus ?? "").split(":").filter(Boolean)) walk(dir);
  const bodyOf = (text: string) => {
    const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(text);
    return m ? text.slice(m[0].length) : text;
  };

  it("holds the promises", () => {
    const failures: string[] = [];
    let rich = 0;
    let raw = 0;
    let edits = 0;
    let allRaw = 0;
    let parseMs = 0;
    for (const file of files) {
      const source = bodyOf(readFileSync(file, "utf8"));
      const t = performance.now();
      const parsed = parseBody(source);
      parseMs += performance.now() - t;
      const report = checkDocument(file, parsed, source, 31, 30);
      failures.push(...report.failures);
      rich += report.richBlocks;
      raw += report.rawBlocks;
      edits += report.edits;
      if (report.richBlocks === 0 && report.rawBlocks > 0) allRaw++;
    }
    console.log(
      JSON.stringify({
        skills: files.length,
        rich,
        raw,
        richShare: rich / Math.max(1, rich + raw),
        allRaw,
        edits,
        failures: failures.length,
        parseMs: Math.round(parseMs),
      }),
    );
    expect(failures.slice(0, 5).map((f) => f.slice(0, 600))).toEqual([]);
    expect(allRaw).toBe(0);
    expect(rich / Math.max(1, rich + raw)).toBeGreaterThanOrEqual(0.95);
  }, 300_000);

  it("is fast enough to type in", () => {
    const largest = files.map((f) => bodyOf(readFileSync(f, "utf8"))).sort((a, b) => b.length - a.length)[0];
    if (!largest) return;
    const parsed = parseBody(largest);
    const rnd = randomFrom(5);
    const samples: number[] = [];
    const sites = textSites(parsed.doc);
    let doc = parsed.doc;
    for (let i = 0; i < 200; i++) {
      const site = sites[rnd(sites.length)];
      if (!site) continue;
      doc = new Transform(parsed.doc).insert(site.pos, schema.text("x")).doc;
      const t = performance.now();
      write(doc, parsed.baseline);
      samples.push(performance.now() - t);
    }
    samples.sort((a, b) => a - b);
    const t = performance.now();
    verifyOutput(write(doc, parsed.baseline).text, doc);
    const verifyMs = performance.now() - t;
    const p95 = samples[Math.floor(samples.length * 0.95)] ?? 0;
    console.log(
      JSON.stringify({
        bytes: largest.length,
        blocks: parsed.doc.childCount,
        writeP95Ms: +p95.toFixed(2),
        verifyMs: +verifyMs.toFixed(1),
      }),
    );
    expect(p95).toBeLessThanOrEqual(8);
  }, 60_000);
});
