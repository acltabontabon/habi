import { Transform } from "prosemirror-transform";
import { describe, expect, it } from "vitest";
import { parseBody } from "../doc/markdown/parse";
import { write } from "../doc/markdown/reconcile";
import {
  type ComposeEntry,
  deriveComposes,
  isOptional,
  matchTemplate,
  mentionOf,
  occurrencesIn,
  ROLES,
  rolesForOpening,
  sentenceFor,
  USED_HERE,
} from "./roles";

function withRoles(source: string, roles: (string | null)[]) {
  const parsed = parseBody(source);
  const tr = new Transform(parsed.doc);
  occurrencesIn(parsed.doc).forEach((o, i) => {
    if (roles[i]) tr.setNodeAttribute(o.pos, "role", roles[i]);
  });
  return { doc: tr.doc, parsed };
}

describe("a sentence and its role", () => {
  const m = mentionOf("security-review");

  it("recognizes every one of Habi's own wordings, and writes them back", () => {
    for (const role of ROLES) {
      const sentence = sentenceFor(role.id, m);
      expect(matchTemplate(sentence, m)?.role).toBe(role.id);
    }
  });

  it("keeps what the author filled in", () => {
    const found = matchTemplate(`When the change touches login, use the ${m}.`, m);
    expect(found).toEqual({ role: "when-relevant", blank: "the change touches login" });
    expect(sentenceFor("before", m, found?.blank)).toBe(`Before the change touches login, check the ${m}.`);
  });

  it("never reads a role into an author's own sentence", () => {
    for (const sentence of [
      `Never use the ${m}.`,
      `Use the ${m}, then the \`x\` skill.`,
      `For example, the ${m} is one way.`,
      `When in doubt, don't use the ${m}. Then stop.`,
      `Follow the ${m} only on Fridays.`,
    ]) {
      expect(matchTemplate(sentence, m)).toBeNull();
    }
  });

  it("says a skill is optional only when every use of it does", () => {
    expect(isOptional(["if-available"])).toBe(true);
    expect(isOptional(["if-available", "before"])).toBe(false);
    expect(isOptional([])).toBe(false);
  });
});

describe("one skill, several uses", () => {
  const source = "Use the `a-b` skill.\n\nThen the `a-b` skill again.\n\nAnd the `a-b` skill once more.\n";

  it("is one dependency, with a role per use", () => {
    const { doc } = withRoles(source, ["before", "after", "if-available"]);
    expect(deriveComposes(doc, [], new Set())).toEqual([
      { skill: "a-b", roles: ["before", "after", "if-available"] },
    ]);
  });

  it("removing one use leaves the others and the dependency", () => {
    const { doc } = withRoles(source, ["before", "after", "if-available"]);
    const second = occurrencesIn(doc)[1];
    if (!second) throw new Error("no second use");
    const after = new Transform(doc).delete(second.pos, second.pos + 1).doc;
    expect(deriveComposes(after, [], new Set(["a-b"]))).toEqual([
      { skill: "a-b", roles: ["before", "if-available"] },
    ]);
  });

  it("changing one use's role touches only that use, and not the Markdown", () => {
    const { doc, parsed } = withRoles(source, ["before", "after", "if-available"]);
    const first = occurrencesIn(doc)[0];
    if (!first) throw new Error("no use");
    const after = new Transform(doc).setNodeAttribute(first.pos, "role", "alongside").doc;
    expect(deriveComposes(after, [], new Set())[0]?.roles).toEqual(["alongside", "after", "if-available"]);
    expect(write(after, parsed.baseline).text).toBe(source);
  });

  it("removing the last use removes the dependency", () => {
    const { doc } = withRoles("Use the `a-b` skill.\n", ["before"]);
    const only = occurrencesIn(doc)[0];
    if (!only) throw new Error("no use");
    const after = new Transform(doc).delete(only.pos, only.pos + 1).doc;
    expect(deriveComposes(after, [{ skill: "a-b", roles: ["before"] }], new Set(["a-b"]))).toEqual([]);
  });
});

describe("deliberate and merely mentioned", () => {
  it("a mention alone isn't a dependency", () => {
    const { doc } = withRoles("Use the `a-b` skill.\n", []);
    expect(deriveComposes(doc, [], new Set())).toEqual([]);
  });

  it("keeps an entry the instructions no longer mention if an outside edit caused it", () => {
    const { doc } = withRoles("No mention now.\n", []);
    const entry: ComposeEntry = { skill: "gone", roles: ["before"] };
    expect(deriveComposes(doc, [entry], new Set())).toEqual([entry]);
  });

  it("keeps where a skill came from, through edits", () => {
    const { doc } = withRoles("Use the `a-b` skill.\n", ["before"]);
    const from = { library: "https://example.org/l.git", id: "a-b", digest: "sha256:1" };
    expect(deriveComposes(doc, [{ skill: "a-b", roles: ["x"], from }], new Set())).toEqual([
      { skill: "a-b", roles: ["before"], from },
    ]);
  });
});

describe("opening a document", () => {
  const openingOf = (source: string, entries: ComposeEntry[]) => {
    const { doc } = parseBody(source);
    const roles = rolesForOpening(doc, entries);
    return occurrencesIn(doc).map((o) => roles.get(o.pos)?.role ?? null);
  };

  it("takes a role from Habi's own sentence before anything else", () => {
    expect(
      openingOf("If you have the `a-b` skill, use it for tests.\n", [{ skill: "a-b", roles: ["before"] }]),
    ).toEqual(["if-available"]);
  });

  it("restores roles by position when the count still matches", () => {
    expect(
      openingOf("Mine: the `a-b` skill.\n\nAnd: the `a-b` skill.\n", [
        { skill: "a-b", roles: ["before", "after"] },
      ]),
    ).toEqual(["before", "after"]);
  });

  it("says it doesn't know when the count changed, rather than guessing", () => {
    expect(openingOf("Mine: the `a-b` skill.\n", [{ skill: "a-b", roles: ["before", "after"] }])).toEqual([
      USED_HERE,
    ]);
  });

  it("leaves mentions of skills that aren't composed alone", () => {
    expect(openingOf("The `x-y` skill.\n", [{ skill: "a-b", roles: [] }])).toEqual([null]);
  });
});
