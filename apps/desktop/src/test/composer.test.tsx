import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { Transform } from "prosemirror-transform";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Composition } from "../bindings/Composition";
import type { Dependency } from "../bindings/Dependency";
import type { ShelfSkill } from "../bindings/ShelfSkill";
import { Inside } from "../views/skills/studio/compose/Inside";
import { Overview } from "../views/skills/studio/compose/Overview";
import { overviewOf } from "../views/skills/studio/compose/overviewData";
import { type InspectorTarget, RefInspector } from "../views/skills/studio/compose/RefInspector";
import { occurrencesIn } from "../views/skills/studio/compose/roles";
import { Shelf } from "../views/skills/studio/compose/Shelf";
import { WhenTokens } from "../views/skills/studio/compose/WhenTokens";
import { parseBody } from "../views/skills/studio/doc/markdown/parse";
import type { SkillDraft } from "../views/skills/studio/useSkillDraft";

Element.prototype.scrollIntoView = () => {};

const skill = (over: Partial<ShelfSkill> = {}): ShelfSkill => ({
  key: "machine:claude/security-review",
  name: "security-review",
  title: "Security Review",
  description: "Reviews changes for security problems.",
  origin: "machine",
  sourceLabel: "This machine",
  libraryUrl: null,
  itemId: null,
  digest: "d1",
  readers: ["claude-code"],
  cautions: [],
  duplicates: 0,
  sameContent: 0,
  ...over,
});

const dep = (over: Partial<Dependency> = {}): Dependency => ({
  name: "security-review",
  roles: ["when-relevant"],
  optional: false,
  from: null,
  status: "named",
  candidates: [],
  exact: null,
  changedSinceLinked: null,
  availability: [],
  nested: [],
  ...over,
});

const composition = (over: Partial<Composition> = {}): Composition => ({
  dependencies: [],
  mentioned: [],
  unmentioned: [],
  cycles: [],
  incoming: [],
  context: { discoveryTokens: 30, instructionsTokens: 100, files: [] },
  ...over,
});

const shelfProps = {
  loading: false,
  currentName: "this-skill",
  onPick: vi.fn(),
  onClose: vi.fn(),
};

describe("the shelf", () => {
  const skills = [
    skill(),
    skill({
      key: "mine:a",
      name: "test-coverage",
      title: "Test Coverage",
      description: "Finds what's untested.",
      origin: "mine",
      sourceLabel: "My skills",
    }),
    skill({
      key: "library:s/x",
      name: "database-safety",
      title: "Database Safety",
      description: "Checks migrations.",
      origin: "library",
      sourceLabel: "Team library",
    }),
    skill({
      key: "mine:self",
      name: "this-skill",
      title: "This skill",
      origin: "mine",
      sourceLabel: "My skills",
    }),
    skill({ key: "mine:blank", name: "", title: "", origin: "mine", sourceLabel: "My skills" }),
  ];

  it("groups by where skills are, and never shows a path", () => {
    render(<Shelf {...shelfProps} skills={skills} />);
    expect(screen.getByRole("group", { name: "My skills" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "This machine" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Team library" })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/~\/|\/Users|SKILL\.md/);
  });

  it("leaves out the skill being edited, and anything without a name", () => {
    render(<Shelf {...shelfProps} skills={skills} />);
    expect(screen.queryByText("This skill")).toBeNull();
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });

  it("finds by words, and works entirely from the keyboard", async () => {
    const onPick = vi.fn();
    render(<Shelf {...shelfProps} skills={skills} onPick={onPick} />);
    const input = screen.getByRole("combobox");
    expect(input).toHaveFocus();
    await userEvent.type(input, "migrations");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    await userEvent.keyboard("{Enter}");
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ name: "database-safety" }));
  });

  it("arrows move through the results", async () => {
    const onPick = vi.fn();
    render(<Shelf {...shelfProps} skills={skills} onPick={onPick} />);
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ name: "database-safety" }));
  });

  it("Escape closes it", async () => {
    const onClose = vi.fn();
    render(<Shelf {...shelfProps} skills={skills} onClose={onClose} />);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("says when copies of a skill differ, and shows cautions", () => {
    render(
      <Shelf
        {...shelfProps}
        skills={[
          skill({ duplicates: 2, sameContent: 0, cautions: [] }),
          skill({ key: "x", name: "other", title: "Other", cautions: ["Runs a downloaded script"] }),
        ]}
      />,
    );
    expect(screen.getByText(/Differs from 2 other copies/)).toBeInTheDocument();
    expect(screen.getByText("Runs a downloaded script")).toBeInTheDocument();
  });

  it("says that a link installs and runs nothing", () => {
    render(<Shelf {...shelfProps} skills={skills} />);
    expect(screen.getByText(/nothing is installed or run/)).toBeInTheDocument();
  });

  it("can be picked up as well as pressed", () => {
    const onLift = vi.fn();
    render(<Shelf {...shelfProps} skills={[skill()]} onLift={onLift} />);
    fireEvent.pointerDown(screen.getByRole("option"), { button: 0 });
    expect(onLift).toHaveBeenCalledWith(
      expect.objectContaining({ name: "security-review" }),
      expect.anything(),
    );
  });

  it("has no accessibility violations", async () => {
    const { container } = render(<Shelf {...shelfProps} skills={skills} />);
    const result = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(result.violations.map((v) => v.id)).toEqual([]);
  });
});

