import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import type { LocalSkill } from "../bindings/LocalSkill";
import type { ProjectRecord } from "../bindings/ProjectRecord";
import type { Source } from "../bindings/Source";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { ToastProvider } from "../components/Toasts";
import { type Actions, ActionsContext } from "../lib/actions";
import { HabiError } from "../lib/api";
import { guardWindowClose } from "../lib/closing";
import { NavProvider, type Route, useNav } from "../lib/nav";
import { initTheme, useTheme } from "../lib/theme";
import { useAutosave } from "../lib/useAutosave";
import { SkillEditor } from "../views/skills/SkillEditor";
import { ConnectLibrary } from "../views/sources/ConnectLibrary";
import { Welcome } from "../views/Welcome";

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
    if (["recent_projects", "list_skills", "list_sources", "list_contributions"].includes(cmd)) return [];
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
    wrap(<SkillEditor id="k" />, { name: "skills", skillId: "k" });

    const title = await screen.findByLabelText("Skill title");
    await userEvent.type(title, " checklist");
    await userEvent.click(screen.getByRole("button", { name: "Export…" }));

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
        <SkillEditor id="k" />
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

describe("the start screen", () => {
  it("waits for the projects instead of flashing the first-run screen", async () => {
    let answer: (projects: ProjectRecord[]) => void = () => {};
    handlers.recent_projects = () => new Promise((resolve) => (answer = resolve));
    wrap(<Welcome />);
    expect(screen.getByText("Loading your projects…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Explore a sample workspace" })).toBeNull();

    await act(async () => answer([project]));
    expect(await screen.findByText("billing-service")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Explore a sample workspace" })).toBeNull();
  });

  it("says when the projects cannot be listed, and tries again", async () => {
    let fail = true;
    handlers.recent_projects = () => {
      if (fail) throw { code: "internal", message: "database is locked" };
      return [project];
    };
    wrap(<Welcome />);
    expect(await screen.findByText("Habi could not list your projects")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Explore a sample workspace" })).toBeNull();
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("billing-service")).toBeInTheDocument();
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
