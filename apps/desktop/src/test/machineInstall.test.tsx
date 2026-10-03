import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InstallShadow } from "../bindings/InstallShadow";
import type { LocalSkill } from "../bindings/LocalSkill";
import type { MachineSkill } from "../bindings/MachineSkill";
import type { Plan } from "../bindings/Plan";
import { ToastProvider } from "../components/Toasts";
import { type Actions, ActionsContext } from "../lib/actions";
import { NavProvider } from "../lib/nav";
import { ChangeTree, groupChanges, ReviewDialog, type ReviewRequest } from "../views/review/ReviewDialog";
import { OnThisMachine } from "../views/skills/OnThisMachine";
import { UseSkillDialog } from "../views/skills/UseSkillDialog";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const actions: Actions = { openProject: vi.fn(async () => {}), newSkill: vi.fn(), addSkills: vi.fn(), showWelcome: vi.fn() };

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

const emptyDiff = { hunks: [], added: 1, removed: 0, binary: false, truncated: false };

function plan(over: Partial<Plan> = {}): Plan {
  return {
    id: "plan-1",
    action: "install",
    title: "Install for Claude Code on this machine",
    project: "~",
    createdAt: "2026-10-03T00:00:00Z",
    items: [
      {
        key: "k",
        title: "Liquibase migration review",
        kind: "skill",
        source: "Team library",
        version: "3c5e131423",
        clients: ["claude-code"],
        notes: [],
      },
    ],
    changes: [
      {
        path: ".claude/skills/liquibase/SKILL.md",
        op: "create",
        kind: "skillFile",
        items: ["Liquibase migration review"],
        clients: ["claude-code"],
        before: null,
        after: "sha256:aaa",
        explanation: "Claude Code reads skills from .claude/skills.",
        diff: emptyDiff,
        executable: null,
      },
    ],
    conflicts: [],
    notes: [],
    recovery: "Replaced or deleted files are kept, and can be restored.",
    ...over,
  };
}

const shadow: InstallShadow = {
  name: "liquibase",
  title: "Liquibase migration review",
  copies: [
    {
      projectId: "p1",
      projectName: "billing",
      path: ".claude/skills/liquibase",
      identical: false,
      sharedReaders: [
        { client: "claude-code", precedence: "personalWins" },
        { client: "cursor", precedence: "notDocumented" },
      ],
    },
  ],
};

const install: ReviewRequest = {
  kind: "install",
  items: [{ sourceId: "lib", itemId: "liquibase" }],
  title: "Liquibase migration review",
};

let shadows: InstallShadow[] = [];

beforeEach(() => {
  invoke.mockReset();
  shadows = [];
  invoke.mockImplementation(async (cmd: string) => {
    switch (cmd) {
      case "get_settings":
        return { autoRefreshHours: 12 };
      case "plan_install_machine":
      case "plan_update_machine":
      case "plan_remove_machine":
      case "plan_restore_machine":
        return plan();
      case "detected_clients":
        return [];
      case "machine_install_preview":
        return shadows;
      case "apply_plan":
        return {
          id: "op-1",
          title: "Install",
          action: "install",
          state: "done",
          createdAt: "2026-10-03T00:00:00Z",
          finishedAt: "2026-10-03T00:00:01Z",
          files: [".claude/skills/liquibase/SKILL.md"],
          problems: [],
        };
      case "machine_skills":
      case "list_skills":
      case "list_sources":
      case "recent_projects":
      case "skills_overview":
        return [];
      default:
        throw { code: "notFound", message: `no mock for ${cmd}` };
    }
  });
});

const called = (cmd: string) => invoke.mock.calls.some((c) => c[0] === cmd);

describe("the files of a review", () => {
  const file = (
    path: string,
    kind: Plan["changes"][number]["kind"],
    clients: Plan["changes"][number]["clients"],
  ) =>
    ({
      ...plan().changes[0],
      path,
      kind,
      clients,
      explanation: kind === "lockFile" ? "Habi's record." : "Claude Code reads skills from .claude/skills.",
    }) as Plan["changes"][number];

  it("sit under one folder and one reason, with the skill's own file first", () => {
    const groups = groupChanges([
      file(".claude/skills/ask/agents/openai.yaml", "skillFile", ["claude-code"]),
      file(".claude/skills/ask/SKILL.md", "skillFile", ["claude-code"]),
      file(".habi/lock.json", "lockFile", []),
    ]);
    expect(groups.map((g) => [g.title, g.dir, g.why])).toEqual([
      ["Claude Code", ".claude/skills/ask/", "Claude Code reads skills from .claude/skills."],
      ["Habi's record", ".habi/", "Habi's record."],
    ]);
    expect(groups[0]?.rows.map((r) => r.name)).toEqual(["SKILL.md", "agents/openai.yaml"]);
  });
});

