import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/Toasts";
import { type Actions, ActionsContext } from "../lib/actions";
import { NavProvider } from "../lib/nav";
import { Welcome } from "../views/Welcome";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const actions: Actions = {
  openProject: vi.fn(async () => {}),
  newSkill: vi.fn(),
  addSkills: vi.fn(),
  showWelcome: vi.fn(),
};

const project = (over: Record<string, unknown> = {}) => ({
  id: "p1",
  name: "billing-service",
  path: "~/work/billing-service",
  exists: true,
  lastOpenedAt: "2026-10-30T00:00:00Z",
  exclusions: [],
  summary: {
    fits: 2,
    described: 0,
    needsInformation: 0,
    sources: ["team"],
    installed: 0,
    languages: [],
    tally: [{ sourceId: "team", fits: 2, described: 0, installed: [] }],
    suggested: [],
    at: "2026-10-30T00:00:00Z",
  },
  ...over,
});

const team = (over: Record<string, unknown> = {}) => ({
  id: "team",
  name: "Team library",
  role: "team",
  snapshot: "abc",
  skillCount: 2,
  createdAt: "2026-10-01T00:00:00Z",
  lastError: null,
  ...over,
});

function home(data: { projects?: unknown[]; sources?: unknown[]; contributions?: unknown[] }) {
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "app_info") return { gitAvailable: true };
    if (cmd === "recent_projects") return data.projects ?? [];
    if (cmd === "list_sources") return data.sources ?? [];
    if (cmd === "list_contributions") return data.contributions ?? [];
    return [];
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <NavProvider initial={{ name: "welcome" }}>
          <ActionsContext.Provider value={actions}>
            <Welcome />
          </ActionsContext.Provider>
        </NavProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("home", () => {
  beforeEach(() => invoke.mockReset());

  it("gives a first run the whole headline, and nothing to wait for", async () => {
    home({});
    expect(await screen.findByText(/Find what applies/)).toBeInTheDocument();
    expect(screen.queryByText("Waiting for you")).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "How to read the loom" })).not.toBeInTheDocument();
  });

  it("shrinks the headline once there are projects, and says what waits", async () => {
    const { container } = home({
      projects: [project()],
      sources: [team(), team({ id: "gone", name: "Gone", lastError: { code: "x", message: "y" } })],
      contributions: [
        {
          id: "c1",
          state: "committed",
          sourceId: "team",
          origin: { type: "other" },
          form: { title: "Fix it" },
        },
        {
          id: "c2",
          state: "published",
          sourceId: "team",
          origin: { type: "other" },
          form: { title: "Sent" },
        },
      ],
    });
    expect(await screen.findByRole("region", { name: "Waiting for you" })).toBeInTheDocument();
    expect(container.querySelector(".home.is-returning")).not.toBeNull();
    expect(screen.queryByText(/Find what applies/)).not.toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: "billing-service 2 skills fit, none added" }),
    ).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Gone could not be refreshed" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Fix it not sent yet" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Sent/ })).not.toBeInTheDocument();
  });

  it("says nothing when nothing waits, and explains the loom's marks", async () => {
    const installed = project();
    (installed.summary as { installed: number }).installed = 1;
    home({ projects: [installed], sources: [team()] });
    const key = await screen.findByRole("list", { name: "How to read the loom" });
    expect(key).toHaveTextContent("Taut: installed");
    expect(key).toHaveTextContent("Slack: fits, not installed");
    expect(key).toHaveTextContent("One thread, one skill");
    // Only the marks that are on screen.
    expect(key).not.toHaveTextContent("community");
    expect(key).not.toHaveTextContent("shared back");
    expect(screen.queryByRole("region", { name: "Waiting for you" })).not.toBeInTheDocument();
  });
});
