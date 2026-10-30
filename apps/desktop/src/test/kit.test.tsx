import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectOverview } from "../bindings/ProjectOverview";
import type { Suggestion } from "../bindings/Suggestion";
import { ToastProvider } from "../components/Toasts";
import { type Actions, ActionsContext } from "../lib/actions";
import { NavProvider } from "../lib/nav";
import { Kit } from "../views/project/Kit";
import billing from "./fixtures/overview-billing-service.json";
import planInstall from "./fixtures/plan-install.json";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const actions: Actions = {
  openProject: vi.fn(async () => undefined),
  newSkill: vi.fn(),
  addSkills: vi.fn(),
  showWelcome: vi.fn(),
};

const overview = billing as unknown as ProjectOverview;

/** The same overview once every catalog library in its kit is connected. */
function connected(): ProjectOverview {
  return {
    ...overview,
    kit: {
      ...overview.kit,
      suggestions: overview.kit.suggestions.map((s) =>
        s.library.connected
          ? s
          : {
              ...s,
              library: { ...s.library, connected: true, sourceId: `src-${s.library.entryId}` },
              item: { sourceId: `src-${s.library.entryId}`, itemId: s.name },
            },
      ),
    },
  };
}

function wrap(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <NavProvider initial={{ name: "project", projectId: overview.project.id, tab: "suggested" }}>
          <ActionsContext.Provider value={actions}>{ui}</ActionsContext.Provider>
        </NavProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

function knot(title: string): HTMLInputElement {
  return screen.getByRole("checkbox", { name: `Add ${title}` }) as HTMLInputElement;
}

const cart = () => screen.getByRole("complementary", { name: `Add to ${overview.project.name}` });

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "get_settings") return { autoRefreshHours: 12 };
    if (cmd === "list_sources") return [];
    if (cmd === "connect_catalog_entry") return { id: `src-${args.entryId}`, name: args.entryId };
    if (cmd === "project_overview") return connected();
    if (cmd === "detected_clients") return ["claude-code"];
    if (cmd === "plan_install") return planInstall;
    if (cmd === "machine_skills") return [];
    if (cmd === "cancel_job") return true;
    throw { code: "notFound", message: `no mock for ${cmd}` };
  });
});

/** The overview with these changes to suggestions, by title. */
function withSuggestions(change: (s: Suggestion) => Suggestion): ProjectOverview {
  return { ...overview, kit: { ...overview.kit, suggestions: overview.kit.suggestions.map(change) } };
}

