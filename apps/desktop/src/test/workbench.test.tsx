import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Plan } from "../bindings/Plan";
import type { ProjectOverview } from "../bindings/ProjectOverview";
import { ToastProvider } from "../components/Toasts";
import { type Actions, ActionsContext } from "../lib/actions";
import { NavProvider, useNav } from "../lib/nav";
import { Workbench } from "../views/project/Workbench";
import { ReviewDialog } from "../views/review/ReviewDialog";
import billing from "./fixtures/overview-billing-service.json";
import monorepo from "./fixtures/overview-platform-monorepo.json";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const actions: Actions = {
  openProject: vi.fn(async () => undefined),
  newSkill: vi.fn(),
  addSkills: vi.fn(),
};

function wrap(ui: ReactNode, projectId: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <NavProvider initial={{ name: "project", projectId, tab: "recommendations" }}>
          <ActionsContext.Provider value={actions}>{ui}</ActionsContext.Provider>
        </NavProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

function RoutedWorkbench({ overview }: { overview: ProjectOverview }) {
  const { route } = useNav();
  return <Workbench overview={overview} itemKey={route.name === "project" ? route.itemKey : undefined} />;
}

function row(name: string): HTMLElement {
  const found = screen
    .getAllByRole("button", { name: new RegExp(name) })
    .find((b) => b.classList.contains("rec-row"));
  if (!found) throw new Error(`no row ${name}`);
  return found;
}

const billingOverview = billing as unknown as ProjectOverview;
const monoOverview = monorepo as unknown as ProjectOverview;

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "get_settings") return { autoRefreshHours: 12, defaultClients: ["claude-code"] };
    throw { code: "notFound", message: `no mock for ${cmd}` };
  });
});

describe("workbench", () => {
  it("groups recommendations and keeps inapplicable items available but collapsed", () => {
    wrap(<RoutedWorkbench overview={billingOverview} />, billingOverview.project.id);
    const fits = screen.getByRole("heading", { name: /Fits this project/ });
    const group = fits.closest("section");
    expect(group).not.toBeNull();
    expect(within(group as HTMLElement).getByText("Liquibase migration review")).toBeInTheDocument();
    const notApplicable = screen.getByRole("heading", { name: /Does not apply/ });
    const notApplicableGroup = notApplicable.closest("section") as HTMLElement;
    expect(notApplicableGroup.querySelector("ul")).toBeNull();
    expect(within(notApplicableGroup).getByRole("button", { name: "Show" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("collapses items without applicability rules and says which libraries they come from", async () => {
    const user = userEvent.setup();
    wrap(<RoutedWorkbench overview={billingOverview} />, billingOverview.project.id);
    const available = screen.getByRole("heading", { name: /Available to use manually/ });
    const group = available.closest("section") as HTMLElement;
    expect(group.querySelector("ul")).toBeNull();
    expect(within(group).getByText(/From Example team library \(1\)/)).toBeInTheDocument();
    await user.click(within(group).getByRole("button", { name: "Show" }));
    expect(group.querySelector("ul")).not.toBeNull();
  });

  it("explains why an item fits, down to the file and line", async () => {
    const user = userEvent.setup();
    wrap(<RoutedWorkbench overview={billingOverview} />, billingOverview.project.id);
    await user.click(row("Liquibase migration review"));
    expect(screen.getByRole("heading", { name: "Liquibase migration review", level: 2 })).toBeInTheDocument();
    const facets = screen.getByLabelText("Status");
    expect(within(facets).getByText("Applies")).toBeInTheDocument();
    expect(within(facets).getByText("Not installed")).toBeInTheDocument();
    // Evidence chips name the exact manifest location.
    expect(screen.getAllByRole("button", { name: /pom\.xml:\d+/ }).length).toBeGreaterThan(0);
  });

  it("separates readiness from applicability", async () => {
    const user = userEvent.setup();
    wrap(<RoutedWorkbench overview={monoOverview} />, monoOverview.project.id);
    await user.click(row("GitHub PR summary"));
    const facets = screen.getByLabelText("Status");
    expect(within(facets).getByText("Applies")).toBeInTheDocument();
    expect(within(facets).getByText("Prerequisite missing")).toBeInTheDocument();
    // Listed under prerequisites, and named in the note next to the install button.
    expect(screen.getAllByText(/MCP server github/)).toHaveLength(2);
    expect(screen.getByText(/Installing can add the suggested MCP configuration/)).toBeInTheDocument();
  });

  it("moves through the list with the arrow keys", async () => {
    const user = userEvent.setup();
    wrap(<RoutedWorkbench overview={billingOverview} />, billingOverview.project.id);
    const rows = screen.getAllByRole("button").filter((b) => b.classList.contains("rec-row"));
    const first = rows[0] as HTMLElement;
    first.focus();
    await user.keyboard("{ArrowDown}");
    const active = document.querySelector(".rec-row.is-active");
    expect(active).toBe(rows[1]);
  });

  it("has no detectable accessibility violations", async () => {
    const { container } = wrap(<RoutedWorkbench overview={monoOverview} />, monoOverview.project.id);
    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  });
});

describe("review dialog", () => {
  const plan: Plan = {
    id: "plan-1",
    action: "install",
    title: "Install for Claude Code in this project",
    project: "~/work/billing-service",
    createdAt: "2026-10-02T00:00:00Z",
    items: [
      {
        key: "k",
        title: "JPA entity review",
        kind: "skill",
        source: "Team",
        version: "abc",
        clients: ["claude-code"],
        notes: [],
      },
    ],
    changes: [],
    conflicts: [
      {
        path: ".claude/skills/jpa-entity-review/SKILL.md",
        kind: "unmanagedContent",
        item: "JPA entity review",
        message: "It already exists and was not installed by Habi.",
        options: ["keep", "overwrite"],
        diff: null,
      },
    ],
    notes: [],
    recovery: "Restore from history.",
  };

  it("requires a decision for every conflict before applying", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation(async (cmd: string, args: { decisions?: Record<string, string> }) => {
      if (cmd === "get_settings") return { autoRefreshHours: 12, defaultClients: ["claude-code"] };
      if (cmd === "plan_install") {
        const decided = Object.keys(args.decisions ?? {}).length > 0;
        return decided
          ? {
              ...plan,
              conflicts: [],
              changes: [
                {
                  path: ".claude/skills/jpa-entity-review/SKILL.md",
                  op: "modify",
                  kind: "skillFile",
                  items: ["JPA entity review"],
                  clients: ["claude-code"],
                  before: "sha256:a",
                  after: "sha256:b",
                  explanation: "Claude Code reads skills from .claude/skills.",
                  diff: { hunks: [], added: 3, removed: 1, binary: false, truncated: false },
                },
              ],
            }
          : plan;
      }
      throw { code: "notFound", message: cmd };
    });
    wrap(
      <ReviewDialog
        projectId="p"
        request={{
          kind: "install",
          items: [{ sourceId: "s", itemId: "jpa-entity-review" }],
          title: "JPA entity review",
        }}
        onClose={() => {}}
      />,
      "p",
    );
    expect(await screen.findByText(/1 decision needed/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: plan.title })).toBeNull();
    await user.click(screen.getByRole("radio", { name: "Use the team version" }));
    const apply = await screen.findByRole("button", { name: plan.title });
    expect(apply).toBeEnabled();
    expect(screen.getByText(/1 file will change/)).toBeInTheDocument();
    // Scope is stated plainly.
    expect(screen.getByText(/this project only/)).toBeInTheDocument();
  });
});
