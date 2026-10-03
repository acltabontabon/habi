import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalSkill } from "../bindings/LocalSkill";
import type { SkillStanding } from "../bindings/SkillStanding";
import { ToastProvider } from "../components/Toasts";
import { type Actions, ActionsContext } from "../lib/actions";
import { NavProvider, type Route, useNav } from "../lib/nav";
import { useSkills, useSkillsOverview } from "../lib/queries";
import { AddSkillsDialog } from "../views/skills/AddSkillsDialog";
import { SkillsView } from "../views/skills/SkillsView";
import { SkillStudio } from "../views/skills/studio/SkillStudio";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

type Handler = (args: Record<string, unknown>) => unknown;
let handlers: Record<string, Handler> = {};

beforeEach(() => {
  handlers = {};
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string, args: Record<string, unknown> = {}) => {
    const handler = handlers[cmd];
    if (handler) return handler(args);
    if (["recent_projects", "list_skills", "list_sources", "skills_overview"].includes(cmd)) return [];
    if (cmd === "skill_templates") return templates;
    if (cmd === "skill_upstream") return null;
    if (cmd === "cancel_job") return null;
    throw { code: "notFound", message: `no mock for ${cmd}` };
  });
});

const templates = [
  { template: "blank", label: "Blank", summary: "Start from an empty page.", body: "" },
  {
    template: "workflow",
    label: "Workflow",
    summary: "A procedure the agent follows step by step.",
    body: "## Steps\n\n1. Read the code first.\n",
  },
];

const actions: Actions = {
  openProject: vi.fn(async () => {}),
  newSkill: vi.fn(),
  addSkills: vi.fn(),
  showWelcome: vi.fn(),
};

