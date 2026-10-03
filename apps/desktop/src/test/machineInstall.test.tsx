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
import { ReviewDialog, type ReviewRequest } from "../views/review/ReviewDialog";
import { OnThisMachine } from "../views/skills/OnThisMachine";
import { UseSkillDialog } from "../views/skills/UseSkillDialog";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const actions: Actions = { openProject: vi.fn(async () => {}), newSkill: vi.fn(), addSkills: vi.fn() };

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
    recovery: "Habi keeps every replaced or deleted file in its operation journal.",
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
        return { autoRefreshHours: 12, defaultClients: ["claude-code"] };
      case "plan_install_machine":
      case "plan_update_machine":
      case "plan_remove_machine":
      case "plan_restore_machine":
        return plan();
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

describe("review for this machine", () => {
  it("plans against the person's own folders, not a project", async () => {
    wrap(<ReviewDialog projectId={null} request={install} onClose={() => {}} />);
    expect(await screen.findByText(/Install for Claude Code on this machine/)).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith("plan_install_machine", {
      items: install.kind === "install" ? install.items : [],
      clients: ["claude-code"],
      decisions: {},
    });
    expect(called("plan_install")).toBe(false);
    // Skills only: no MCP option, and the scope says every project.
    expect(screen.queryByText(/Add suggested MCP configuration/)).toBeNull();
    expect(screen.getByText(/every project on this machine/)).toBeTruthy();
    expect(screen.getByText(/reads ~\/\.claude\/skills/)).toBeTruthy();
    expect(screen.getByText(/This machine/)).toBeTruthy();
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
    await userEvent.click(
      await screen.findByRole("button", { name: /Install for Claude Code on this machine/ }),
    );
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("apply_plan", { planId: "plan-1" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(screen.queryByText(/Installed & history/)).toBeNull();
  });

  it("keeps the confirm button off until an unaudited library is acknowledged", async () => {
    wrap(<ReviewDialog projectId={null} request={{ ...install, unaudited: true }} onClose={() => {}} />);
    const confirm = await screen.findByRole("button", { name: /Install for Claude Code on this machine/ });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole("checkbox", { name: /This library is not audited/ }));
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
  });

  it("does not ask for the tick when the library is the team's own", async () => {
    wrap(<ReviewDialog projectId={null} request={install} onClose={() => {}} />);
    const confirm = await screen.findByRole("button", { name: /Install for Claude Code on this machine/ });
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole("checkbox", { name: /not audited/ })).toBeNull();
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

  it("still plans against a project when given one", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_settings") return { autoRefreshHours: 12, defaultClients: ["claude-code"] };
      if (cmd === "plan_install") return plan({ project: "~/work/billing" });
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
      if (cmd === "get_settings") return { autoRefreshHours: 12, defaultClients: ["claude-code"] };
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
      if (cmd === "get_settings") return { autoRefreshHours: 12, defaultClients: ["claude-code"] };
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
