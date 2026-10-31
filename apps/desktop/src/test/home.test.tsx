import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/Toasts";
import { type Actions, ActionsContext } from "../lib/actions";
import { NavProvider, useNav } from "../lib/nav";
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

function Where() {
  const { route, navigate } = useNav();
  return (
    <>
      <output>{JSON.stringify(route)}</output>
      <button type="button" onClick={() => navigate({ name: "welcome" })}>
        Home again
      </button>
    </>
  );
}

describe("home", () => {
  beforeEach(() => invoke.mockReset());

  it("gives a first run the whole headline and one action", async () => {
    home({});
    expect(await screen.findByText(/Find what applies/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Open a project/ })).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Projects" })).not.toBeInTheDocument();
  });

  it("leads with the project that needs you most, and keeps the privacy link", async () => {
    const quiet = project({ id: "p2", name: "orders-api" });
    const busy = project({ id: "p3", name: "platform-monorepo" });
    (busy.summary as { tally: unknown[] }).tally = [
      { sourceId: "team", fits: 9, described: 0, installed: [] },
    ];
    const { container } = home({
      projects: [quiet, busy],
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
    expect(await screen.findByRole("heading", { name: "platform-monorepo" })).toBeInTheDocument();
    expect(screen.getByText("Nine skills fit this project, and none are added yet.")).toBeInTheDocument();
    expect(container.querySelectorAll(".btn-primary")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Review 9 skills…" })).toHaveClass("btn-primary");
    expect(screen.getByRole("button", { name: /orders-api 2 skills fit, none added/ })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Gone could not be refreshed" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Fix it not sent yet" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Sent/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Find what applies/)).not.toBeInTheDocument();
    expect(screen.getByText("After that")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open another project…" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "What leaves this machine" })).toBeInTheDocument();
  });

  it("queues only what is waiting, since the sidebar lists every project", async () => {
    const waitingLess = project({ id: "p2", name: "orders-api" });
    const waitingMost = project({ id: "p3", name: "storefront-web" });
    (waitingMost.summary as { tally: unknown[] }).tally = [
      { sourceId: "team", fits: 4, described: 0, installed: [] },
    ];
    const lead = project({ id: "p4", name: "platform-monorepo" });
    (lead.summary as { tally: unknown[] }).tally = [
      { sourceId: "team", fits: 9, described: 0, installed: [] },
    ];
    const done = project({ id: "p5", name: "finished-service" });
    (done.summary as { tally: unknown[] }).tally = [
      { sourceId: "team", fits: 1, described: 0, installed: ["One"] },
    ];
    const empty = project({ id: "p6", name: "legacy-scripts" });
    (empty.summary as { tally: unknown[] }).tally = [];
    home({ projects: [done, empty, waitingLess, waitingMost, lead], sources: [team()] });
    const queue = await screen.findByRole("complementary", { name: "After that" });
    const names = [...queue.querySelectorAll(".front-rail-name")].map((n) => n.textContent);
    expect(names).toEqual(["storefront-web", "orders-api"]);
  });

  it("lists the skills the lead is missing, what the team requires first", async () => {
    const rec = (id: string, group: string, reason: string) => ({
      group,
      installState: "notInstalled",
      applicability: { applicability: "applies", reason },
      item: { key: `team/${id}`, title: id },
    });
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "app_info") return { gitAvailable: true };
      if (cmd === "recent_projects") return [project()];
      if (cmd === "project_overview")
        return {
          recommendations: [rec("fits", "relevant", "Uses Spring Boot"), rec("must", "required", "x")],
        };
      return [];
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
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
    const rows = await screen.findAllByRole("button", { name: /Your team requires it|Uses Spring Boot/ });
    expect(rows.map((r) => r.textContent)).toEqual(["must Your team requires it", "fits Uses Spring Boot"]);
  });

  it("takes you to the project to review, and to one skill from its row", async () => {
    const user = userEvent.setup();
    const rec = {
      group: "relevant",
      installState: "notInstalled",
      applicability: { applicability: "applies", reason: "Uses Spring Boot" },
      item: { key: "team/one", title: "One skill" },
    };
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "app_info") return { gitAvailable: true };
      if (cmd === "recent_projects") return [project()];
      if (cmd === "project_overview") return { recommendations: [rec] };
      return [];
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ToastProvider>
          <NavProvider initial={{ name: "welcome" }}>
            <ActionsContext.Provider value={actions}>
              <Welcome />
              <Where />
            </ActionsContext.Provider>
          </NavProvider>
        </ToastProvider>
      </QueryClientProvider>,
    );
    const where = () => JSON.parse(screen.getByRole("status").textContent ?? "{}");
    await user.click(await screen.findByRole("button", { name: "Review 2 skills…" }));
    expect(where()).toEqual({ name: "project", projectId: "p1", tab: "recommendations" });
    // Reviewing installs nothing by itself.
    expect(invoke.mock.calls.some(([cmd]) => String(cmd).startsWith("plan_") || cmd === "apply_plan")).toBe(
      false,
    );
    await user.click(await screen.findByRole("button", { name: /One skill/ }));
    expect(where()).toEqual({ name: "project", projectId: "p1", tab: "workbench", itemKey: "team/one" });
  });

  it("says when nothing is waiting anywhere", async () => {
    const done = project();
    (done.summary as { tally: unknown[] }).tally = [
      { sourceId: "team", fits: 2, described: 0, installed: ["One", "Two"] },
    ];
    home({ projects: [done], sources: [team()] });
    expect(await screen.findByText("Everything that fits is installed.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open billing-service" })).toHaveClass("btn-primary");
  });
});