describe("the kit", () => {
  it("says what fits and why, and whose word it is when it is not Habi's pick", async () => {
    wrap(<Kit overview={overview} onAll={vi.fn()} />);
    const count = overview.kit.suggestions.filter((s) => !s.installed).length;
    expect(screen.getByRole("heading", { name: `${count} skills for billing-service` })).toBeInTheDocument();
    const team = screen.getByRole("region", { name: "Your team requires" });
    expect(within(team).getAllByText("Team requirement")).toHaveLength(2);
    const stack = screen.getByRole("region", { name: "For this stack" });
    // The team's own rules say so; Habi's picks need no word, the page is Habi's picks.
    expect(within(stack).getAllByText("Author's rule").length).toBeGreaterThan(0);
    expect(within(stack).getByText("Uses Spring Boot (pom.xml:6)")).toBeInTheDocument();
    expect(within(stack).queryByText("Habi's pick")).toBeNull();
    // Practices carry Habi's reason in place of a rule.
    const practice = screen.getByRole("region", { name: "For how you work" });
    expect(within(practice).getByText("Any codebase, when something breaks")).toBeInTheDocument();
    const results = await axe.run(document.body, { rules: { region: { enabled: false } } });
    expect(results.violations).toEqual([]);
  });

  it("connects only the libraries the chosen skills need", async () => {
    const user = userEvent.setup();
    wrap(<Kit overview={overview} onAll={vi.fn()} />);
    expect(within(cart()).getByText("GitHub")).toBeInTheDocument();
    await user.click(knot("Spring Boot testing"));
    expect(knot("Spring Boot testing").checked).toBe(false);
    // Nothing else chosen comes from GitHub's library, so it is not connected.
    expect(within(cart()).queryByText("GitHub")).toBeNull();
    expect(within(cart()).getByText("Sentry")).toBeInTheDocument();
  });

  it("connects what is needed, then opens the review with every chosen skill", async () => {
    const user = userEvent.setup();
    wrap(<Kit overview={overview} onAll={vi.fn()} />);
    await user.click(knot("Grill the plan"));
    const chosen = overview.kit.suggestions.filter((s) => !s.installed && s.title !== "Grill the plan");
    expect(within(cart()).getByText(`${chosen.length} skills`)).toBeInTheDocument();
    await user.click(within(cart()).getByRole("button", { name: "Review and add…" }));
    await screen.findByRole("dialog");
    const connects = invoke.mock.calls
      .filter(([cmd]) => cmd === "connect_catalog_entry")
      .map(([, a]) => a.entryId);
    expect(connects.sort()).toEqual(["github", "mattpocock", "sentry", "superpowers"]);
    const plan = invoke.mock.calls.find(([cmd]) => cmd === "plan_install");
    expect(plan?.[1].items).toHaveLength(chosen.length);
    expect(plan?.[1].items).toContainEqual({ sourceId: "src-sentry", itemId: "gha-security-review" });
    expect(plan?.[1].items).not.toContainEqual({ sourceId: "src-mattpocock", itemId: "grilling" });
  });

  it("says when everything Habi suggests is already there", () => {
    const done: ProjectOverview = {
      ...overview,
      kit: { ...overview.kit, suggestions: overview.kit.suggestions.map((s) => ({ ...s, installed: true })) },
    };
    wrap(<Kit overview={done} onAll={vi.fn()} />);
    expect(
      screen.getByRole("heading", { name: "billing-service has everything Habi suggests" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(screen.getAllByText("Added")).toHaveLength(overview.kit.suggestions.length);
  });

  it("stops when asked, leaves what was connected, and opens no review", async () => {
    const user = userEvent.setup();
    let release: () => void = () => undefined;
    invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === "connect_catalog_entry") {
        await new Promise<void>((r) => {
          release = r;
        });
        return { id: `src-${args.entryId}`, name: args.entryId };
      }
      if (cmd === "machine_skills") return [];
      if (cmd === "cancel_job") return true;
      if (cmd === "get_settings") return { autoRefreshHours: 12 };
      if (cmd === "list_sources") return [];
      throw { code: "notFound", message: `no mock for ${cmd}` };
    });
    wrap(<Kit overview={overview} onAll={vi.fn()} />);
    await user.click(within(cart()).getByRole("button", { name: "Review and add…" }));
    const stop = await within(cart()).findByRole("button", { name: "Cancel" });
    // Focus goes to what can be done now.
    expect(stop).toHaveFocus();
    await user.click(stop);
    release();
    expect(
      await within(cart()).findByText(/Stopped\. Libraries already connected stay connected/),
    ).toBeVisible();
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "connect_catalog_entry")).toHaveLength(1);
    expect(invoke.mock.calls.some(([cmd]) => cmd === "cancel_job")).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("stops connecting when the person leaves the page", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "connect_catalog_entry") return new Promise(() => undefined);
      if (cmd === "machine_skills") return [];
      if (cmd === "cancel_job") return true;
      if (cmd === "get_settings") return { autoRefreshHours: 12 };
      if (cmd === "list_sources") return [];
      throw { code: "notFound", message: `no mock for ${cmd}` };
    });
    const view = wrap(<Kit overview={overview} onAll={vi.fn()} />);
    await user.click(within(cart()).getByRole("button", { name: "Review and add…" }));
    await within(cart()).findByRole("button", { name: "Cancel" });
    view.unmount();
    const job = invoke.mock.calls.find(([cmd]) => cmd === "connect_catalog_entry")?.[1].jobId;
    expect(invoke).toHaveBeenCalledWith("cancel_job", expect.objectContaining({ jobId: job }));
  });

  it("says which chosen skills a library turned out not to have", async () => {
    const user = userEvent.setup();
    const gone = connected();
    gone.kit = {
      ...gone.kit,
      suggestions: gone.kit.suggestions.filter((s) => s.title !== "Spring Boot testing"),
    };
    invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === "connect_catalog_entry") return { id: `src-${args.entryId}`, name: args.entryId };
      if (cmd === "project_overview") return gone;
      if (cmd === "library") return { items: [] };
      if (cmd === "detected_clients") return ["claude-code"];
      if (cmd === "plan_install") return planInstall;
      if (cmd === "machine_skills") return [];
      if (cmd === "get_settings") return { autoRefreshHours: 12 };
      if (cmd === "list_sources") return [];
      throw { code: "notFound", message: `no mock for ${cmd}` };
    });
    wrap(<Kit overview={overview} onAll={vi.fn()} />);
    await user.click(within(cart()).getByRole("button", { name: "Review and add…" }));
    await screen.findByRole("dialog");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    // Still said once the review is closed.
    expect(within(cart()).getByText("Not found in its library: Spring Boot testing.")).toBeVisible();
  });

  it("puts what other projects use first, and says where", () => {
    wrap(
      <Kit
        overview={withSuggestions((s) =>
          s.title === "Diagnosing bugs" ? { ...s, elsewhere: ["nextshop"] } : s,
        )}
        onAll={vi.fn()}
      />,
    );
    const practice = screen.getByRole("region", { name: "For how you work" });
    expect(within(practice).getByText("Also in nextshop")).toBeInTheDocument();
  });

  it("leaves a skill already on this machine out unless chosen", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "machine_skills") return [{ name: "spring-boot-testing" }];
      if (cmd === "get_settings") return { autoRefreshHours: 12 };
      if (cmd === "list_sources") return [];
      throw { code: "notFound", message: `no mock for ${cmd}` };
    });
    wrap(<Kit overview={overview} onAll={vi.fn()} />);
    expect(await screen.findByText("On this machine")).toBeInTheDocument();
    expect(knot("Spring Boot testing").checked).toBe(false);
    await user.click(knot("Spring Boot testing"));
    expect(knot("Spring Boot testing").checked).toBe(true);
  });

  it("says plainly when there is nothing to suggest", () => {
    wrap(<Kit overview={{ ...overview, kit: { suggestions: [], more: 0 } }} onAll={vi.fn()} />);
    expect(
      screen.getByRole("heading", { name: "Nothing to suggest for billing-service yet" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Explore libraries/ })).toBeInTheDocument();
    expect(screen.queryByRole("complementary")).toBeNull();
  });
});
