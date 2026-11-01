import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Composition } from "../bindings/Composition";
import type { Dependency } from "../bindings/Dependency";
import type { ShelfSkill } from "../bindings/ShelfSkill";
import { Inside } from "../views/skills/studio/compose/Inside";
import { type InspectorTarget, RefInspector } from "../views/skills/studio/compose/RefInspector";
import { Shelf } from "../views/skills/studio/compose/Shelf";
import { WhenSummary } from "../views/skills/studio/compose/WhenSummary";
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
    expect(screen.getByText(/nothing is installed or run/i)).toBeInTheDocument();
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

  it("allows inspecting a read-only reference without exposing edits", () => {
    render(<RefInspector {...handlers} target={target} dependency={dep()} shelf={[skill()]} readOnly />);
    expect(
      screen
        .getAllByRole("radio")
        .every((radio) => (radio as HTMLInputElement).disabled || radio.closest("fieldset")?.disabled),
    ).toBe(true);
    expect(screen.getByRole("button", { name: "Remove from here" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Link another skill" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Look at it" })).toBeEnabled();
  });

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
  return <WhenSummary draft={draft} onOpen={onMore} />;
}

describe("what a skill is for", () => {
  it("opens the sidebar directly without an intermediate input", async () => {
    const onMore = vi.fn();
    render(<Harness onMore={onMore} />);
    await userEvent.click(screen.getByRole("button", { name: "Set conditions" }));
    expect(onMore).toHaveBeenCalledOnce();
    expect(screen.queryByRole("combobox")).toBeNull();
  });
  it("summarizes matching logic and opens the same sidebar to edit", async () => {
    const onMore = vi.fn();
    render(<Harness initial={{ ...form, appliesDependencies: ["a", "b"] }} onMore={onMore} />);
    expect(screen.getByText("it depends on a and it depends on b")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Edit when to use" }));
    expect(onMore).toHaveBeenCalledOnce();
  });
  it("keeps custom rules inspectable", () => {
    render(<Harness initial={{ ...form, conditionsEditable: false }} />);
    expect(screen.getByText("Custom rules")).toBeInTheDocument();
  });
});
