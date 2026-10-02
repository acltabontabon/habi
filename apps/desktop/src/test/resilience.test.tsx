import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalSkill } from "../bindings/LocalSkill";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { ToastProvider } from "../components/Toasts";
import { type Actions, ActionsContext } from "../lib/actions";
import { HabiError } from "../lib/api";
import { guardWindowClose } from "../lib/closing";
import { NavProvider, type Route, useNav } from "../lib/nav";
import { useAutosave } from "../lib/useAutosave";
import { SkillEditor } from "../views/skills/SkillEditor";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

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
    if (cmd === "recent_projects" || cmd === "list_skills" || cmd === "list_sources") return [];
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