function wrap(ui: ReactNode, initial: Route = { name: "skills", skillId: "k" }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <NavProvider initial={initial}>
          <ActionsContext.Provider value={actions}>{ui}</ActionsContext.Provider>
        </NavProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

function skill(over: Partial<LocalSkill["document"]> = {}): LocalSkill {
  return {
    summary: {
      id: "k",
      name: over.name ?? "review",
      title: "Review",
      description: "Reviews changes before merge.",
      origin: { type: "created" },
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-10-01T00:00:00Z",
      deletedAt: null,
      errors: 0,
      warnings: 0,
      hasApplicability: false,
      fileCount: 1,
      contentDigest: "d",
      modifiedLocally: null,
    },
    document: { name: "review", description: "Reviews changes before merge.", body: "", ...over },
    documentDigest: "doc",
    documentError: null,
    form: {
      title: "Review",
      owner: "",
      repositoryScope: false,
      conditionsEditable: true,
      matchMode: "all",
      appliesTags: [],
      appliesDependencies: [],
      appliesFiles: [],
      excludeTags: [],
      excludeDependencies: [],
      tools: [],
      examples: [],
    },
    metadataText: null,
    metadataDigest: null,
    metadataStatus: "undeclared",
    appliesWhen: null,
    excludes: null,
    scope: "module",
    files: [
      { path: "SKILL.md", size: 10, digest: "d", executable: false, text: true },
      { path: "scripts/check.py", size: 10, digest: "e", executable: true, text: true },
    ],
    diagnostics: [],
    location: "~/habi/skills/k/package",
  };
}

const billing = {
  id: "p1",
  name: "billing",
  path: "~/work/billing",
  exists: true,
  lastOpenedAt: "2026-10-02T00:00:00Z",
  exclusions: [],
  sample: false,
  summary: null,
};

const formOf = (calls: unknown[][]) =>
  (calls[calls.length - 1]?.[0] as { form: Record<string, unknown> } | undefined)?.form;

describe("the Skill Studio", () => {
  it("lands inside the knowledge, with one action and nothing to fill in first", async () => {
    handlers.get_skill = () => skill();
    const { container } = wrap(<SkillStudio id="k" />);
    expect(await screen.findByLabelText("Skill title")).toHaveValue("Review");
    expect(screen.getByLabelText("What it is for")).toHaveValue("Reviews changes before merge.");
    // One coherent state, one primary action; the rest behind a menu.
    expect(screen.getByRole("button", { name: /^Ready/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Move to trash" })).not.toBeInTheDocument();
    // No tabs: the other layers are named, in a line each, at the head of the skill.
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /When to use\s*When you choose it/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Comes with\s*1 script/ })).toBeInTheDocument();
    // The package format stays out of sight.
    expect(screen.queryByText("habi.yaml")).not.toBeInTheDocument();
    expect(screen.queryByText("SKILL.md")).not.toBeInTheDocument();
    expect(await screen.findByText("Or begin from")).toBeInTheDocument();
    const results = await axe.run(container);
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  });

  it("starts from a shape only when asked, and saves it as the instructions", async () => {
    handlers.get_skill = () => skill();
    const saved = vi.fn((args: Record<string, unknown>) => ({
      ...skill({ body: (args.document as { body: string }).body }),
      documentDigest: "doc2",
    }));
    handlers.save_skill_document = saved;
    wrap(<SkillStudio id="k" />);
    await userEvent.click(await screen.findByRole("button", { name: "Workflow" }));
    await waitFor(() => expect(saved).toHaveBeenCalled(), { timeout: 2000 });
    expect((saved.mock.calls[0]?.[0].document as { body: string } | undefined)?.body).toBe(
      templates[1]?.body,
    );
  });

  it("names a fresh draft from what is written, and offers the rest without asking", async () => {
    const body =
      "# Liquibase Changeset Review\n\nBefore approving a Liquibase changeset, check that every change can be rolled back.\n\n1. Read the Liquibase changelog.\n";
    handlers.get_skill = () => ({
      ...skill({ name: "", description: "", body }),
      summary: { ...skill().summary, title: "", description: "" },
    });
    const saved = vi.fn((args: Record<string, unknown>) => ({
      ...skill(args.document as Partial<LocalSkill["document"]>),
      documentDigest: "doc2",
    }));
    handlers.save_skill_document = saved;
    const rules = vi.fn(() => ({ ...skill(), metadataDigest: "m2" }));
    handlers.save_skill_applicability = rules;
    wrap(<SkillStudio id="k" />);
    // The first heading is its title, and the title its identifier.
    expect(await screen.findByLabelText("Skill title")).toHaveValue("Liquibase Changeset Review");
    // What would make it better waits under Ready, each with its action.
    await userEvent.click(screen.getByRole("button", { name: /^Ready/ }));
    await userEvent.click(
      within(screen.getByRole("dialog", { name: "Ready to use" })).getByRole("button", {
        name: "Use the opening line",
      }),
    );
    expect(screen.getByLabelText("What it is for")).toHaveValue(
      "Before approving a Liquibase changeset, check that every change can be rolled back.",
    );
    await waitFor(() => expect(saved).toHaveBeenCalled(), { timeout: 2000 });
    const last = saved.mock.calls[saved.mock.calls.length - 1]?.[0] as {
      title: string;
      document: { name: string };
    };
    expect(last.title).toBe("Liquibase Changeset Review");
    expect(last.document.name).toBe("liquibase-changeset-review");
    // The instructions keep naming Liquibase: one click makes it a signal, said in words.
    await userEvent.click(screen.getByRole("button", { name: /^Ready/ }));
    const better = screen.getByRole("dialog", { name: "Ready to use" });
    expect(within(better).getByText(/The instructions are brief/)).toBeInTheDocument();
    expect(within(better).getByText("Looks related to Liquibase projects.")).toBeInTheDocument();
    await userEvent.click(within(better).getByRole("button", { name: "Suggest it there" }));
    await waitFor(() => expect(formOf(rules.mock.calls)).toMatchObject({ appliesTags: ["db:liquibase"] }), {
      timeout: 2000,
    });
  });

  it("moves between layers with ⌘1–3 and keeps the instructions mounted", async () => {
    handlers.get_skill = () => skill({ body: "## Steps\n\nDo it.\n" });
    wrap(<SkillStudio id="k" />);
    await screen.findByLabelText("Skill title");
    const instructions = screen.getByRole("region", { name: "The skill" });
    fireEvent.keyDown(window, { key: "2", metaKey: true });
    expect(screen.getByRole("heading", { name: "When to use" })).toBeInTheDocument();
    // Hidden, not gone: undo history and pending saves survive.
    expect(instructions.hidden).toBe(true);
    fireEvent.keyDown(window, { key: "3", metaKey: true });
    expect(screen.getByRole("heading", { name: "Materials" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "1", metaKey: true });
    expect(screen.getByRole("region", { name: "The skill" })).toBe(instructions);
    expect(instructions.hidden).toBe(false);
  });

  it("changes the identifier deliberately, from readiness, and warns where it is installed", async () => {
    handlers.get_skill = () => skill();
    const standing: SkillStanding[] = [
      {
        skillId: "k",
        installedIn: [{ projectId: "p1", projectName: "billing", clients: ["claude-code"], current: true }],
        upstream: null,
      },
    ];
    handlers.skills_overview = () => standing;
    const saved = vi.fn((args: Record<string, unknown>) => ({
      ...skill({ name: (args.document as { name: string }).name }),
      documentDigest: "doc2",
    }));
    handlers.save_skill_document = saved;
    wrap(<SkillStudio id="k" />);
    await userEvent.click(await screen.findByRole("button", { name: /^Ready/ }));
    const ready = screen.getByRole("dialog", { name: "Ready to use" });
    expect(within(ready).getByText("review")).toBeInTheDocument();
    await userEvent.click(within(ready).getByRole("button", { name: "Change" }));
    const field = within(ready).getByLabelText("name");
    await userEvent.clear(field);
    await userEvent.type(field, "Bad Name");
    expect(within(ready).getByText("Use lowercase letters, digits and hyphens only.")).toBeInTheDocument();
    expect(within(ready).getByRole("button", { name: "Apply" })).toBeDisabled();
    await userEvent.clear(field);
    await userEvent.type(field, "merge-review");
    expect(await within(ready).findByText(/Installed in billing as/)).toBeInTheDocument();
    // Typing alone saves nothing.
    expect(saved).not.toHaveBeenCalled();
    await userEvent.click(within(ready).getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(saved).toHaveBeenCalled(), { timeout: 2000 });
    expect((saved.mock.calls[0]?.[0].document as { name: string } | undefined)?.name).toBe("merge-review");
  });

  it("says in one place what is unfinished, and takes the author to the fix", async () => {
    handlers.get_skill = () => ({
      ...skill({ description: "" }),
      summary: { ...skill().summary, errors: 1 },
      diagnostics: [
        {
          level: "error",
          message: "SKILL.md has no `description`",
          path: "SKILL.md",
          code: "missingDescription",
        },
      ],
    });
    wrap(<SkillStudio id="k" />);
    await userEvent.click(await screen.findByRole("button", { name: /Draft\s*· 1 thing to finish/ }));
    const left = screen.getByRole("dialog", { name: "What is left to do" });
    expect(within(left).getByText(/Agents decide whether to load a skill/)).toBeInTheDocument();
    await userEvent.click(within(left).getByRole("button", { name: "Edit the purpose" }));
    await waitFor(() => expect(screen.getByLabelText("What it is for")).toHaveFocus());
  });

  it("offers Use only when the skill is ready, and the next step until then", async () => {
    handlers.get_skill = () => ({
      ...skill({ description: "" }),
      summary: { ...skill().summary, errors: 1 },
      diagnostics: [
        {
          level: "error",
          message: "SKILL.md has no `description`",
          path: "SKILL.md",
          code: "missingDescription",
        },
      ],
    });
    wrap(<SkillStudio id="k" />);
    await screen.findByLabelText("Skill title");
    expect(screen.queryByRole("button", { name: "Use" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Add a purpose" }));
    await waitFor(() => expect(screen.getByLabelText("What it is for")).toHaveFocus());
  });

  it("asks a nameless draft for a title, not an identifier", async () => {
    handlers.get_skill = () => ({
      ...skill({ name: "", body: "Steps." }),
      summary: { ...skill().summary, title: "", errors: 1 },
      diagnostics: [
        { level: "error", message: "SKILL.md has no `name`", path: "SKILL.md", code: "invalidName" },
      ],
    });
    wrap(<SkillStudio id="k" />);
    await userEvent.click(await screen.findByRole("button", { name: "Give it a title" }));
    await waitFor(() => expect(screen.getByLabelText("Skill title")).toHaveFocus());
  });

  it("points at what a starter left unfilled, and takes the author there", async () => {
    handlers.get_skill = () =>
      skill({
        description: "haha",
        body: "## When to use this\n\nUse this when …\n\n## Steps\n\n1. Read it.\n2. \n",
      });
    wrap(<SkillStudio id="k" />);
    await userEvent.click(await screen.findByRole("button", { name: /^Ready/ }));
    const better = screen.getByRole("dialog", { name: "Ready to use" });
    expect(within(better).getByText("2 places still read like the starter.")).toBeInTheDocument();
    expect(within(better).getByRole("button", { name: "Show me" })).toBeInTheDocument();
    expect(
      within(better).getByText("“haha” is all an agent reads before choosing this skill."),
    ).toBeInTheDocument();
    await userEvent.click(within(better).getByRole("button", { name: "Say what it helps with" }));
    await waitFor(() => expect(screen.getByLabelText("What it is for")).toHaveFocus());
  });

  it("puts passing it on beside Use, said for where it came from", async () => {
    handlers.get_skill = () => ({
      ...skill(),
      summary: {
        ...skill().summary,
        origin: {
          type: "library",
          sourceName: "Team",
          sourceIdentity: "x",
          itemId: "a",
          snapshot: "s",
          upstream: null,
        },
        modifiedLocally: true,
      },
    });
    wrap(<SkillStudio id="k" />);
    expect(await screen.findByRole("button", { name: "Contribute" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use" })).toBeInTheDocument();
    // Not twice: the menu keeps only what the bar does not show.
    await userEvent.click(screen.getByRole("button", { name: "More for this skill" }));
    expect(screen.queryByRole("menuitem", { name: /Contribute to Team/ })).not.toBeInTheDocument();
  });

  it("is silent about saving until something goes wrong", async () => {
    handlers.get_skill = () => skill();
    handlers.save_skill_document = () => {
      throw { code: "io", message: "disk full" };
    };
    const { container } = wrap(<SkillStudio id="k" />);
    await screen.findByLabelText("Skill title");
    expect(container.querySelector(".save-ambient")?.textContent).not.toMatch(/Saved/);
    await userEvent.type(screen.getByLabelText("Skill title"), "!");
    expect(await screen.findByText("Couldn’t save", {}, { timeout: 2000 })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("writes pending edits before leaving the screen", async () => {
    handlers.get_skill = () => skill();
    const saved = vi.fn(() => ({ ...skill(), documentDigest: "doc2" }));
    handlers.save_skill_document = saved;
    handlers.save_skill_applicability = () => ({ ...skill(), metadataDigest: "m2" });
    function Leave() {
      const { navigate, route } = useNav();
      return (
        <>
          <p>on {route.name}</p>
          <button type="button" onClick={() => navigate({ name: "settings" })}>
            Go to settings
          </button>
        </>
      );
    }
    wrap(
      <>
        <Leave />
        <SkillStudio id="k" />
      </>,
    );
    await userEvent.type(await screen.findByLabelText("Skill title"), " checklist");
    await userEvent.click(screen.getByRole("button", { name: "Go to settings" }));
    await waitFor(() => expect(screen.getByText("on settings")).toBeInTheDocument());
    expect(saved).toHaveBeenCalled();
  });

  it("shows where a copy came from, what changed here, and where it can go next", async () => {
    handlers.get_skill = () => ({
      ...skill(),
      summary: {
        ...skill().summary,
        origin: { type: "folder", path: "~/work/shared-skills/review" },
        modifiedLocally: true,
      },
    });
    handlers.skill_local_changes = () => ({
      skillId: "k",
      known: true,
      detail: null,
      unchanged: 1,
      files: [
        {
          path: "SKILL.md",
          change: "modified",
          note: null,
          diff: { hunks: [], added: 2, removed: 1, binary: false, truncated: false },
        },
      ],
    });
    wrap(<SkillStudio id="k" />);
    await userEvent.click(await screen.findByRole("button", { name: /From review, changed here/ }));
    const sheet = screen.getByRole("complementary", { name: "Where it came from" });
    expect(within(sheet).getByText("From review")).toBeInTheDocument();
    // Changes are said as parts of the skill, not as files.
    expect(await within(sheet).findByText("Instructions")).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: /Share to a library/ })).toBeInTheDocument();
  });

  it("turns a few words into signals, said as facts about a project", async () => {
    handlers.get_skill = () => skill({ body: "Steps." });
    const rules = vi.fn(() => ({ ...skill(), metadataDigest: "m2" }));
    handlers.save_skill_applicability = rules;
    wrap(<SkillStudio id="k" />);
    await screen.findByLabelText("Skill title");
    fireEvent.keyDown(window, { key: "2", metaKey: true });
    const when = screen.getByRole("region", { name: "Suggest when" });
    // Empty, a section is just its action.
    expect(within(when).queryByText(/Nothing yet/)).not.toBeInTheDocument();
    await userEvent.click(within(when).getByRole("button", { name: "Add signal" }));
    const ask = within(when).getByLabelText("What to look for");
    await userEvent.type(ask, "Spring Boot{Enter}");
    expect(within(when).getByText("Spring Boot is used")).toBeInTheDocument();
    await userEvent.type(ask, "org.liquibase:liquibase-core{Enter}");
    expect(within(when).getByText("org.liquibase:liquibase-core")).toBeInTheDocument();
    // Vague words propose nothing, and nothing is guessed.
    await userEvent.type(ask, "something vague{Enter}");
    expect(within(when).queryByRole("option")).not.toBeInTheDocument();
    // With two signals, how they combine is a choice of words.
    await userEvent.click(within(when).getByRole("button", { name: "any of these" }));
    await waitFor(() => expect(rules).toHaveBeenCalled(), { timeout: 2000 });
    await waitFor(() =>
      expect(formOf(rules.mock.calls)).toMatchObject({
        appliesTags: ["framework:spring-boot"],
        appliesDependencies: ["org.liquibase:liquibase-core"],
        matchMode: "any",
      }),
    );
    await userEvent.click(within(when).getByRole("button", { name: "Remove: Spring Boot is used" }));
    await waitFor(() => expect(formOf(rules.mock.calls)).toMatchObject({ appliesTags: [] }), {
      timeout: 2000,
    });
  });

  it("says tools apart from signals, looked up and never run", async () => {
    handlers.get_skill = () => skill({ body: "Steps." });
    const rules = vi.fn(() => ({ ...skill(), metadataDigest: "m2" }));
    handlers.save_skill_applicability = rules;
    wrap(<SkillStudio id="k" />);
    await screen.findByLabelText("Skill title");
    fireEvent.keyDown(window, { key: "2", metaKey: true });
    const needs = screen.getByRole("region", { name: "Needs" });
    await userEvent.click(within(needs).getByRole("button", { name: "Add tool" }));
    expect(within(needs).getByText(/Looked up on PATH, never run/)).toBeInTheDocument();
    await userEvent.type(within(needs).getByLabelText("Tool name"), "Maven");
    await userEvent.type(
      within(needs).getByLabelText("Commands, any one of which satisfies the requirement"),
      "./mvnw, mvn{Enter}",
    );
    expect(within(needs).getByText("./mvnw or mvn")).toBeInTheDocument();
    await waitFor(
      () =>
        expect(formOf(rules.mock.calls)).toMatchObject({
          tools: [{ name: "Maven", commands: ["./mvnw", "mvn"] }],
        }),
      { timeout: 2000 },
    );
  });

  it("keeps rules the sentences cannot edit as written, and reads them out", async () => {
    const save = vi.fn();
    handlers.get_skill = () => ({
      ...skill({ body: "Steps." }),
      summary: { ...skill().summary, hasApplicability: true },
      form: { ...skill().form, conditionsEditable: false },
      metadataText:
        "habi: 1\napplies_when:\n  all:\n    - any: [{tag: lang:java}, {file: '**/pom.xml'}]\n    - not: {tag: build:gradle}\n",
      metadataDigest: "m",
      metadataStatus: "declared",
      appliesWhen: {
        op: "all",
        items: [
          {
            op: "any",
            items: [
              { op: "tag", tag: "lang:java" },
              { op: "file", glob: "**/pom.xml" },
            ],
          },
          { op: "not", item: { op: "tag", tag: "build:gradle" } },
        ],
      },
    });
    handlers.save_skill_applicability = save;
    handlers.save_skill_metadata = save;
    wrap(<SkillStudio id="k" />);
    await screen.findByLabelText("Skill title");
    expect(screen.getByRole("button", { name: /When to use\s*Written as YAML/ })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "2", metaKey: true });
    const layer = screen.getByRole("region", { name: "When to use" });
    expect(within(layer).getByText("it contains Java code")).toBeInTheDocument();
    expect(within(layer).getByText("**/pom.xml")).toBeInTheDocument();
    expect(within(layer).getByText("not when")).toBeInTheDocument();
    expect(within(layer).getByText(/kept exactly as written/)).toBeInTheDocument();
    expect(within(layer).getByRole("button", { name: "Edit as YAML" })).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 900));
    expect(save).not.toHaveBeenCalled();
  });

  it("tests against a project only when asked, and says why", async () => {
    handlers.get_skill = () => skill({ body: "Steps." });
    handlers.recent_projects = () => [billing];
    const preview = vi.fn((args: Record<string, unknown>) => ({
      appliesWhen: { op: "tag", tag: "lang:java" },
      excludes: null,
      scope: "module",
      problem: null,
      projects: [
        {
          project: billing,
          result: {
            applicability: "applies",
            scope: "module",
            modules: [],
            reason: "Contains Java code (Billing.java)",
            specificity: 1,
          },
          error: null,
          inspectedAt: "2026-10-02T00:00:00Z",
          incomplete: [],
          prerequisites: [
            {
              kind: "tool",
              name: "Maven",
              status: "missing",
              detail: "none of mvn found on PATH or in the project",
              purpose: null,
              hint: "brew install maven",
            },
          ],
        },
      ],
      request: args,
    }));
    handlers.preview_skill = preview;
    wrap(<SkillStudio id="k" />);
    await screen.findByLabelText("Skill title");
    fireEvent.keyDown(window, { key: "2", metaKey: true });
    await new Promise((r) => setTimeout(r, 400));
    // Editing the rules does not run diagnostics, and offers no test station.
    expect(preview).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Test" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "More for this skill" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Test against a project/ }));
    const sheet = await screen.findByRole("complementary", { name: "Test against a project" });
    expect(
      await within(sheet).findByText("Would be suggested here", {}, { timeout: 2000 }),
    ).toBeInTheDocument();
    expect(within(sheet).getByText(/Maven/)).toBeInTheDocument();
    expect(within(sheet).getByText(/Looked up, never run/)).toBeInTheDocument();
    expect(within(sheet).getByText(/from build files and file names only/)).toBeInTheDocument();
    const request = preview.mock.calls[0]?.[0].request as { projectId?: string } | undefined;
    expect(request?.projectId).toBe("p1");
    await userEvent.click(within(sheet).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("complementary", { name: "Test against a project" })).not.toBeInTheDocument();
  });

  it("keeps materials human, files placed by Habi, and the package source one step away", async () => {
    handlers.get_skill = () => skill({ body: "Run `scripts/check.py`." });
    handlers.read_skill_file = (args) => ({
      path: args.path,
      text: "#!/usr/bin/env python3\nprint('ok')\n",
      binary: false,
      size: 30,
      digest: "e",
      preview: null,
    });
    const written: string[] = [];
    handlers.write_skill_file = (args) => {
      written.push(`${args.path}`);
      return {
        ...skill(),
        files: [
          ...skill().files,
          { path: String(args.path), size: 10, digest: "n", executable: false, text: true },
        ],
      };
    };
    handlers.set_skill_file_executable = (args) => ({
      ...skill(),
      files: [
        ...skill().files,
        { path: String(args.path), size: 10, digest: "n", executable: true, text: true },
      ],
    });
    wrap(<SkillStudio id="k" />);
    await screen.findByLabelText("Skill title");
    fireEvent.keyDown(window, { key: "3", metaKey: true });
    const layer = screen.getByRole("region", { name: "Materials" });
    // Kinds, not folders.
    expect(within(layer).getByRole("heading", { name: "script" })).toBeInTheDocument();
    expect(within(layer).queryByText("scripts/")).not.toBeInTheDocument();
    await userEvent.click(within(layer).getByRole("button", { name: /check\.py/ }));
    expect(await within(layer).findByText("python3 scripts/check.py")).toBeInTheDocument();
    expect(within(layer).getByText(/Never run here/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Run/ })).not.toBeInTheDocument();
    // The crumb leads back; the editor chrome goes with the file.
    await userEvent.click(screen.getByRole("button", { name: "Materials" }));
    await userEvent.click(within(layer).getByRole("button", { name: "Add" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /New shell script/ }));
    await userEvent.type(within(layer).getByLabelText("New shell script"), "verify{Enter}");
    await waitFor(() => expect(written).toContain("scripts/verify.sh"));
    // Power users get the literal tree.
    fireEvent.keyDown(window, { key: "3", metaKey: true });
    await userEvent.click(within(layer).getByRole("button", { name: "View package source →" }));
    const source = screen.getByRole("region", { name: "Package source" });
    expect(within(source).getByRole("button", { name: "SKILL.md" })).toBeInTheDocument();
    expect(within(source).getByRole("button", { name: "scripts/" })).toBeInTheDocument();
  });

  it("refuses to add dropped files the window did not receive", async () => {
    // Without the desktop shell there are no drops to take: nothing listens.
    handlers.get_skill = () => skill({ body: "Steps." });
    wrap(<SkillStudio id="k" />);
    await screen.findByLabelText("Skill title");
    fireEvent.keyDown(window, { key: "3", metaKey: true });
    expect(invoke.mock.calls.some((c) => c[0] === "add_dropped_skill_files")).toBe(false);
  });
});

describe("the Skill Studio, saving", () => {
  /** A skill whose rules are kept as written, so YAML is one click away. */
  const asWritten = (): LocalSkill => ({
    ...skill({ name: "code-review", body: "Steps." }),
    summary: { ...skill({ name: "code-review" }).summary, hasApplicability: true },
    form: { ...skill().form, conditionsEditable: false },
    metadataText: "habi: 1\napplies_when:\n  not: {tag: build:gradle}\n",
    metadataDigest: "m",
    metadataStatus: "declared",
    appliesWhen: { op: "not", item: { op: "tag", tag: "build:gradle" } },
  });
  const count = (cmd: string) => invoke.mock.calls.filter((c) => c[0] === cmd).length;

  it("never writes the rules form over YAML being edited in its place", async () => {
    handlers.get_skill = () => asWritten();
    handlers.save_skill_document = () => ({ ...asWritten(), documentDigest: "doc2" });
    const rules = vi.fn(() => ({ ...asWritten(), metadataDigest: "m2" }));
    handlers.save_skill_applicability = rules;
    handlers.save_skill_metadata = rules;
    wrap(<SkillStudio id="k" />);
    await screen.findByLabelText("Skill title");
    fireEvent.keyDown(window, { key: "2", metaKey: true });
    await userEvent.click(screen.getByRole("button", { name: "Edit as YAML" }));
    expect(await screen.findByRole("button", { name: "← Back to sentences" })).toBeInTheDocument();
    // The title is part of the form too; leaving the window and ⌘S write SKILL.md, not the form.
    fireEvent.change(screen.getByLabelText("Skill title"), { target: { value: "Review, renamed" } });
    fireEvent.blur(window);
    fireEvent.keyDown(window, { key: "s", metaKey: true });
    await waitFor(() => expect(count("save_skill_document")).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 900));
    expect(count("save_skill_applicability")).toBe(0);
    expect(count("save_skill_metadata")).toBe(0);
  });

  it("keeps the rules on screen when they could not be saved before switching to YAML", async () => {
    handlers.get_skill = () => asWritten();
    handlers.save_skill_document = () => ({ ...asWritten(), documentDigest: "doc2" });
    handlers.save_skill_applicability = () => {
      throw { code: "conflict", message: "habi.yaml changed" };
    };
    wrap(<SkillStudio id="k" />);
    await screen.findByLabelText("Skill title");
    fireEvent.change(screen.getByLabelText("Skill title"), { target: { value: "Review, renamed" } });
    expect(
      await screen.findByText("This skill's files changed outside Habi", {}, { timeout: 2000 }),
    ).toBeInTheDocument();
    const reads = count("get_skill");
    fireEvent.keyDown(window, { key: "2", metaKey: true });
    await userEvent.click(screen.getByRole("button", { name: "Edit as YAML" }));
    expect(await screen.findByText(/Nothing was done: your latest edits are not saved/)).toBeInTheDocument();
    expect(count("get_skill")).toBe(reads);
    expect(screen.queryByRole("button", { name: "← Back to sentences" })).not.toBeInTheDocument();
  });

  it("shows the file last chosen, never a slower one or another under its name", async () => {
    const two: LocalSkill = {
      ...skill({ body: "Run `scripts/a.py`, then `scripts/b.py`." }),
      files: [
        { path: "SKILL.md", size: 10, digest: "d", executable: false, text: true },
        { path: "scripts/a.py", size: 10, digest: "a", executable: true, text: true },
        { path: "scripts/b.py", size: 10, digest: "b", executable: true, text: true },
      ],
    };
    handlers.get_skill = () => two;
    let hold: { resolve: (v: unknown) => void; reject: (e: unknown) => void } | null = null;
    let gate = false;
    const file = (path: unknown) => ({
      path,
      text: "#!/usr/bin/env python3\nprint('ok')\n",
      binary: false,
      size: 30,
      digest: String(path),
      preview: null,
    });
    handlers.read_skill_file = (args) =>
      gate && args.path === "scripts/b.py"
        ? new Promise((resolve, reject) => {
            hold = { resolve, reject };
          })
        : file(args.path);
    wrap(<SkillStudio id="k" />);
    await screen.findByLabelText("Skill title");
    fireEvent.keyDown(window, { key: "3", metaKey: true });
    const layer = screen.getByRole("region", { name: "Materials" });
    await userEvent.click(within(layer).getByRole("button", { name: /a\.py/ }));
    expect(await within(layer).findByText("python3 scripts/a.py")).toBeInTheDocument();
    const nav = within(layer).getByRole("navigation", { name: "Materials" });

    // A → B → A, with B answering last: A stays.
    gate = true;
    await userEvent.click(within(nav).getByRole("button", { name: "b.py" }));
    expect(within(layer).queryByText("python3 scripts/a.py")).not.toBeInTheDocument();
    await userEvent.click(within(nav).getByRole("button", { name: "a.py" }));
    expect(await within(layer).findByText("python3 scripts/a.py")).toBeInTheDocument();
    (hold as { resolve: (v: unknown) => void } | null)?.resolve(file("scripts/b.py"));
    await new Promise((r) => setTimeout(r, 50));
    expect(within(layer).getByText("python3 scripts/a.py")).toBeInTheDocument();
    expect(within(layer).queryByText("python3 scripts/b.py")).not.toBeInTheDocument();

    // B fails to open: its name is not put on A's editor.
    await userEvent.click(within(nav).getByRole("button", { name: "b.py" }));
    (hold as { reject: (e: unknown) => void } | null)?.reject({ code: "io", message: "unreadable" });
    expect(await within(layer).findByText(/unreadable/)).toBeInTheDocument();
    expect(within(layer).queryByText("python3 scripts/a.py")).not.toBeInTheDocument();
  });

  it("keeps saves cheap: the skill and its row are updated in place, the rest asked again on leaving", async () => {
    const named = skill({ name: "code-review" });
    handlers.get_skill = () => named;
    handlers.list_skills = () => [named.summary];
    handlers.save_skill_document = (args) => ({
      ...named,
      summary: { ...named.summary, title: String(args.title) },
      documentDigest: "doc2",
    });
    handlers.save_skill_applicability = (args) => ({
      ...named,
      summary: { ...named.summary, title: String((args.form as { title: string }).title) },
      metadataDigest: "m2",
    });
    function Around() {
      const { navigate, route } = useNav();
      const skills = useSkills();
      useSkillsOverview();
      return (
        <>
          <p>listed: {skills.data?.map((s) => s.title).join(", ")}</p>
          {route.name === "skills" ? <SkillStudio id="k" /> : <p>on settings</p>}
          <button type="button" onClick={() => navigate({ name: "settings" })}>
            Go to settings
          </button>
        </>
      );
    }
    wrap(<Around />);
    await screen.findByLabelText("Skill title");
    await waitFor(() => expect(count("skills_overview")).toBeGreaterThan(0));
    const overviews = count("skills_overview");
    const lists = count("list_skills");
    await userEvent.type(screen.getByLabelText("Skill title"), " checklist");
    await waitFor(() => expect(screen.getByText("listed: Review checklist")).toBeInTheDocument(), {
      timeout: 2000,
    });
    expect(count("skills_overview")).toBe(overviews);
    expect(count("list_skills")).toBe(lists);
    await userEvent.click(screen.getByRole("button", { name: "Go to settings" }));
    await waitFor(() => expect(count("skills_overview")).toBeGreaterThan(overviews));
  });
});

/** The skills listed: each row's own button, not the actions beside it. */
const rowsOf = (list: HTMLElement) => [...list.querySelectorAll<HTMLButtonElement>(".mys-row")];

describe("My skills", () => {
  const summary = (i: number, over: Partial<LocalSkill["summary"]> = {}): LocalSkill["summary"] => ({
    ...skill().summary,
    id: `s${i}`,
    name: `skill-${i}`,
    title: `Skill ${String(i).padStart(3, "0")}`,
    description: `Does thing ${i}. Use when thing ${i} happens.`,
    updatedAt: new Date(Date.now() - i * 3_600_000).toISOString(),
    ...over,
  });

  it("narrows by what is true about each skill, and says only that", async () => {
    handlers.list_skills = () => [
      summary(1),
      summary(2, {
        origin: {
          type: "library",
          sourceName: "Team",
          sourceIdentity: "x",
          itemId: "a",
          snapshot: "s",
          upstream: null,
        },
        modifiedLocally: true,
      }),
      summary(3, { errors: 2 }),
    ];
    handlers.skills_overview = () => [
      {
        skillId: "s2",
        installedIn: [{ projectId: "p", projectName: "billing", clients: ["claude-code"], current: true }],
        upstream: "changed",
      },
    ];
    const { container } = wrap(<SkillsView />, { name: "skills" });
    const list = await screen.findByRole("list", { name: "Skills" });
    expect(rowsOf(list)).toHaveLength(3);
    // The purpose is the first sentence, not the trigger text.
    expect(within(list).getByText("Does thing 1.")).toBeInTheDocument();
    // Each skill's thread: where it came from, and what happened here.
    expect(await within(list).findByText("· newer version")).toBeInTheDocument();
    expect(within(list).getByText("changed here")).toBeInTheDocument();
    expect(within(list).getByText("in billing")).toBeInTheDocument();
    expect(within(list).getAllByText("Ready")).toHaveLength(2);
    expect(within(list).getByText("Draft · 2 things to finish")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /^Updates/ }));
    expect(rowsOf(list)).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: /^Drafts/ }));
    expect(within(list).getByText("Skill 003")).toBeInTheDocument();
    // Facets nothing matches are not offered.
    expect(screen.queryByRole("button", { name: /^Imported 0/ })).not.toBeInTheDocument();
    const results = await axe.run(container);
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  });

  it("offers Use and the rest on a row, only where they apply", async () => {
    handlers.list_skills = () => [summary(1), summary(2, { errors: 1, description: "" })];
    const trashed = vi.fn(() => null);
    handlers.trash_skill = trashed;
    wrap(<SkillsView />, { name: "skills" });
    const list = await screen.findByRole("list", { name: "Skills" });
    // Ready: Use is there; a draft has none, only its way to finish (opening it).
    expect(within(list).getByRole("button", { name: "Use Skill 001" })).toBeInTheDocument();
    // What you wrote, ready, can be passed on from where it is listed.
    expect(within(list).getByRole("button", { name: "Share Skill 001" })).toBeInTheDocument();
    expect(within(list).queryByRole("button", { name: "Share Skill 002" })).not.toBeInTheDocument();
    expect(within(list).queryByRole("button", { name: "Use Skill 002" })).not.toBeInTheDocument();
    await userEvent.click(within(list).getByRole("button", { name: "More for Skill 002" }));
    expect(screen.queryByRole("menuitem", { name: /Export as zip/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("menuitem", { name: /Move to trash/ }));
    await waitFor(() => expect(trashed).toHaveBeenCalled());
    expect(await screen.findByRole("button", { name: "Undo" })).toBeInTheDocument();
  });

  it("finds with / and moves with the keyboard", async () => {
    handlers.list_skills = () => [summary(1), summary(2), summary(3)];
    wrap(<SkillsView />, { name: "skills" });
    await screen.findByRole("list", { name: "Skills" });
    fireEvent.keyDown(window, { key: "/" });
    const search = screen.getByLabelText("Find a skill");
    expect(search).toHaveFocus();
    await userEvent.type(search, "002");
    const list = screen.getByRole("list", { name: "Skills" });
    expect(rowsOf(list)).toHaveLength(1);
    await userEvent.clear(search);
    await userEvent.keyboard("{ArrowDown}");
    const rows = rowsOf(list);
    expect(rows[0]).toHaveFocus();
    await userEvent.keyboard("j");
    expect(rows[1]).toHaveFocus();
    await userEvent.keyboard("k");
    expect(rows[0]).toHaveFocus();
  });

  it("stays quick with three hundred skills", async () => {
    handlers.list_skills = () => Array.from({ length: 300 }, (_, i) => summary(i + 1));
    const started = performance.now();
    wrap(<SkillsView />, { name: "skills" });
    const list = await screen.findByRole("list", { name: "Skills" });
    expect(rowsOf(list)).toHaveLength(300);
    expect(performance.now() - started).toBeLessThan(3000);
    await userEvent.click(screen.getByRole("button", { name: "A–Z" }));
    expect(within(list).getByText("S")).toBeInTheDocument();
  });
});