describe("one use, opened", () => {
  const target: InspectorTarget = {
    name: "security-review",
    pos: 5,
    rect: { left: 10, top: 10, bottom: 20 },
    role: "when-relevant",
    otherUses: [],
    canReword: true,
  };
  const handlers = {
    onRole: vi.fn(),
    onMakePart: vi.fn(),
    onRemove: vi.fn(),
    onReplace: vi.fn(),
    onJump: vi.fn(),
    onOpenSkill: vi.fn(),
    onConnect: vi.fn(),
    onFind: vi.fn(),
    onClose: vi.fn(),
  };

  it("changes what this use is for in plain words", async () => {
    const onRole = vi.fn();
    render(
      <RefInspector {...handlers} target={target} dependency={dep()} shelf={[skill()]} onRole={onRole} />,
    );
    expect(screen.getByRole("radio", { name: "When it's relevant" })).toBeChecked();
    await userEvent.click(screen.getByRole("radio", { name: "Afterwards" }));
    expect(onRole).toHaveBeenCalledWith("after");
  });

  it("never promises an agent will use it", () => {
    render(<RefInspector {...handlers} target={target} dependency={dep()} shelf={[skill()]} />);
    expect(screen.getByText(/decide for themselves whether to use it/)).toBeInTheDocument();
  });

  it("tells a mention apart from something composed, and lets the author promote it", async () => {
    const onMakePart = vi.fn();
    render(
      <RefInspector
        {...handlers}
        target={{ ...target, role: null }}
        dependency={undefined}
        shelf={[skill()]}
        onMakePart={onMakePart}
      />,
    );
    expect(screen.getByText(/Only named in the words/)).toBeInTheDocument();
    expect(screen.queryByRole("radio")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Link this skill" }));
    expect(onMakePart).toHaveBeenCalled();
  });

  it("says which agents would find it, and which wouldn't", () => {
    render(
      <RefInspector
        {...handlers}
        target={target}
        shelf={[skill()]}
        dependency={dep({
          availability: [
            { client: "claude-code", state: "found", place: "this machine" },
            { client: "cursor", state: "notFound", place: null },
            { client: "codex", state: "unknown", place: null },
          ],
        })}
      />,
    );
    const agents = within(screen.getByRole("list", { name: "Which agents would find it" }));
    expect(agents.getByText("found, this machine")).toBeInTheDocument();
    expect(agents.getByText("not found")).toBeInTheDocument();
    expect(agents.getByText("couldn't check")).toBeInTheDocument();
  });

  it("for a missing skill, offers ways on without installing anything", async () => {
    const onConnect = vi.fn();
    const onFind = vi.fn();
    render(
      <RefInspector
        {...handlers}
        target={target}
        shelf={[]}
        onConnect={onConnect}
        onFind={onFind}
        dependency={dep({ status: "missing", from: { library: "https://example.org/l" } })}
      />,
    );
    expect(screen.getByText(/Not found/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Connect the library it came from" }));
    expect(onConnect).toHaveBeenCalledWith("https://example.org/l");
    await userEvent.click(screen.getByRole("button", { name: "Find a match" }));
    expect(onFind).toHaveBeenCalled();
  });

  it("doesn't call a same-named skill the one that was linked", () => {
    render(
      <RefInspector
        {...handlers}
        target={target}
        shelf={[skill()]}
        dependency={dep({ from: { library: "https://example.org/l" } })}
      />,
    );
    expect(screen.getByText(/may not be the same one/)).toBeInTheDocument();
  });

  it("keeps other uses separate, with replacing them all as its own choice", async () => {
    const onReplace = vi.fn();
    render(
      <RefInspector
        {...handlers}
        target={{ ...target, otherUses: [9, 12] }}
        dependency={dep()}
        shelf={[skill()]}
        onReplace={onReplace}
      />,
    );
    expect(screen.getByText(/Changes apply only to this one/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Link another skill" }));
    expect(onReplace).toHaveBeenLastCalledWith(false);
    await userEvent.click(screen.getByRole("button", { name: "Replace all 3" }));
    expect(onReplace).toHaveBeenLastCalledWith(true);
  });

  it("Escape closes it", () => {
    const onClose = vi.fn();
    render(
      <RefInspector {...handlers} target={target} dependency={dep()} shelf={[skill()]} onClose={onClose} />,
    );
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("has no accessibility violations", async () => {
    const { container } = render(
      <RefInspector {...handlers} target={target} dependency={dep()} shelf={[skill()]} />,
    );
    const result = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(result.violations.map((v) => v.id)).toEqual([]);
  });
});

describe("the loom", () => {
  const SOURCE =
    "Intro uses the `a-b` skill.\n\n## One\n\nUse the `c-d` skill.\n\n## Two\n\nUse the `a-b` skill.\n\nNamed: the `e-f` skill.\n";
  const composed = () => {
    const { doc } = parseBody(SOURCE);
    const tr = new Transform(doc);
    for (const o of occurrencesIn(doc))
      if (o.name !== "e-f") tr.setNodeAttribute(o.pos, "role", "when-relevant");
    return tr.doc;
  };
  const props = {
    titleOf: (n: string) => n.toUpperCase(),
    onGo: vi.fn(),
    onUse: vi.fn(),
    onTie: vi.fn(),
    onMoveUse: vi.fn(),
    onMoveSection: vi.fn(),
    onAddBack: vi.fn(),
    onForget: vi.fn(),
    onClose: vi.fn(),
  };

  it("reads sections and deliberate uses from the document alone", () => {
    const data = overviewOf(composed());
    expect(data.rows.map((r) => r.title)).toEqual(["Opening", "One", "Two"]);
    expect(data.names).toEqual(["a-b", "c-d"]);
    expect(data.uses.map((u) => [u.name, u.row])).toEqual([
      ["a-b", 0],
      ["c-d", 1],
      ["a-b", 2],
    ]);
  });

  it("is a real table, so it can be walked cell by cell", () => {
    render(<Overview {...props} overview={overviewOf(composed())} composition={composition()} />);
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getAllByRole("rowheader").map((r) => r.textContent)).toEqual(["Opening", "One", "Two"]);
    expect(screen.getAllByRole("columnheader")).toHaveLength(2);
  });

  it("tying a knot at an empty crossing adds that skill to that section", async () => {
    const onTie = vi.fn();
    render(
      <Overview {...props} overview={overviewOf(composed())} composition={composition()} onTie={onTie} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Use C-D in Two" }));
    expect(onTie).toHaveBeenCalledWith("c-d", 2);
  });

  it("a knot opens from the keyboard, and sections move with Alt+arrows", () => {
    const onUse = vi.fn();
    const onMoveSection = vi.fn();
    render(
      <Overview
        {...props}
        overview={overviewOf(composed())}
        composition={composition()}
        onUse={onUse}
        onMoveSection={onMoveSection}
      />,
    );
    fireEvent.keyDown(screen.getByRole("button", { name: /C-D in One/ }), { key: "Enter" });
    expect(onUse).toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("button", { name: "Two" }), { key: "ArrowUp", altKey: true });
    expect(onMoveSection).toHaveBeenCalledWith(2, 1);
  });

  it("says it isn't a route an agent will follow", () => {
    render(<Overview {...props} overview={overviewOf(composed())} composition={composition()} />);
    expect(screen.getByText(/isn't a route it will follow/)).toBeInTheDocument();
  });

  it("says in words what's missing, circular, or only mentioned", () => {
    render(
      <Overview
        {...props}
        overview={overviewOf(composed())}
        composition={composition({
          dependencies: [dep({ name: "c-d", status: "missing" })],
          cycles: [["a-b", "c-d", "a-b"]],
          mentioned: [{ name: "e-f", plugin: undefined, lines: [9] } as never],
        })}
      />,
    );
    expect(screen.getByText(/C-D isn't on this machine/)).toBeInTheDocument();
    expect(screen.getByText(/A-B → C-D → A-B/)).toBeInTheDocument();
    expect(screen.getByText("Mentioned, not linked")).toBeInTheDocument();
    expect(screen.getByText("E-F")).toBeInTheDocument();
  });

  it("makes the author decide about what the words no longer mention", async () => {
    const onForget = vi.fn();
    render(
      <Overview
        {...props}
        overview={overviewOf(composed())}
        composition={composition({ unmentioned: ["gone"] })}
        onForget={onForget}
      />,
    );
    expect(screen.getByText(/can't be installed or shared until you decide/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Forget it" }));
    expect(onForget).toHaveBeenCalledWith("gone");
  });

  it("has no accessibility violations", async () => {
    const { container } = render(
      <Overview {...props} overview={overviewOf(composed())} composition={composition()} />,
    );
    const result = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(result.violations.map((v) => v.id)).toEqual([]);
  });
});

describe("what's inside", () => {
  const props = {
    titleOf: (n: string) => n,
    liveInstructionsTokens: 120,
    ready: true,
    problems: 0,
    onOpenFile: vi.fn(),
    onWhen: vi.fn(),
    onReadiness: vi.fn(),
    onSource: vi.fn(),
    onOverview: vi.fn(),
    onClose: vi.fn(),
  };

  it("shows stages in order, as estimates", () => {
    render(<Inside {...props} composition={composition()} />);
    const stages = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(stages.slice(0, 4)).toEqual([
      "Always in view",
      "Once it's chosen",
      "Read if needed",
      "Scripts and tools",
    ]);
    expect(screen.getByText("about 120 tokens")).toBeInTheDocument();
    expect(screen.getByText(/Token counts are rough/)).toBeInTheDocument();
  });

  it("says plainly that Habi never runs scripts, and doesn't say an agent won't", () => {
    render(<Inside {...props} composition={composition()} />);
    expect(
      screen.getByText(
        /may inspect or run, depending on the instructions and its permissions. Habi never runs them/,
      ),
    ).toBeInTheDocument();
  });

  it("never adds other skills to the total", () => {
    render(
      <Inside
        {...props}
        composition={composition({
          dependencies: [
            dep({ name: "a" }),
            dep({ name: "b", optional: true }),
            dep({ name: "c", status: "missing" }),
          ],
        })}
      />,
    );
    expect(screen.getByText(/aren't added up here/)).toBeInTheDocument();
    expect(screen.getByText("optional")).toBeInTheDocument();
    expect(screen.getByText("not found here")).toBeInTheDocument();
  });

  it("flags long instructions without nagging about short ones", () => {
    const { rerender } = render(<Inside {...props} composition={composition()} />);
    expect(screen.queryByText(/a lot to hold at once/)).toBeNull();
    rerender(<Inside {...props} liveInstructionsTokens={9000} composition={composition()} />);
    expect(screen.getByText(/a lot to hold at once/)).toBeInTheDocument();
  });

  it("names the skills that depend on this one", () => {
    render(
      <Inside
        {...props}
        composition={composition({ incoming: [{ skillId: "x", title: "Release checks", explicit: true }] })}
      />,
    );
    expect(screen.getByText("Release checks")).toBeInTheDocument();
    expect(screen.getByText(/won't change them for you/)).toBeInTheDocument();
  });
});

const form = {
  title: "T",
  owner: "",
  repositoryScope: false,
  conditionsEditable: true,
  matchMode: "all",
  appliesTags: [] as string[],
  appliesDependencies: [] as string[],
  appliesFiles: [] as string[],
  excludeTags: [],
  excludeDependencies: [],
  tools: [],
  examples: [],
};
function Harness({ initial = form, onMore = () => {} }: { initial?: typeof form; onMore?: () => void }) {
  const [current, setForm] = useState(initial);
  const draft = {
    form: current,
    setForm,
    trashed: false,
    document: { name: "n", description: "d", body: "Plain words." },
    skill: { metadataStatus: "undeclared" },
  } as unknown as SkillDraft;
  return <WhenTokens draft={draft} onMore={onMore} />;
}

describe("what a skill is for", () => {
  it("is tokens, with no sentence and no fields to fill in", () => {
    render(<Harness />);
    expect(screen.getByRole("button", { name: "Suggest for…" })).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByText(/Habi/)).toBeNull();
  });

  it("type, choose, and it's a token", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "Suggest for…" }));
    const input = screen.getByRole("combobox");
    expect(input).toHaveFocus();
    await userEvent.type(input, "playwright{Enter}");
    expect(screen.getByRole("button", { name: "Remove Playwright" })).toBeInTheDocument();
    expect(screen.queryByText(/is used/)).toBeNull();
  });

  it("Backspace on an empty line takes out the last one, as in any text", async () => {
    render(<Harness initial={{ ...form, appliesTags: ["test:playwright"] }} />);
    await userEvent.click(screen.getByRole("button", { name: "Add another" }));
    await userEvent.keyboard("{Backspace}");
    expect(screen.queryByText("Playwright")).toBeNull();
  });

  it("a token's × takes it out", async () => {
    render(<Harness initial={{ ...form, appliesTags: ["test:playwright"] }} />);
    await userEvent.click(screen.getByRole("button", { name: "Remove Playwright" }));
    expect(screen.getByRole("button", { name: "Suggest for…" })).toBeInTheDocument();
  });

  it("the word between tokens changes what they mean when pressed", async () => {
    render(<Harness initial={{ ...form, appliesDependencies: ["a", "b"] }} />);
    await userEvent.click(screen.getByRole("button", { name: "and" }));
    expect(screen.getByRole("button", { name: "or" })).toBeInTheDocument();
  });

  it("keeps the rarer rules one step away, not on the page", async () => {
    const onMore = vi.fn();
    render(<Harness onMore={onMore} />);
    expect(screen.queryByText("Exceptions and other rules")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Suggest for…" }));
    await userEvent.click(screen.getByRole("button", { name: "Exceptions and other rules" }));
    expect(onMore).toHaveBeenCalled();
  });

  it("Escape leaves it as it was", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "Suggest for…" }));
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "Suggest for…" })).toBeInTheDocument();
  });

  it("hand-written rules aren't these tokens' to change", () => {
    render(<Harness initial={{ ...form, conditionsEditable: false }} />);
    expect(screen.getByRole("button", { name: "Custom rules" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add another" })).toBeNull();
  });
});