describe("a long group of files", () => {
  const many = Array.from({ length: 12 }, (_, i) => ({
    ...plan().changes[0],
    path: `.claude/skills/big/references/r${i}.md`,
  })) as Plan["changes"];

  it("shows the first few and the rest on request", async () => {
    render(<ChangeTree changes={many} />);
    expect(screen.getByText("r0.md")).toBeTruthy();
    expect(screen.queryByText("r11.md")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Show 7 more files" }));
    expect(screen.getByText("r11.md")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Show fewer" }));
    expect(screen.queryByText("r11.md")).toBeNull();
  });

  it("leaves a short group whole", () => {
    render(<ChangeTree changes={many.slice(0, 8)} />);
    expect(screen.queryByRole("button", { name: /more files/ })).toBeNull();
    expect(screen.getByText("r7.md")).toBeTruthy();
  });
});

describe("review for this machine", () => {
  it("plans against the person's own folders, not a project", async () => {
    wrap(<ReviewDialog projectId={null} request={install} onClose={() => {}} />);
    expect(await screen.findByRole("button", { name: /Install on this machine/ })).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith("plan_install_machine", {
      items: install.kind === "install" ? install.items : [],
      clients: ["claude-code"],
      decisions: {},
    });
    expect(called("plan_install")).toBe(false);
    // Skills only: no MCP option, and the scope says every project.
    expect(screen.queryByText(/Add suggested MCP configuration/)).toBeNull();
  });

  it("always keeps one agent picked", async () => {
    wrap(<ReviewDialog projectId={null} request={install} onClose={() => {}} />);
    const claude = await screen.findByRole("checkbox", { name: /Claude Code/ });
    expect((claude as HTMLInputElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole("checkbox", { name: /Codex/ }));
    expect((claude as HTMLInputElement).disabled).toBe(false);
    await userEvent.click(claude);
    expect((screen.getByRole("checkbox", { name: /Codex/ }) as HTMLInputElement).disabled).toBe(true);
  });

  it("names the projects that already hold the skill and which copy a client uses", async () => {
    shadows = [shadow];
    wrap(<ReviewDialog projectId={null} request={install} onClose={() => {}} />);
    const note = await screen.findByText("Projects that already have this skill");
    const box = note.closest("div") as HTMLElement;
    expect(await within(box.parentElement as HTMLElement).findByText("billing")).toBeTruthy();
    expect(screen.getByText(/differs/)).toBeTruthy();
    expect(screen.getByText(/On this machine Claude Code uses the global copy/)).toBeTruthy();
    expect(screen.getByText(/Which copy Cursor uses is not documented/)).toBeTruthy();
  });

  it("applies the plan and reports it without pointing at a project's history", async () => {
    const onClose = vi.fn();
    wrap(<ReviewDialog projectId={null} request={install} onClose={onClose} />);
    await userEvent.click(await screen.findByRole("button", { name: /Install on this machine/ }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("apply_plan", { planId: "plan-1" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(screen.queryByText(/Installed & history/)).toBeNull();
  });

  it("warns about an unaudited library without blocking the install", async () => {
    wrap(<ReviewDialog projectId={null} request={{ ...install, unaudited: true }} onClose={() => {}} />);
    const confirm = await screen.findByRole("button", { name: /Install on this machine/ });
    expect(screen.getByText("Not audited.")).toBeTruthy();
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
  });

  it("says nothing of it when the library is the team's own", async () => {
    wrap(<ReviewDialog projectId={null} request={install} onClose={() => {}} />);
    const confirm = await screen.findByRole("button", { name: /Install on this machine/ });
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText("Not audited.")).toBeNull();
  });

  it("uses the machine commands for update, remove and restore", async () => {
    for (const [request, command, args] of [
      [{ kind: "update", keys: ["k"], title: "x" }, "plan_update_machine", { keys: ["k"], decisions: {} }],
      [{ kind: "remove", keys: ["k"], title: "x" }, "plan_remove_machine", { keys: ["k"], decisions: {} }],
      [
        { kind: "restore", operationId: "op", title: "x" },
        "plan_restore_machine",
        { operationId: "op", decisions: {} },
      ],
    ] as [ReviewRequest, string, object][]) {
      invoke.mockClear();
      const view = wrap(<ReviewDialog projectId={null} request={request} onClose={() => {}} />);
      await waitFor(() => expect(invoke).toHaveBeenCalledWith(command, args));
      view.unmount();
    }
  });

  it("offers the MCP option only for a skill that needs a server", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_settings") return { autoRefreshHours: 12 };
      if (cmd === "plan_install") return plan({ project: "~/work/billing" });
      if (cmd === "library") return { sourceId: "lib", items: [{ id: "liquibase", mcp: [] }] };
      throw { code: "notFound", message: `no mock for ${cmd}` };
    });
    wrap(<ReviewDialog projectId="p1" request={install} onClose={() => {}} />);
    await screen.findByRole("button", { name: "Install" });
    await waitFor(() => expect(called("library")).toBe(true));
    expect(screen.queryByText(/Add suggested MCP configuration/)).toBeNull();
  });

  it("preselects the agents the project already uses, and plans for them", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_settings") return { autoRefreshHours: 12 };
      if (cmd === "detected_clients") return ["cursor", "gemini-cli"];
      if (cmd === "plan_install") return plan({ project: "~/work/billing" });
      if (cmd === "library") return { sourceId: "lib", items: [{ id: "liquibase", mcp: [] }] };
      throw { code: "notFound", message: `no mock for ${cmd}` };
    });
    wrap(<ReviewDialog projectId="p1" request={install} onClose={() => {}} />);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "plan_install",
        expect.objectContaining({ clients: ["cursor", "gemini-cli"] }),
      ),
    );
    // Nothing was planned for a guess while the project was still being read.
    expect(invoke.mock.calls.filter((c) => c[0] === "plan_install")).toHaveLength(1);
    expect((screen.getByRole("checkbox", { name: /Cursor/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: /Gemini CLI/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: /Claude Code/ }) as HTMLInputElement).checked).toBe(false);
  });

  it("falls back to Claude Code when the project shows no sign of an agent", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_settings") return { autoRefreshHours: 12 };
      if (cmd === "detected_clients") return [];
      if (cmd === "plan_install") return plan({ project: "~/work/billing" });
      if (cmd === "library") return { sourceId: "lib", items: [{ id: "liquibase", mcp: [] }] };
      throw { code: "notFound", message: `no mock for ${cmd}` };
    });
    wrap(<ReviewDialog projectId="p1" request={install} onClose={() => {}} />);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "plan_install",
        expect.objectContaining({ clients: ["claude-code"] }),
      ),
    );
  });

  it("still plans against a project when given one", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_settings") return { autoRefreshHours: 12 };
      if (cmd === "plan_install") return plan({ project: "~/work/billing" });
      if (cmd === "library")
        return {
          sourceId: "lib",
          items: [{ id: "liquibase", mcp: [{ name: "db", purpose: null, server: null }] }],
        };
      throw { code: "notFound", message: `no mock for ${cmd}` };
    });
    wrap(<ReviewDialog projectId="p1" request={install} onClose={() => {}} />);
    await waitFor(() => expect(called("plan_install")).toBe(true));
    expect(called("plan_install_machine")).toBe(false);
    expect(await screen.findByText(/Add suggested MCP configuration/)).toBeTruthy();
  });
});

