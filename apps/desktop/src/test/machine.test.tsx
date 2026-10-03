import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportInspection } from "../bindings/ImportInspection";
import type { LocalSkill } from "../bindings/LocalSkill";
import type { MachineSkill } from "../bindings/MachineSkill";
import type { ProjectCopy } from "../bindings/ProjectCopy";
import { ToastProvider } from "../components/Toasts";
import { type Actions, ActionsContext } from "../lib/actions";
import { copyState, precedenceNote } from "../lib/machine";
import { NavProvider } from "../lib/nav";
import { AlreadyHere } from "../views/project/AlreadyHere";
import { OnThisMachine } from "../views/skills/OnThisMachine";
import { SkillsView } from "../views/skills/SkillsView";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const actions: Actions = {
  openProject: vi.fn(async () => {}),
  newSkill: vi.fn(),
  addSkills: vi.fn(),
  showWelcome: vi.fn(),
};

function wrap(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <NavProvider initial={{ name: "skills" }}>
          <ActionsContext.Provider value={actions}>{ui}</ActionsContext.Provider>
        </NavProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

function machineSkill(over: Partial<MachineSkill> = {}): MachineSkill {
  return {
    id: "claude/alpha",
    folder: "alpha",
    name: "alpha",
    description: "Reviews database migrations. Use when a change touches migrations.",
    location: "~/.claude/skills/alpha",
    readers: ["claude-code", "cursor"],
    isLink: false,
    fileCount: 1,
    digest: "sha256:aaa",
    problems: [],
    complete: true,
    importedAs: null,
    mentionsHome: [],
    inProjects: [],
    managed: null,
    ...over,
  };
}

const sharedCopy: ProjectCopy = {
  projectId: "p1",
  projectName: "billing",
  path: ".claude/skills/alpha",
  identical: true,
  sharedReaders: [
    { client: "claude-code", precedence: "personalWins" },
    { client: "cursor", precedence: "notDocumented" },
  ],
};

function localSkill(): LocalSkill {
  return {
    summary: {
      id: "k1",
      name: "alpha",
      title: "Alpha",
      description: "Reviews database migrations.",
      origin: { type: "folder", path: "~/.claude/skills/alpha" },
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
    document: { name: "alpha", description: "Reviews database migrations.", body: "" },
    documentDigest: "doc",
    documentError: null,
    form: {
      title: "Alpha",
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
    files: [{ path: "SKILL.md", size: 10, digest: "d", executable: false, text: true }],
    diagnostics: [],
    location: "~/habi/skills/k1/package",
  };
}

function inspection(over: Partial<ImportInspection["candidates"][number]> = {}): ImportInspection {
  return {
    origin: "~/.claude/skills/alpha",
    notes: [],
    candidates: [
      {
        path: "",
        name: "alpha",
        title: "Alpha",
        description: "",
        license: null,
        hasMetadata: false,
        files: ["SKILL.md"],
        size: 10,
        problems: [],
        complete: true,
        digest: "sha256:aaa",
        duplicate: null,
        suggestedName: null,
        ...over,
      },
    ],
  };
}

let machine: MachineSkill[] = [];

beforeEach(() => {
  invoke.mockReset();
  vi.mocked(actions.addSkills).mockReset();
  machine = [];
  invoke.mockImplementation(async (cmd: string) => {
    switch (cmd) {
      case "machine_skills":
        return machine;
      case "recent_projects":
      case "list_skills":
      case "list_sources":
      case "skills_overview":
        return [];
      case "inspect_import":
        return inspection();
      case "import_skills":
        return { imported: [localSkill().summary], skipped: [] };
      case "get_skill":
        return localSkill();
      default:
        throw { code: "notFound", message: `no mock for ${cmd}` };
    }
  });
});

describe("what a client does with two copies", () => {
  it("says Claude Code uses the personal copy and does not guess for the others", () => {
    expect(precedenceNote(sharedCopy)).toBe(
      "On this machine Claude Code uses the global copy. Which copy Cursor uses is not documented.",
    );
    expect(
      precedenceNote({ ...sharedCopy, sharedReaders: [{ client: "codex", precedence: "notDocumented" }] }),
    ).toBe("Which copy Codex uses is not documented.");
    expect(
      precedenceNote({
        ...sharedCopy,
        sharedReaders: [
          { client: "gemini-cli", precedence: "projectWins" },
          { client: "copilot", precedence: "notDocumented" },
          { client: "opencode", precedence: "notDocumented" },
        ],
      }),
    ).toBe(
      "Gemini CLI uses the project's copy. Which copy GitHub Copilot and OpenCode use is not documented.",
    );
    // No client reads both, so neither hides the other.
    expect(precedenceNote({ ...sharedCopy, sharedReaders: [] })).toBeNull();
    expect(copyState(sharedCopy)).toBe("identical");
    expect(copyState({ ...sharedCopy, identical: false })).toBe("differs");
  });
});

/** Opens a row's ⋯ menu and returns the item named `item`. */
async function menuItem(skill: string, item: string | RegExp) {
  await userEvent.click(await screen.findByRole("button", { name: `More for ${skill}` }));
  return screen.findByRole("menuitem", { name: item });
}

describe("On this machine", () => {
  it("is absent when no skills are found", async () => {
    wrap(<OnThisMachine />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("machine_skills", undefined));
    expect(screen.queryByText("On this machine")).toBeNull();
  });

  it("lists each skill as global, with who reads it and how a project's copy compares", async () => {
    machine = [
      machineSkill({ inProjects: [sharedCopy], isLink: true }),
      machineSkill({
        id: "agents/beta",
        folder: "beta",
        name: "beta",
        location: "~/.agents/skills/beta",
        readers: ["codex", "cursor"],
      }),
    ];
    wrap(<OnThisMachine />);
    const list = await screen.findByRole("list", { name: "Skills on this machine" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    const alpha = rows[0] as HTMLElement;
    expect(within(alpha).getByText("Global")).toBeTruthy();
    expect(within(alpha).getByText("Link")).toBeTruthy();
    // Where it is lives in the tools' tooltips, not in a line of its own.
    const reach = within(alpha).getByRole("img", { name: "Read by Claude Code and Cursor" });
    expect(within(reach).getByText("Claude Code").getAttribute("data-tip")).toContain(
      "~/.claude/skills/alpha",
    );
    expect(within(alpha).getByText("billing")).toBeTruthy();
    expect(within(alpha).getByText(/identical/)).toBeTruthy();
    expect(within(alpha).getByText(/On this machine Claude Code uses the global copy/)).toBeTruthy();
    expect(
      within(rows[1] as HTMLElement).getByRole("img", { name: "Read by Cursor and Codex" }),
    ).toBeTruthy();
    expect(within(rows[1] as HTMLElement).queryByText("Link")).toBeNull();
  });

  it("shows a skill installed for several agent tools once, with every folder and every reader", async () => {
    const managed = {
      key: "machine:mattpocock/code-review",
      library: "Matt Pocock",
      state: "current" as const,
    };
    machine = [
      machineSkill({ id: "claude/code-review", name: "code-review", managed, inProjects: [sharedCopy] }),
      machineSkill({
        id: "agents/code-review",
        name: "code-review",
        location: "~/.agents/skills/code-review",
        readers: ["codex", "cursor", "junie"],
        digest: "sha256:bbb",
        managed,
        inProjects: [sharedCopy],
      }),
    ];
    wrap(<OnThisMachine />);
    const list = await screen.findByRole("list", { name: "Skills on this machine" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(1);
    const row = rows[0] as HTMLElement;
    const reach = within(row).getByRole("img", { name: "Read by Claude Code, Cursor, Codex and Junie" });
    // Cursor reads both folders, so its tooltip names both.
    const cursor = within(reach).getByText("Cursor").getAttribute("data-tip") ?? "";
    expect(cursor).toContain("~/.claude/skills/alpha");
    expect(cursor).toContain("~/.agents/skills/code-review");
    // One menu, saying where it came from.
    await userEvent.click(within(row).getByRole("button", { name: "More for code-review" }));
    expect(screen.getAllByRole("menuitem", { name: /From Matt Pocock/ })).toHaveLength(1);
    expect(within(row).getAllByText("billing")).toHaveLength(1);
    expect(screen.getByText(/1 skill in your own folders/)).toBeTruthy();
  });

  it("keeps copies apart when their files differ and Habi did not install them", async () => {
    machine = [
      machineSkill(),
      machineSkill({ id: "agents/alpha", location: "~/.agents/skills/alpha", digest: "sha256:ccc" }),
    ];
    wrap(<OnThisMachine />);
    const list = await screen.findByRole("list", { name: "Skills on this machine" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
  });

  it("copies into My skills through the add dialog and never writes anywhere itself", async () => {
    machine = [machineSkill()];
    wrap(<OnThisMachine />);
    await userEvent.click(await menuItem("alpha", /Add to My skills/));
    expect(actions.addSkills).toHaveBeenCalledWith({ source: "machine", id: "claude/alpha" });
    expect(invoke).not.toHaveBeenCalledWith("import_skills", expect.anything());
  });

  it("offers the copy it already made instead of a second one", async () => {
    machine = [machineSkill({ importedAs: "k1" })];
    wrap(<OnThisMachine />);
    expect(await menuItem("alpha", /Open my copy/)).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: /Add to My skills/ })).toBeNull();
  });

  it("brings a skill into My skills and then asks which project to use it in", async () => {
    machine = [machineSkill()];
    wrap(<OnThisMachine />);
    await userEvent.click(await menuItem("alpha", /Use in a project/));
    expect(await screen.findByRole("dialog", { name: /Use Alpha/ })).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith("import_skills", {
      from: { type: "machine", id: "claude/alpha" },
      selections: [{ path: "", rename: null }],
      jobId: null,
    });
  });

  it("hands decisions to the add dialog: an identifier already used is not settled silently", async () => {
    machine = [machineSkill()];
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "machine_skills") return machine;
      if (cmd === "inspect_import")
        return inspection({
          duplicate: { kind: "sameName", skillId: "other", title: "Other" },
          suggestedName: "alpha-2",
        });
      throw { code: "notFound", message: `no mock for ${cmd}` };
    });
    wrap(<OnThisMachine />);
    await userEvent.click(await menuItem("alpha", /Use in a project/));
    await waitFor(() =>
      expect(actions.addSkills).toHaveBeenCalledWith({ source: "machine", id: "claude/alpha" }),
    );
    expect(invoke).not.toHaveBeenCalledWith("import_skills", expect.anything());
  });

  it("warns before a skill that names a home folder goes toward a project, and goes on only if told to", async () => {
    machine = [machineSkill({ mentionsHome: ["SKILL.md", "references/setup.md"] })];
    wrap(<OnThisMachine />);
    expect(await screen.findByText("Mentions a home folder")).toBeTruthy();
    await userEvent.click(await menuItem("alpha", /Use in a project/));
    const warning = await screen.findByRole("dialog", { name: /mentions folders on your machine/ });
    expect(within(warning).getByText("references/setup.md")).toBeTruthy();
    // Nothing has been copied yet.
    expect(invoke).not.toHaveBeenCalledWith("import_skills", expect.anything());

    await userEvent.click(within(warning).getByRole("button", { name: "Continue anyway" }));
    expect(await screen.findByRole("dialog", { name: /Use Alpha/ })).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith("import_skills", expect.anything());
  });

  it("cancelling the warning copies nothing", async () => {
    machine = [machineSkill({ mentionsHome: ["SKILL.md"] })];
    wrap(<OnThisMachine />);
    await userEvent.click(await menuItem("alpha", /Use in a project/));
    const warning = await screen.findByRole("dialog");
    await userEvent.click(within(warning).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith("import_skills", expect.anything());
    expect(invoke).not.toHaveBeenCalledWith("inspect_import", expect.anything());
  });

  it("will not offer to copy a skill whose files cannot all be copied", async () => {
    machine = [machineSkill({ complete: false })];
    wrap(<OnThisMachine />);
    const add = await menuItem("alpha", /Add to My skills/);
    expect((add as HTMLButtonElement).disabled).toBe(true);
    expect(
      ((await screen.findByRole("menuitem", { name: /Use in a project/ })) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getAllByText(/can’t be copied|cannot be copied/).length).toBeGreaterThan(0);
  });

  it("shows nothing, and does not break the page, when the folders cannot be read", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "machine_skills") throw { code: "io", message: "unreadable" };
      throw { code: "notFound", message: `no mock for ${cmd}` };
    });
    wrap(<OnThisMachine />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("machine_skills", undefined));
    expect(screen.queryByText("On this machine")).toBeNull();
  });
});

describe("My skills page", () => {
  it("shows the section even before the person has any skills of their own", async () => {
    machine = [machineSkill()];
    wrap(<SkillsView />);
    expect(await screen.findByText("On this machine")).toBeTruthy();
    expect(screen.getByRole("list", { name: "Skills on this machine" })).toHaveTextContent("alpha");
  });

  it("shows it below the skills Habi owns", async () => {
    machine = [machineSkill()];
    const own = localSkill().summary;
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "machine_skills") return machine;
      if (cmd === "list_skills") return [own];
      if (cmd === "skills_overview" || cmd === "list_sources" || cmd === "recent_projects") return [];
      throw { code: "notFound", message: `no mock for ${cmd}` };
    });
    wrap(<SkillsView />);
    const mine = await screen.findByRole("list", { name: "Skills" });
    const here = await screen.findByRole("list", { name: "Skills on this machine" });
    expect(mine.compareDocumentPosition(here) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("the project page", () => {
  const project = {
    id: "p1",
    name: "billing",
    path: "~/work/billing",
    exists: true,
    lastOpenedAt: "2026-10-02T00:00:00Z",
    exclusions: [],
    sample: false,
    summary: null,
  };
  const found = (path: string) => ({
    skills: [
      {
        path,
        name: "alpha",
        description: "Reviews migrations.",
        readers: ["claude-code", "cursor"],
        managedBy: null,
        hasMetadata: false,
        fileCount: 1,
        problems: [],
        digest: "sha256:aaa",
        importedAs: null,
      },
    ],
    instructions: [],
    limits: [],
    inspectedAt: "2026-10-02T00:00:00Z",
  });

  it("notes a skill that is also among the person's own, and which copy a client uses", async () => {
    machine = [machineSkill({ inProjects: [{ ...sharedCopy, identical: false }] })];
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "machine_skills") return machine;
      if (cmd === "discover_project") return found(".claude/skills/alpha");
      if (cmd === "list_sources") return [];
      throw { code: "notFound", message: `no mock for ${cmd}` };
    });
    wrap(<AlreadyHere project={project} />);
    expect(
      await screen.findByText(/Also in your own skills \(~\/\.claude\/skills\/alpha\): differs\./),
    ).toBeTruthy();
    expect(screen.getByText(/On this machine Claude Code uses the global copy/)).toBeTruthy();
  });

  it("says nothing about a skill that has no counterpart among the person's own", async () => {
    machine = [machineSkill({ inProjects: [sharedCopy] })];
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "machine_skills") return machine;
      if (cmd === "discover_project") return found(".claude/skills/other-skill");
      if (cmd === "list_sources") return [];
      throw { code: "notFound", message: `no mock for ${cmd}` };
    });
    wrap(<AlreadyHere project={project} />);
    expect(await screen.findByText("alpha")).toBeTruthy();
    expect(screen.queryByText(/Also in your own skills/)).toBeNull();
  });
});