describe("Add skills", () => {
  it("makes a one-off copy from Git without connecting it, and forgets the repository after", async () => {
    const forgotten = vi.fn(() => null);
    handlers.open_git_copy = () => ({ sourceId: "c1", label: "acme/skills", snapshot: "abc" });
    handlers.forget_git_copy = forgotten;
    handlers.inspect_import = (args) => {
      expect(args.from).toEqual({ type: "gitCopy", sourceId: "c1" });
      return {
        origin: "acme/skills",
        notes: [],
        candidates: [
          {
            path: "review",
            name: "review",
            title: "Review",
            description: "Reviews changes.",
            license: "MIT",
            hasMetadata: false,
            files: ["SKILL.md"],
            size: 10,
            problems: [],
            complete: true,
            digest: "d",
            duplicate: null,
            suggestedName: null,
          },
        ],
      };
    };
    const onClose = vi.fn();
    const view = wrap(<AddSkillsDialog start={{ source: "choose" }} onClose={onClose} />, { name: "skills" });
    const dialog = await screen.findByRole("dialog", { name: "Add skills" });
    // Two different things, said apart, before anything is fetched.
    expect(within(dialog).getByRole("button", { name: /Make my own copy/ })).toBeDisabled();
    await userEvent.type(
      within(dialog).getByLabelText("Repository address"),
      "https://github.com/acme/skills",
    );
    expect(within(dialog).getByText(/Nothing stays connected/)).toBeInTheDocument();
    expect(
      within(dialog).getByText("Keep it to browse and update from. Nothing is copied."),
    ).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: /Make my own copy/ }));
    expect(await screen.findByRole("dialog", { name: "Copy from acme/skills" })).toBeInTheDocument();
    expect(screen.getByText(/connect it later to follow its updates/)).toBeInTheDocument();
    view.unmount();
    await waitFor(() => expect(forgotten).toHaveBeenCalled());
  });

  it("connects a repository as a library from the same address", async () => {
    wrap(<AddSkillsDialog start={{ source: "choose" }} onClose={() => {}} />, { name: "skills" });
    const dialog = await screen.findByRole("dialog", { name: "Add skills" });
    await userEvent.type(
      within(dialog).getByLabelText("Repository address"),
      "https://github.com/acme/skills",
    );
    await userEvent.click(within(dialog).getByRole("button", { name: /Connect as a library/ }));
    expect(await screen.findByDisplayValue("https://github.com/acme/skills")).toBeInTheDocument();
    expect(invoke.mock.calls.some((c) => c[0] === "open_git_copy")).toBe(false);
  });
});