function managedSkill(state: NonNullable<MachineSkill["managed"]>["state"]) {
  const skill: MachineSkill = {
    id: "claude/liquibase",
    folder: "liquibase",
    name: "liquibase",
    description: "Reviews migrations. Use when a change touches them.",
    location: "~/.claude/skills/liquibase",
    readers: ["claude-code", "cursor"],
    isLink: false,
    fileCount: 1,
    digest: "sha256:aaa",
    problems: [],
    complete: true,
    importedAs: null,
    mentionsHome: [],
    inProjects: [],
    managed: { key: "lib#liquibase", library: "Team library", state },
  };
  return skill;
}

describe("skills Habi installed on this machine", () => {
  it("say so, and offer update and remove through the same review", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "machine_skills") return [managedSkill("updateAvailable")];
      if (cmd === "get_settings") return { autoRefreshHours: 12 };
      if (cmd === "plan_update_machine" || cmd === "plan_remove_machine") return plan();
      throw { code: "notFound", message: `no mock for ${cmd}` };
    });
    wrap(<OnThisMachine />);
    expect(await screen.findByText(/installed by Habi from Team library · update available/)).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "More for liquibase" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /Update…/ }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("plan_update_machine", { keys: ["lib#liquibase"], decisions: {} }),
    );
  });

  it("offer a removal that names the files Habi installed", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "machine_skills") return [managedSkill("current")];
      if (cmd === "get_settings") return { autoRefreshHours: 12 };
      if (cmd === "plan_remove_machine") return plan({ action: "remove", title: "Remove from this machine" });
      throw { code: "notFound", message: `no mock for ${cmd}` };
    });
    wrap(<OnThisMachine />);
    await userEvent.click(await screen.findByRole("button", { name: "More for liquibase" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /Remove from this machine…/ }));
    expect(await screen.findByRole("button", { name: "Remove from this machine" })).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith("plan_remove_machine", { keys: ["lib#liquibase"], decisions: {} });
  });

  it("have no update or remove menu when Habi did not install them", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "machine_skills") return [{ ...managedSkill("current"), managed: null }];
      throw { code: "notFound", message: `no mock for ${cmd}` };
    });
    wrap(<OnThisMachine />);
    await screen.findByText("liquibase");
    expect(screen.queryByRole("button", { name: "More for liquibase" })).toBeNull();
  });
});

describe("using one of My skills on this machine", () => {
  const skill: LocalSkill = {
    summary: {
      id: "k1",
      name: "alpha",
      title: "Alpha",
      description: "Reviews database migrations.",
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

  it("offers this machine beside the projects, and reviews it like any install", async () => {
    wrap(<UseSkillDialog skill={skill} onClose={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: "On this machine…" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("plan_install_machine", {
        items: [{ sourceId: "local", itemId: "alpha" }],
        clients: ["claude-code"],
        decisions: {},
      }),
    );
  });
});
