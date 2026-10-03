import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import type { LocalSkill } from "../bindings/LocalSkill";
import type { ProjectOverview } from "../bindings/ProjectOverview";
import type { ProjectRecord } from "../bindings/ProjectRecord";
import type { Source } from "../bindings/Source";
import { Dialog } from "../components/Dialog";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { ToastProvider, useToast } from "../components/Toasts";
import { type Actions, ActionsContext } from "../lib/actions";
import { HabiError } from "../lib/api";
import { guardWindowClose } from "../lib/closing";
import { NavProvider, type Route, useNav } from "../lib/nav";
import { useOverview } from "../lib/queries";
import { initTheme, useTheme } from "../lib/theme";
import { useAutosave } from "../lib/useAutosave";
import { CommandPalette } from "../views/CommandPalette";
import { InstalledView } from "../views/project/InstalledView";
import { ProjectView } from "../views/project/ProjectView";
import { SettingsView } from "../views/SettingsView";
import { Sidebar } from "../views/Sidebar";
import { SkillStudio } from "../views/skills/studio/SkillStudio";
import { ConnectLibrary, locationParts, treeOf } from "../views/sources/ConnectLibrary";
import { Welcome } from "../views/Welcome";
import billing from "./fixtures/overview-billing-service.json";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

type CloseEvent = { preventDefault: () => void };
let closeHandler: ((event: CloseEvent) => Promise<void>) | null = null;
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: async (handler: (event: CloseEvent) => Promise<void>) => {
      closeHandler = handler;
      return () => {
        closeHandler = null;
      };
    },
  }),
}));

type Handler = (args: Record<string, unknown>) => unknown;
let handlers: Record<string, Handler> = {};

beforeEach(() => {
  handlers = {};
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string, args: Record<string, unknown> = {}) => {
    const handler = handlers[cmd];
    if (handler) return handler(args);
    if (
      [
        "recent_projects",
        "list_skills",
        "list_sources",
        "list_contributions",
        "skills_overview",
        "skill_templates",
      ].includes(cmd)
    )
      return [];
    if (cmd === "log_ui_error" || cmd === "cancel_job") return null;
    throw { code: "notFound", message: `no mock for ${cmd}` };
  });
});

function Broken(): never {
  throw new Error("the screen broke");
}

describe("ErrorBoundary", () => {
  it("shows a way out, logs the error, and saves diagnostics", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    handlers.diagnostics_save = () => "~/Desktop/habi-diagnostics.txt";
    render(
      <ErrorBoundary area="the test">
        <Broken />
      </ErrorBoundary>,
    );
    expect(screen.getByText("Habi could not show this screen")).toBeInTheDocument();
    expect(screen.getByText("the screen broke")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
    const logged = invoke.mock.calls.find(([cmd]) => cmd === "log_ui_error")?.[1] as
      | { message: string; detail: string }
      | undefined;
    expect(logged?.message).toBe("Error: the screen broke");
    expect(logged?.detail).toContain("while showing the test");

    await userEvent.click(screen.getByRole("button", { name: "Save diagnostics…" }));
    await waitFor(() =>
      expect(screen.getByText("Saved to ~/Desktop/habi-diagnostics.txt")).toBeInTheDocument(),
    );
    quiet.mockRestore();
  });
});

const actions: Actions = { openProject: vi.fn(async () => {}), newSkill: vi.fn(), addSkills: vi.fn() };

