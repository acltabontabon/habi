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

const actions: Actions = { openProject: vi.fn(async () => {}), newSkill: vi.fn(), addSkills: vi.fn() };

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

describe("the Skill Studio", () => {
  it("puts identity in the head and the instructions in front, with nothing to fill in first", async () => {
    handlers.get_skill = () => skill();
    const { container } = wrap(<SkillStudio id="k" />);
    expect(await screen.findByLabelText("Skill title")).toHaveValue("Review");
    expect(screen.getByLabelText("Purpose (description)")).toHaveValue("Reviews changes before merge.");
    expect(screen.getByText("review")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Instructions/, selected: true })).toBeInTheDocument();
    expect(screen.getByText("Ready to use")).toBeInTheDocument();
    // One primary action in the head; the rest behind a menu.
    expect(screen.getByRole("button", { name: "Use & share" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Move to trash" })).not.toBeInTheDocument();
    expect(await screen.findByText("Start writing — or begin from a shape")).toBeInTheDocument();
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
    await userEvent.click(await screen.findByRole("button", { name: /Workflow/ }));
    await waitFor(() => expect(saved).toHaveBeenCalled(), { timeout: 2000 });
    expect((saved.mock.calls[0]?.[0].document as { body: string } | undefined)?.body).toBe(
      templates[1]?.body,
    );
  });

  it("moves between modes with ⌘1–3 and keeps visited modes mounted", async () => {
    handlers.get_skill = () => skill({ body: "## Steps\n\nDo it.\n" });
    handlers.preview_skill = () => ({
      appliesWhen: null,
      excludes: null,
      scope: "module",
      problem: null,
      projects: [],
    });
    wrap(<SkillStudio id="k" />);
    await screen.findByLabelText("Skill title");
    fireEvent.keyDown(window, { key: "2", metaKey: true });
    expect(screen.getByRole("tab", { name: /When it applies/, selected: true })).toBeInTheDocument();
    // The instructions are hidden, not gone: undo history and pending saves survive.
    const instructions = document.getElementById("studio-mode-instructions");
    expect(instructions).not.toBeNull();
    expect(instructions?.hidden).toBe(true);
    fireEvent.keyDown(window, { key: "1", metaKey: true });
    expect(document.getElementById("studio-mode-instructions")).toBe(instructions);
    expect(instructions?.hidden).toBe(false);
  });

  it("changes the identifier deliberately, and warns where it is installed under the old one", async () => {
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
    await userEvent.click(await screen.findByRole("button", { name: "Change" }));
    const field = screen.getByLabelText("name");
    await userEvent.clear(field);
    await userEvent.type(field, "Bad Name");
    expect(screen.getByText("Use lowercase letters, digits and hyphens only.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    await userEvent.clear(field);
    await userEvent.type(field, "merge-review");
    expect(await screen.findByText(/Installed in billing as/)).toBeInTheDocument();
    // Typing alone saves nothing.
    expect(saved).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(saved).toHaveBeenCalled(), { timeout: 2000 });
    expect((saved.mock.calls[0]?.[0].document as { name: string } | undefined)?.name).toBe("merge-review");
  });

  it("says what is unfinished and takes the author to the fix", async () => {
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
    await userEvent.click(await screen.findByRole("button", { name: /1 thing to finish/ }));
    const panel = screen.getByRole("complementary", { name: "Use & share" });
    expect(within(panel).getByText(/Agents decide whether to load a skill/)).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole("button", { name: "Edit the purpose" }));
    await waitFor(() => expect(screen.getByLabelText("Purpose (description)")).toHaveFocus());
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

  it("shows where a copy came from and what changed since", async () => {
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
    await userEvent.click(await screen.findByRole("button", { name: /Copied from review/ }));
    const panel = screen.getByRole("complementary", { name: "Where it comes from" });
    expect(await within(panel).findByText("1 file changed · 1 as copied")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Prepare a contribution…" })).toBeInTheDocument();
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
    handlers.preview_skill = () => ({
      appliesWhen: null,
      excludes: null,
      scope: "module",
      problem: null,
      projects: [],
    });
    wrap(<SkillStudio id="k" />);
    await screen.findByLabelText("Skill title");
    fireEvent.keyDown(window, { key: "2", metaKey: true });
    const rules = document.getElementById("studio-mode-rules") as HTMLElement;
    expect(within(rules).getByText("it contains Java code")).toBeInTheDocument();
    expect(within(rules).getByText("**/pom.xml")).toBeInTheDocument();
    expect(within(rules).getByText("not when")).toBeInTheDocument();
    expect(within(rules).getByText(/kept exactly as written/)).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 900));
    expect(save).not.toHaveBeenCalled();
  });

  it("says in one project whether Habi would suggest it, and what it needs, without running anything", async () => {
    handlers.get_skill = () => skill({ body: "Steps." });
    handlers.recent_projects = () => [
      {
        id: "p1",
        name: "billing",
        path: "~/work/billing",
        exists: true,
        lastOpenedAt: "2026-10-02T00:00:00Z",
        exclusions: [],
        sample: false,
        summary: null,
      },
    ];
    const preview = vi.fn((args: Record<string, unknown>) => ({
      appliesWhen: { op: "tag", tag: "lang:java" },
      excludes: null,
      scope: "module",
      problem: null,
      projects: [
        {
          project: {
            id: "p1",
            name: "billing",
            path: "~/work/billing",
            exists: true,
            lastOpenedAt: "2026-10-02T00:00:00Z",
            exclusions: [],
            sample: false,
            summary: null,
          },
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
    const panel = await screen.findByRole("complementary", { name: "Would Habi suggest it?" });
    expect(
      await within(panel).findByText("Habi would suggest it here", {}, { timeout: 2000 }),
    ).toBeInTheDocument();
    expect(within(panel).getByText(/Maven/)).toBeInTheDocument();
    expect(within(panel).getByText(/nothing was run/)).toBeInTheDocument();
    expect(within(panel).getByText(/not whether an agent loads or runs it/)).toBeInTheDocument();
    // Only the chosen project was evaluated.
    const request = preview.mock.calls[0]?.[0].request as { projectId?: string } | undefined;
    expect(request?.projectId).toBe("p1");
  });

  it("keeps the package as a small workspace where scripts are shown, never run", async () => {
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
    const files = document.getElementById("studio-mode-files") as HTMLElement;
    // SKILL.md is written where it belongs.
    expect(within(files).getByText("instructions →")).toBeInTheDocument();
    await userEvent.click(within(files).getByTitle("scripts/check.py"));
    expect(await within(files).findByText("python3 scripts/check.py")).toBeInTheDocument();
    expect(within(files).getByText(/Habi never runs scripts/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Run/ })).not.toBeInTheDocument();

    await userEvent.click(within(files).getByRole("button", { name: "New" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Shell script/ }));
    await userEvent.type(within(files).getByLabelText("File name"), "verify{Enter}");
    await waitFor(() => expect(written).toContain("scripts/verify.sh"));
  });

  it("refuses to add dropped files the window did not receive", async () => {
    // Without the desktop shell there are no drops to take: the hint stays, nothing listens.
    handlers.get_skill = () => skill({ body: "Steps." });
    wrap(<SkillStudio id="k" />);
    await screen.findByLabelText("Skill title");
    fireEvent.keyDown(window, { key: "3", metaKey: true });
    expect(screen.getByText("Drop files onto the window to add them.")).toBeInTheDocument();
    expect(invoke.mock.calls.some((c) => c[0] === "add_dropped_skill_files")).toBe(false);
  });
});