function wrap(ui: ReactNode, initial: Route = { name: "welcome" }) {
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

function deferred() {
  let resolve: () => void = () => {};
  let reject: (e: unknown) => void = () => {};
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("closing the window", () => {
  it("waits for pending edits to be written before letting the window close", async () => {
    const write = deferred();
    const save = vi.fn(() => write.promise);
    const hook = renderHook(
      ({ value }) => useAutosave<string>({ value, keyOf: (v) => v, save, delay: 60_000 }),
      {
        initialProps: { value: "draft" },
      },
    );
    hook.rerender({ value: "draft, edited" });
    const onUnsaved = vi.fn();
    const stop = await guardWindowClose(onUnsaved);
    const event = { preventDefault: vi.fn() };

    let closed = false;
    const closing = closeHandler?.(event).then(() => {
      closed = true;
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(save).toHaveBeenCalledWith("draft, edited");
    expect(closed).toBe(false);

    await act(async () => {
      write.resolve();
      await closing;
    });
    expect(closed).toBe(true);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(onUnsaved).not.toHaveBeenCalled();
    stop();
    hook.unmount();
  });

  it("stays open when edits cannot be saved, and closes on the second try", async () => {
    const save = vi.fn(async () => {
      throw new HabiError({ code: "io", message: "disk full" });
    });
    const hook = renderHook(
      ({ value }) => useAutosave<string>({ value, keyOf: (v) => v, save, delay: 60_000 }),
      {
        initialProps: { value: "draft" },
      },
    );
    hook.rerender({ value: "draft, edited" });
    const onUnsaved = vi.fn();
    const stop = await guardWindowClose(onUnsaved);

    const first = { preventDefault: vi.fn() };
    await act(async () => {
      await closeHandler?.(first);
    });
    expect(first.preventDefault).toHaveBeenCalled();
    expect(onUnsaved).toHaveBeenCalledTimes(1);

    const second = { preventDefault: vi.fn() };
    await act(async () => {
      await closeHandler?.(second);
    });
    expect(second.preventDefault).not.toHaveBeenCalled();
    stop();
    hook.unmount();
  });
});

function skill(): LocalSkill {
  return {
    summary: {
      id: "k",
      name: "review",
      title: "Review",
      description: "Reviews changes",
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
    document: { name: "review", description: "Reviews changes", body: "" },
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
    files: [{ path: "SKILL.md", size: 10, digest: "d", executable: false, text: true }],
    diagnostics: [],
    location: "~/habi/skills/review",
  };
}

describe("the skill editor", () => {
  it("does not export when the latest edits could not be saved", async () => {
    handlers.get_skill = () => skill();
    handlers.skill_upstream = () => null;
    handlers.save_skill_applicability = () => skill();
    handlers.save_skill_document = () => {
      throw { code: "conflict", message: "SKILL.md changed outside Habi" };
    };
    handlers.export_skill = vi.fn(() => "~/Desktop/review");
    wrap(<SkillStudio id="k" />, { name: "skills", skillId: "k" });

    const title = await screen.findByLabelText("Skill title");
    await userEvent.type(title, " checklist");
    await userEvent.click(screen.getByRole("button", { name: "More for this skill" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /Export as zip…/ }));

    expect(await screen.findByText(/Nothing was done: your latest edits are not saved/)).toBeInTheDocument();
    expect(handlers.export_skill).not.toHaveBeenCalled();
  });

  it("asks before leaving with edits that could not be saved", async () => {
    handlers.get_skill = () => skill();
    handlers.skill_upstream = () => null;
    handlers.save_skill_applicability = () => skill();
    handlers.save_skill_document = () => {
      throw { code: "conflict", message: "SKILL.md changed outside Habi" };
    };
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
      { name: "skills", skillId: "k" },
    );
    const title = await screen.findByLabelText("Skill title");
    await userEvent.type(title, "!");
    await waitFor(
      () => expect(screen.getByText("This skill's files changed outside Habi")).toBeInTheDocument(),
      {
        timeout: 2000,
      },
    );

    await userEvent.click(screen.getByRole("button", { name: "Go to settings" }));
    expect(screen.getByRole("dialog", { name: "Unsaved edits" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Stay and fix" }));
    expect(screen.getByText("on skills")).toBeInTheDocument();
    expect(screen.getByLabelText("Skill title")).toHaveValue("Review!");

    await userEvent.click(screen.getByRole("button", { name: "Go to settings" }));
    await userEvent.click(screen.getByRole("button", { name: "Leave without them" }));
    expect(screen.getByText("on settings")).toBeInTheDocument();
  });
});

describe("global shortcuts", () => {
  it("leaves ⌘[ to text fields and the code editor, and goes back elsewhere", async () => {
    handlers.app_info = () => ({ version: "0.1.0", dataDir: "~/habi", startupError: null });
    handlers.get_settings = () => ({ autoRefreshHours: 12, defaultClients: ["claude-code"] });
    Element.prototype.scrollTo = () => {};
    render(<App />);
    await screen.findByRole("button", { name: "Open a project…" });
    await userEvent.keyboard("{Meta>},{/Meta}");
    await screen.findByRole("heading", { name: "Settings" });

    const field = document.createElement("textarea");
    const editor = document.createElement("div");
    editor.className = "cm-editor";
    editor.tabIndex = 0;
    const handled = document.createElement("div");
    handled.tabIndex = 0;
    handled.addEventListener("keydown", (e) => e.preventDefault());
    document.body.append(field, editor, handled);
    for (const target of [field, editor, handled]) {
      target.focus();
      await userEvent.keyboard("{Meta>}[[{/Meta}");
      expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
    }
    document.body.focus();
    await userEvent.keyboard("{Meta>}[[{/Meta}");
    expect(await screen.findByRole("button", { name: "Open a project…" })).toBeInTheDocument();
    field.remove();
    editor.remove();
    handled.remove();
  });
});

describe("theme", () => {
  it("keeps every control in step, and follows the system only while asked to", async () => {
    let systemChanged: () => void = () => {};
    const media = {
      matches: false,
      addEventListener: (_: string, listener: () => void) => {
        systemChanged = listener;
      },
      removeEventListener: () => {},
    };
    window.matchMedia = vi.fn(() => media) as unknown as typeof window.matchMedia;
    initTheme();
    function Picker({ where }: { where: string }) {
      const [theme, setTheme] = useTheme();
      return (
        <button type="button" onClick={() => setTheme(theme === "dark" ? "system" : "dark")}>
          {where}: {theme}
        </button>
      );
    }
    render(
      <>
        <Picker where="sidebar" />
        <Picker where="settings" />
      </>,
    );
    expect(document.documentElement.dataset.theme).toBe("light");

    await userEvent.click(screen.getByRole("button", { name: "settings: system" }));
    expect(screen.getByRole("button", { name: "sidebar: dark" })).toBeInTheDocument();
    expect(document.documentElement.dataset.theme).toBe("dark");
    // A chosen theme ignores the system.
    media.matches = false;
    act(() => systemChanged());
    expect(document.documentElement.dataset.theme).toBe("dark");

    await userEvent.click(screen.getByRole("button", { name: "sidebar: dark" }));
    expect(screen.getByRole("button", { name: "settings: system" })).toBeInTheDocument();
    expect(document.documentElement.dataset.theme).toBe("light");
    media.matches = true;
    act(() => systemChanged());
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});

const project = {
  id: "p1",
  name: "billing-service",
  path: "~/code/billing-service",
  exists: true,
  lastOpenedAt: "2026-10-01T00:00:00Z",
  exclusions: [],
  sample: false,
  summary: null,
} satisfies ProjectRecord;

function library(overrides: Partial<Source> = {}): Source {
  return {
    id: "team",
    name: "Team skills",
    kind: "git",
    role: "team",
    location: "https://github.com/acme/skills.git",
    subdir: null,
    tracked: { kind: "default" },
    createdAt: "2026-10-01T00:00:00Z",
    snapshot: "abc",
    snapshotAt: "2026-10-01T00:00:00Z",
    commitSummary: null,
    lastAttemptAt: null,
    lastError: null,
    warning: null,
    freshness: "current",
    sample: false,
    skillCount: 12,
    preview: false,
    catalogId: null,
    include: [],
    exclude: [],
    defaultBranch: null,
    ...overrides,
  };
}

describe("the start screen", () => {
  it("leads with one action", async () => {
    handlers.recent_projects = () => [project];
    handlers.list_sources = () => [library(), library({ id: "docs", name: "Docs", skillCount: 3 })];
    handlers.list_skills = () => [skill().summary, { ...skill().summary, id: "k2" }];
    const { container } = wrap(<Welcome />);
    expect(await screen.findByRole("button", { name: "Open a project…" })).toBeInTheDocument();
    expect(container.querySelectorAll(".btn-primary")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Open a project…" })).toHaveClass("btn-primary");
    // Counts come with the library list; no library index is read for them.
    expect(screen.getByTitle("Team skills · team · 12 skills")).toBeInTheDocument();
    expect(invoke.mock.calls.some(([cmd]) => cmd === "library")).toBe(false);
    // With projects, the first-run choices step aside.
    expect(screen.queryByRole("button", { name: "try the sample workspace" })).toBeNull();
  });

  it("waits for the projects instead of flashing the first-run screen", async () => {
    let answer: (projects: ProjectRecord[]) => void = () => {};
    handlers.recent_projects = () => new Promise((resolve) => (answer = resolve));
    wrap(<Welcome />);
    expect(screen.getByText("Loading your projects…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "try the sample workspace" })).toBeNull();

    await act(async () => answer([project]));
    expect(await screen.findByText("billing-service")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "try the sample workspace" })).toBeNull();
  });

  it("says when the projects cannot be listed, and tries again", async () => {
    let fail = true;
    handlers.recent_projects = () => {
      if (fail) throw { code: "internal", message: "database is locked" };
      return [project];
    };
    wrap(<Welcome />);
    expect(await screen.findByText("Habi could not list your projects")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "try the sample workspace" })).toBeNull();
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("billing-service")).toBeInTheDocument();
  });
});

describe("the project list", () => {
  it("removes any project from the list, without touching its folder, and leaves it if open", async () => {
    let listed = [project, { ...project, id: "p2", name: "web-app", path: "~/code/web-app" }];
    handlers.recent_projects = () => listed;
    handlers.forget_project = vi.fn(({ projectId }) => {
      listed = listed.filter((p) => p.id !== projectId);
      return null;
    });
    function Where() {
      const { route } = useNav();
      return <p>on {route.name}</p>;
    }
    wrap(
      <>
        <Sidebar onOpenPalette={() => {}} />
        <Where />
      </>,
      { name: "project", projectId: "p1", tab: "recommendations" },
    );
    // Every project can be removed, not only one whose folder is missing.
    expect(await screen.findByRole("button", { name: "Remove web-app from the list" })).toBeInTheDocument();
    const remove = screen.getByRole("button", { name: "Remove billing-service from the list" });
    expect(remove).toHaveAttribute("title", "Remove from list — nothing on disk is deleted");
    await userEvent.click(remove);
    expect(handlers.forget_project).toHaveBeenCalledWith({ projectId: "p1" });
    expect(
      await screen.findByText(/billing-service removed from the list. Nothing on disk/),
    ).toBeInTheDocument();
    expect(screen.getByText("on welcome")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Remove billing-service from the list" })).toBeNull(),
    );
  });
});

describe("the sample workspace", () => {
  function Where() {
    const { route } = useNav();
    return <p>on {route.name}</p>;
  }

  it("is labeled in its projects, and removed only after confirming", async () => {
    const sampleProject = { ...billing.project, sample: true };
    handlers.project_overview = () => ({ ...billing, project: sampleProject });
    handlers.watch_project = () => null;
    handlers.unwatch_project = () => null;
    handlers.remove_sample_workspace = vi.fn(() => null);
    wrap(
      <>
        <ProjectView projectId={sampleProject.id} tab="evidence" />
        <Where />
      </>,
      { name: "project", projectId: sampleProject.id, tab: "evidence" },
    );
    expect(await screen.findByText("You're looking at sample data.")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Remove sample workspace" }));
    const dialog = screen.getByRole("dialog", { name: "Remove the sample workspace?" });
    expect(dialog).toHaveAccessibleDescription(/Your own projects, libraries and skills are not touched/);
    expect(handlers.remove_sample_workspace).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole("button", { name: "Remove sample workspace" }));
    expect(handlers.remove_sample_workspace).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/Sample workspace removed/)).toBeInTheDocument();
    expect(screen.getByText("on welcome")).toBeInTheDocument();
  });

  it("is offered in the palette, and its removal only while it exists", async () => {
    Element.prototype.scrollIntoView = () => {};
    globalThis.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    const view = wrap(<CommandPalette open onOpenChange={() => {}} />);
    expect(await screen.findByRole("option", { name: "Try the sample workspace" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Remove sample workspace…" })).toBeNull();
    view.unmount();

    handlers.list_sources = () => [library({ sample: true })];
    wrap(<CommandPalette open onOpenChange={() => {}} />);
    expect(await screen.findByRole("option", { name: "Remove sample workspace…" })).toBeInTheDocument();
  });
});

describe("project history", () => {
  it("shows an unreadable operation record as needing attention, without made-up details", async () => {
    handlers.history = () => [
      {
        id: "op-1",
        title: "Unreadable operation record",
        action: "unreadable",
        state: "needsAttention",
        createdAt: "",
        finishedAt: null,
        files: [],
        problems: ["Habi could not read the record of this operation (EOF while parsing)."],
      },
    ];
    wrap(<InstalledView overview={billing as unknown as ProjectOverview} />, {
      name: "project",
      projectId: billing.project.id,
      tab: "installed",
    });
    expect(await screen.findByText("Unreadable operation record")).toBeInTheDocument();
    expect(screen.getByText("needs attention")).toBeInTheDocument();
    expect(screen.getByText(/could not read the record of this operation/)).toBeInTheDocument();
    expect(screen.getByText("files not known")).toBeInTheDocument();
    expect(screen.queryByText(/never/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Restore…" })).toBeNull();
  });
});

describe("free up space", () => {
  it("says what was removed and how much space it freed", async () => {
    handlers.app_info = () => ({ version: "0.1.0", dataDir: "~/habi", startupError: null });
    handlers.get_settings = () => ({ autoRefreshHours: 12, defaultClients: ["claude-code"] });
    handlers.free_up_space = vi.fn(() => ({
      operationsRemoved: 0,
      snapshotsRemoved: 2,
      objectsRemoved: 12,
      bytesFreed: 3_565_158,
      skippedBusy: 1,
    }));
    wrap(<SettingsView />, { name: "settings" });
    await userEvent.click(await screen.findByRole("button", { name: "Free up space" }));
    expect(handlers.free_up_space).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByText(
        "Removed 2 old library snapshots and 12 stored file versions, freed 3.4 MB. 1 project or library was in use and skipped; try again later.",
      ),
    ).toBeInTheDocument();
    // Without a sample workspace, there is nothing to remove.
    expect(screen.queryByRole("button", { name: "Remove sample workspace…" })).toBeNull();
  });
});

describe("connecting a library", () => {
  it("does not leave a library behind when its fetch failed and the user leaves", async () => {
    const source = { id: "s1", name: "skills" } as Source;
    handlers.add_source = () => source;
    handlers.refresh_source = () => {
      throw { code: "gitNetwork", message: "could not reach github.com" };
    };
    handlers.remove_source = vi.fn(() => null);
    const onConnected = vi.fn();
    const view = wrap(<ConnectLibrary onConnected={onConnected} />);
    await userEvent.type(screen.getByLabelText("Repository URL"), "https://github.com/acme/skills.git");
    await userEvent.click(screen.getByRole("button", { name: "Connect library" }));
    expect(await screen.findByText("could not reach github.com")).toBeInTheDocument();
    expect(handlers.remove_source).not.toHaveBeenCalled();

    view.unmount();
    await waitFor(() => expect(handlers.remove_source).toHaveBeenCalledWith({ sourceId: "s1" }));
    expect(onConnected).not.toHaveBeenCalled();
  });

  it("keeps a library that was fetched", async () => {
    const source = { id: "s1", name: "skills" } as Source;
    handlers.add_source = () => source;
    handlers.refresh_source = () => ({ source, changed: true });
    handlers.library = () => ({ items: [] });
    handlers.remove_source = vi.fn(() => null);
    const onConnected = vi.fn();
    const view = wrap(<ConnectLibrary onConnected={onConnected} />);
    await userEvent.type(screen.getByLabelText("Repository URL"), "https://github.com/acme/skills.git");
    await userEvent.click(screen.getByRole("button", { name: "Connect library" }));
    await waitFor(() => expect(onConnected).toHaveBeenCalled());
    view.unmount();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(handlers.remove_source).not.toHaveBeenCalled();
  });
});

describe("connecting your own library", () => {
  it("reads an address the way a person would say it", () => {
    expect(locationParts("git@github.com:acme/team-skills.git")).toEqual({
      host: "github.com",
      repo: "acme/team-skills",
    });
    expect(locationParts("https://gitlab.example.com/platform/ai/skills.git/")).toEqual({
      host: "gitlab.example.com",
      repo: "platform/ai/skills",
    });
    expect(locationParts("ssh://git@host.example/acme/skills")).toEqual({
      host: "host.example",
      repo: "acme/skills",
    });
    expect(locationParts("/Users/me/skills")).toEqual({ host: null, repo: "/Users/me/skills" });
    expect(locationParts("   ")).toBeNull();
  });

  it("says the whole form as one sentence, filling its blanks as they are known", async () => {
    wrap(<ConnectLibrary onConnected={vi.fn()} />);
    const sentence = () =>
      (document.querySelector(".connect-sentence")?.textContent ?? "").replace(/\s+/g, " ");
    expect(sentence()).toContain("Habi will read a repository");

    await userEvent.type(screen.getByLabelText("Repository URL"), "git@github.com:acme/team-skills.git");
    expect(sentence()).toContain("acme/team-skills on github.com");
    expect(sentence()).toContain("a team library");
    // The name is written over where it is read.
    const name = screen.getByLabelText("Shown as");
    expect(name).toHaveValue("team-skills");
    await userEvent.clear(name);
    await userEvent.type(name, "Team packs");
    expect(screen.getByLabelText("Shown as")).toHaveValue("Team packs");

    // Team is the answer unless it is changed, and the choice needs no heading to be understood.
    // Its heading is for screen readers only.
    expect(screen.getByText("Whose library is this?")).toHaveClass("visually-hidden");
    await userEvent.click(screen.getByRole("radio", { name: "Community" }));
    expect(sentence()).toContain("a community library");
    expect(screen.getByText(/not reviewed by your team/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "Your team's" }));
    expect(sentence()).toContain("a team library");
  });

  it("ends every station on a block that takes the spare room, so the three stand level", async () => {
    wrap(<ConnectLibrary onConnected={vi.fn()} />);
    const ends = () =>
      [...document.querySelectorAll(".station-body")].map((b) =>
        b.lastElementChild?.classList.contains("grow"),
      );
    expect(ends()).toEqual([true, true, true]);
    await userEvent.type(screen.getByLabelText("Repository URL"), "git@github.com:acme/team-skills.git");
    expect(ends()).toEqual([true, true, true]);
  });

  it("opens the chosen folder to show what is in it, before anything is connected", async () => {
    const candidate = (name: string, files: string[]) => ({
      path: name,
      name,
      title: name,
      description: `Does ${name}`,
      license: null,
      hasMetadata: false,
      files,
      size: 0,
      problems: [],
      complete: true,
      digest: name,
      duplicate: null,
      suggestedName: null,
    });
    handlers.pick_library_folder = () => "/Users/me/packs";
    handlers.inspect_import = vi.fn(() => ({
      origin: "packs",
      candidates: [
        candidate("review-pr", ["SKILL.md", "scripts/run.sh"]),
        candidate("release-notes", ["SKILL.md"]),
      ],
      notes: [],
    }));
    handlers.add_source = vi.fn();
    wrap(<ConnectLibrary mode="folder" onConnected={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /Choose a folder/ }));
    expect(await screen.findByText("skills found")).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "Skills found in the folder" });
    expect(within(list).getByText("review-pr")).toBeInTheDocument();
    expect(within(list).getByText("release-notes")).toBeInTheDocument();
    expect(screen.getByText(/1 has scripts/)).toBeInTheDocument();
    // Looking changed nothing: no library was added.
    expect(handlers.add_source).not.toHaveBeenCalled();
    expect(handlers.inspect_import).toHaveBeenCalledWith(
      expect.objectContaining({ from: { type: "folder", path: "/Users/me/packs" } }),
    );
  });

  it("draws the chosen folder's own tree, within the room it has", () => {
    const skill = (path: string, files: string[]) =>
      ({ path, name: path, files, problems: [], complete: true }) as unknown as Parameters<
        typeof treeOf
      >[1][number];
    expect(
      treeOf("packs", [
        skill("review-pr", ["SKILL.md", "scripts/run.sh", "scripts/lint.sh", "habi.yaml"]),
        skill("release-notes", ["SKILL.md"]),
      ]),
    ).toEqual([
      "packs/",
      "├─ review-pr/",
      "│  ├─ SKILL.md",
      "│  └─ habi.yaml",
      "└─ release-notes/",
      "   └─ SKILL.md",
    ]);

    // A folder that is itself one skill has its files directly under it.
    expect(treeOf("solo", [skill("", ["SKILL.md", "references/guide.md"])])).toEqual([
      "solo/",
      "├─ SKILL.md",
      "└─ references/",
    ]);

    // Many skills: the first few are shown, then how many more.
    const many = Array.from({ length: 40 }, (_, i) => skill(`s${i}`, ["SKILL.md"]));
    const lines = treeOf("big", many);
    expect(lines.length).toBeLessThanOrEqual(10);
    expect(lines.at(-1)).toMatch(/^└─ … \d+ more$/);
  });

  it("says so when the chosen folder holds no skills", async () => {
    handlers.pick_library_folder = () => "/Users/me/empty";
    handlers.inspect_import = () => ({
      origin: "empty",
      candidates: [],
      notes: ["No SKILL.md was found in this folder or the folders inside it."],
    });
    wrap(<ConnectLibrary mode="folder" onConnected={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /Choose a folder/ }));
    expect(await screen.findByText("No skills in here")).toBeInTheDocument();
    expect(screen.getByText(/Choose the folder that holds your skill folders/)).toBeInTheDocument();
  });

  it("keeps the occasional options out of the way: no name or subfolder field until wanted", async () => {
    wrap(<ConnectLibrary onConnected={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("Repository URL"), "https://github.com/acme/skills.git");
    expect(screen.queryByLabelText("Only this subfolder")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Only read a subfolder…" }));
    await userEvent.type(screen.getByLabelText("Only this subfolder"), "engineering/skills");
    expect(document.querySelector(".connect-sentence")?.textContent).toContain("engineering/skills");
  });

  it("sends the renamed library, and the narrowed subfolder, when connecting", async () => {
    const source = { id: "s1", name: "Packs" } as Source;
    const add = vi.fn(() => source);
    handlers.add_source = add;
    handlers.refresh_source = () => ({ source, changed: true });
    handlers.library = () => ({ items: [] });
    wrap(<ConnectLibrary onConnected={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("Repository URL"), "https://github.com/acme/skills.git");
    const name = screen.getByLabelText("Shown as");
    await userEvent.clear(name);
    await userEvent.type(name, "Packs");
    await userEvent.click(screen.getByRole("button", { name: "Only read a subfolder…" }));
    await userEvent.type(screen.getByLabelText("Only this subfolder"), "engineering/skills");
    await userEvent.click(screen.getByRole("button", { name: "Connect library" }));
    await waitFor(() => expect(add).toHaveBeenCalled());
    expect(add.mock.calls[0]).toEqual([
      { source: expect.objectContaining({ name: "Packs", subdir: "engineering/skills" }) },
    ]);
  });

  it("opens the later steps only once there is an address to read", async () => {
    wrap(<ConnectLibrary onConnected={vi.fn()} />);
    expect(screen.getByRole("group", { name: "How to read it" })).toBeDisabled();
    expect(screen.getByRole("group", { name: "What it becomes" })).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Repository URL"), "git@github.com:acme/team-skills.git");
    expect(screen.getByRole("group", { name: "How to read it" })).toBeEnabled();
    expect(screen.getByRole("group", { name: "What it becomes" })).toBeEnabled();
  });

  it("follows the latest release when asked, and says so before connecting", async () => {
    const source = { id: "s1", name: "skills" } as Source;
    const add = vi.fn(() => source);
    handlers.add_source = add;
    handlers.refresh_source = () => ({ source, changed: true });
    handlers.library = () => ({ items: [] });
    wrap(<ConnectLibrary onConnected={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("Repository URL"), "https://github.com/acme/skills.git");
    await userEvent.click(screen.getByRole("radio", { name: "Latest release" }));
    expect(document.querySelector(".connect-sentence")?.textContent).toContain("at its newest release");
    await userEvent.click(screen.getByRole("button", { name: "Connect library" }));
    await waitFor(() => expect(add).toHaveBeenCalled());
    expect(add.mock.calls[0]).toEqual([
      { source: expect.objectContaining({ tracked: { kind: "latestRelease" } }) },
    ]);
  });

  it("needs a branch name before it connects a branch", async () => {
    wrap(<ConnectLibrary onConnected={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("Repository URL"), "https://github.com/acme/skills.git");
    await userEvent.click(screen.getByRole("radio", { name: "A branch" }));
    expect(screen.getByRole("button", { name: "Connect library" })).toBeDisabled();
    await userEvent.type(screen.getByLabelText("branch name"), "release");
    expect(screen.getByRole("button", { name: "Connect library" })).toBeEnabled();
  });
});

describe("toasts and dialogs", () => {
  it("announces errors at once, and keeps a hovered toast until the pointer leaves", async () => {
    vi.useFakeTimers();
    function Shout() {
      const toast = useToast();
      return (
        <>
          <button type="button" onClick={() => toast.show("Copied")}>
            ok
          </button>
          <button type="button" onClick={() => toast.show("Not saved", "danger")}>
            fail
          </button>
        </>
      );
    }
    render(
      <ToastProvider>
        <Shout />
      </ToastProvider>,
    );
    act(() => screen.getByRole("button", { name: "fail" }).click());
    expect(screen.getByRole("alert")).toHaveTextContent("Not saved");
    act(() => screen.getByRole("button", { name: "ok" }).click());
    const copied = screen.getByText("Copied").parentElement as HTMLElement;
    expect(copied).not.toHaveAttribute("role");

    act(() => copied.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    act(() => vi.advanceTimersByTime(10_000));
    expect(screen.getByText("Copied")).toBeInTheDocument();
    act(() => copied.dispatchEvent(new MouseEvent("mouseout", { bubbles: true })));
    act(() => vi.advanceTimersByTime(6_000));
    expect(screen.queryByText("Copied")).toBeNull();
    expect(screen.getByText("Not saved")).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("describes a dialog by its description, when it has one", () => {
    render(
      <Dialog open onOpenChange={() => {}} title="Remove" description="Nothing is deleted from disk.">
        <p>body</p>
      </Dialog>,
    );
    expect(screen.getByRole("dialog", { name: "Remove" })).toHaveAccessibleDescription(
      "Nothing is deleted from disk.",
    );
  });
});

describe("opening a project", () => {
  function overviewOf(client: QueryClient) {
    return renderHook(() => useOverview(billing.project.id), {
      wrapper: ({ children }) => (
        <StrictMode>
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        </StrictMode>
      ),
    });
  }
  // Each inspection can be cancelled by its job id until it finishes.
  function inspections(fail: (call: number) => boolean = () => false) {
    const running = new Map<string, (error: unknown) => void>();
    let calls = 0;
    handlers.project_overview = ({ jobId }) => {
      calls += 1;
      const call = calls;
      return new Promise((resolve, reject) => {
        running.set(String(jobId), reject);
        if (fail(call))
          setTimeout(() => reject({ code: "cancelled", message: "the operation was cancelled" }));
        else setTimeout(() => resolve(billing), 30);
      });
    };
    handlers.cancel_job = ({ jobId }) => {
      running.get(String(jobId))?.({ code: "cancelled", message: "the operation was cancelled" });
      return true;
    };
    return () => calls;
  }

  it("inspects again after leaving mid-inspection and coming back, not 'cancelled'", async () => {
    const calls = inspections();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const first = overviewOf(client);
    await waitFor(() => expect(calls()).toBe(1));
    first.unmount();
    const { result } = overviewOf(client);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it("starts again once when stopped by anything but the person, and stays stopped when they cancel", async () => {
    const calls = inspections((call) => call === 1);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = overviewOf(client);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(calls()).toBe(2);

    const cancelled = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    inspections();
    const mine = overviewOf(cancelled);
    await waitFor(() => expect(mine.result.current.isFetching).toBe(true));
    act(() => mine.result.current.cancel());
    await waitFor(() => expect(mine.result.current.isError).toBe(true));
    expect((mine.result.current.error as HabiError).code).toBe("cancelled");
  });
});
