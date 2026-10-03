import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogEntry } from "../bindings/CatalogEntry";
import type { LibraryIndex } from "../bindings/LibraryIndex";
import type { RepoFacts } from "../bindings/RepoFacts";
import type { Source } from "../bindings/Source";
import type { SourceUpdate } from "../bindings/SourceUpdate";
import type { UpdateReport } from "../bindings/UpdateReport";
import { ToastProvider } from "../components/Toasts";
import { type Actions, ActionsContext } from "../lib/actions";
import { setInspectorOpen } from "../lib/inspector";
import { NavProvider, type Route, useNav } from "../lib/nav";
import { SourcesView } from "../views/sources/SourcesView";
import catalogFixture from "./fixtures/catalog.json";
import previewedEntry from "./fixtures/catalog-entry-previewed.json";
import previewLibrary from "./fixtures/catalog-library-preview.json";
import previewSource from "./fixtures/catalog-source-preview.json";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const actions: Actions = {
  openProject: vi.fn(async () => {}),
  newSkill: vi.fn(),
  addSkills: vi.fn(),
  showWelcome: vi.fn(),
};

const catalog = catalogFixture as unknown as CatalogEntry[];
const library = previewLibrary as unknown as LibraryIndex;
const entryPreviewed = previewedEntry as unknown as CatalogEntry;
const sourcePreview = previewSource as unknown as Source;

/** The catalog entry as it is before anything is fetched. */
const entryUnfetched: CatalogEntry = {
  ...entryPreviewed,
  availability: "notFetched",
  sourceId: null,
  fetched: null,
  contents: null,
};
const entryConnected: CatalogEntry = { ...entryPreviewed, availability: "connected" };
const sourceConnected: Source = { ...sourcePreview, preview: false, name: "Acme", role: "community" };
/** The connected library, by its own address. */
const inLibrary = (more: Partial<Extract<Route, { name: "sources" }>> = {}): Route => ({
  name: "sources",
  sourceId: sourceConnected.id,
  ...more,
});

function Host() {
  const { route, navigate } = useNav();
  if (route.name !== "sources") return <p>elsewhere: {route.name}</p>;
  return (
    <>
      <button
        type="button"
        data-testid="pick-ci-review"
        aria-label="Test helper: pick CI review"
        onClick={() => navigate({ name: "sources", sourceId: sourceConnected.id, itemId: "ci-review" })}
      />
      <output data-testid="route">{JSON.stringify(route)}</output>
      <SourcesView
        sourceId={route.sourceId}
        entry={route.entry}
        view={route.view}
        itemId={route.itemId}
        file={route.file}
      />
    </>
  );
}

function wrap(initial: Route = { name: "sources" }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <NavProvider initial={initial}>
          <ActionsContext.Provider value={actions}>
            <Host />
          </ActionsContext.Provider>
        </NavProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const readInspector = () => sessionStorage.getItem("habi.packageInspector") === "open";
const route = () => JSON.parse(screen.getByTestId("route").textContent ?? "{}") as Route;

type World = {
  entry: CatalogEntry;
  sources: Source[];
  connectUnreachable?: boolean;
  /** The connection stays in flight until `release()` is called. */
  holdConnect?: boolean;
  /** Cancelling rejects the held connection, like the core does. */
  cancelRejects?: boolean;
  release?: () => void;
  cancel?: () => void;
  /** What GitHub said, if it could be asked. */
  facts?: RepoFacts | null;
  /** What the last check of the library's repository found. */
  update?: SourceUpdate | null;
  /** What the last update changed, until it is marked as seen. */
  report?: UpdateReport | null;
  /** The report an update leaves behind. */
  afterUpdate?: UpdateReport;
};

/** A stand-in for the core: what the catalog says changes as libraries are previewed and connected. */
function world(initial: World) {
  const state = { ...initial };
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string, args: Record<string, unknown> = {}) => {
    switch (cmd) {
      case "catalog":
        return state.entry.id === "acme" ? [state.entry] : catalog;
      case "list_sources":
        return state.sources;
      case "library":
        return library;
      case "item_detail": {
        const item = library.items.find((i) => i.id === args.itemId);
        return {
          item,
          source: state.entry.availability === "connected" ? sourceConnected : sourcePreview,
          libraryName: "Acme",
          body: "# Body\n\nDo it.\n",
        };
      }
      case "item_file":
        return { path: args.path, text: "#!/bin/sh\necho hi\n", size: 18, binary: false };
      case "connect_catalog_entry":
        if (state.holdConnect)
          await new Promise<void>((resolve, reject) => {
            state.release = resolve;
            state.cancel = () => reject({ code: "cancelled", message: "cancelled" });
          });
        if (state.connectUnreachable) throw { code: "gitNetwork", message: "could not reach github.com" };
        state.entry = entryConnected;
        state.sources = [sourceConnected];
        return sourceConnected;
      case "remove_source":
        state.entry = entryUnfetched;
        state.sources = [];
        return null;
      case "catalog_repo_facts":
        return state.facts ?? null;
      case "source_updates":
        return state.update ? [state.update] : [];
      case "check_source_update":
        return state.update ?? null;
      case "refresh_source":
        if (state.update) state.update = { ...state.update, available: false };
        state.report = state.afterUpdate ?? null;
        return { changed: true, source: sourceConnected };
      case "source_update_report":
        return state.report ?? null;
      case "dismiss_update_report":
        state.report = null;
        return null;
      case "recent_projects":
      case "list_skills":
        return [];
      case "catalog_fits":
        return [];
      case "cancel_job":
        state.cancel?.();
        return true;
      default:
        throw { code: "notFound", message: `no mock for ${cmd}` };
    }
  });
  return state;
}

const own: Source = {
  ...sourcePreview,
  id: "team",
  name: "Team skills",
  preview: false,
  catalogId: null,
  location: "https://git.example.com/team/skills.git",
  role: "team",
  skillCount: 7,
};

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});

describe("libraries, by who stands behind them", () => {
  beforeEach(() => {
    world({ entry: catalog[0] as CatalogEntry, sources: [own] });
  });

  it("groups the catalog by provenance, with what is connected first", async () => {
    wrap();
    expect(await screen.findByRole("heading", { name: /From the builders/ })).toBeInTheDocument();
    const builders = screen.getByRole("region", { name: /From the builders/ });
    const community = screen.getByRole("region", { name: /From the community/ });
    const connectedGroup = screen.getByRole("region", { name: /Connected/ });
    for (const name of [
      "Anthropic",
      "OpenAI",
      "Microsoft",
      "Google",
      "GitHub",
      "Cloudflare",
      "Vercel",
      "Sentry",
    ]) {
      expect(within(builders).getByText(name)).toBeInTheDocument();
    }
    for (const name of ["Superpowers", "Addy Osmani", "wshobson"]) {
      expect(within(community).getByText(name)).toBeInTheDocument();
    }
    // What is connected comes first, then what others built.
    expect(connectedGroup.compareDocumentPosition(builders) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(connectedGroup).getByText("Team skills")).toBeInTheDocument();
    // Bringing your own is in the header, on every visit.
    expect(screen.getByRole("button", { name: "Connect a Git repository" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use a folder" })).toBeInTheDocument();
    // How it works is shown only until something is connected.
    expect(screen.queryByText("Put skills to work")).toBeNull();
    // Connecting is not owning: nothing is called "yours" until a skill is adopted.
    expect(screen.queryByRole("region", { name: /^Yours/ })).toBeNull();
  });

  it("says only what is known: no counts before anything is fetched, and ownership is not a safety claim", async () => {
    wrap();
    const builders = await screen.findByRole("region", { name: /From the builders/ });
    // Nothing was fetched, so there is no skill count to show.
    expect(within(builders).queryByText(/\d+ skills/)).toBeNull();
    // The group says "builders"; a row speaks only when it differs. Cloudflare's
    // organisation is not verified by GitHub, so its row says so, with the evidence.
    expect(within(builders).queryAllByText("official")).toHaveLength(0);
    // How an organisation was checked belongs to its own page, not to every row.
    expect(within(builders).queryByText(/GitHub-verified/)).toBeNull();
    expect(within(builders).queryByText(/Look inside/)).toBeNull();
    expect(screen.queryByText(/\bsafe\b/i)).toBeNull();
    expect(screen.queryByText(/\btrusted\b/i)).toBeNull();
    const community = screen.getByRole("region", { name: /From the community/ });
    expect(within(community).queryByText(/GitHub-verified/)).toBeNull();
    // The page invents no review.
    expect(screen.queryByText(/reviewed/i)).toBeNull();
  });

  it("opens a library's page when its row is chosen, and connects nothing yet", async () => {
    const user = userEvent.setup();
    wrap();
    await user.click(await screen.findByRole("button", { name: /OpenAI/ }));
    await waitFor(() => expect(route()).toMatchObject({ name: "sources", entry: "openai" }));
    expect(await screen.findByRole("button", { name: "Connect library" })).toBeInTheDocument();
    expect(invoke.mock.calls.some(([cmd]) => cmd === "connect_catalog_entry")).toBe(false);
  });

  it("filters by name and moves between rows with the keyboard", async () => {
    const user = userEvent.setup();
    wrap();
    await screen.findByRole("region", { name: /From the builders/ });
    await user.keyboard("/");
    const filter = screen.getByRole("searchbox", { name: "Filter libraries" });
    expect(filter).toHaveFocus();
    await user.type(filter, "cloudflare");
    expect(screen.getByRole("button", { name: /Cloudflare/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /OpenAI/ })).toBeNull();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("button", { name: /Cloudflare/ })).toHaveFocus();
    await user.keyboard("{Escape}");
    await user.clear(filter);
    await user.click(await screen.findByRole("button", { name: /Anthropic/ }));
  });

  it("walks the rows with j and k, group to group", async () => {
    const user = userEvent.setup();
    wrap();
    const first = await screen.findByRole("button", { name: /Anthropic/ });
    first.focus();
    await user.keyboard("j");
    expect(screen.getByRole("button", { name: /OpenAI/ })).toHaveFocus();
    await user.keyboard("k");
    expect(first).toHaveFocus();
  });

  it("moves a library you connected from the catalog into Connected, and out of what is left to explore", async () => {
    const connectedOpenai: CatalogEntry = {
      ...(catalog.find((e) => e.id === "openai") as CatalogEntry),
      availability: "connected",
      sourceId: "s-openai",
    };
    world({ entry: catalog[0] as CatalogEntry, sources: [] });
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "catalog") return catalog.map((e) => (e.id === "openai" ? connectedOpenai : e));
      if (cmd === "list_sources") return [{ ...own, id: "s-openai", name: "OpenAI", catalogId: "openai" }];
      return [];
    });
    wrap();
    const connectedGroup = await screen.findByRole("region", { name: /Connected/ });
    expect(within(connectedGroup).getByText("OpenAI")).toBeInTheDocument();
    // What is left to explore no longer lists it.
    const builders = screen.getByRole("region", { name: /From the builders/ });
    expect(within(builders).queryByText("OpenAI")).toBeNull();
    expect(within(builders).getByText("Anthropic")).toBeInTheDocument();
  });

  it("has no accessibility violations", async () => {
    const { container } = wrap();
    await screen.findByRole("region", { name: /From the builders/ });
    const result = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(result.violations).toEqual([]);
  });
});

describe("a library's page, and connecting it", () => {
  it("shows GitHub's figures as context, saying that popularity is not safety", async () => {
    world({
      entry: entryUnfetched,
      sources: [],
      facts: {
        stars: 4200,
        forks: 310,
        pushedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
        createdYear: 2025,
        archived: false,
        fetchedAt: new Date().toISOString(),
      },
    });
    wrap({ name: "sources", entry: "acme" });
    const figures = await screen.findByLabelText("Acme on GitHub");
    expect(within(figures).getByText("4.2k")).toBeInTheDocument();
    expect(within(figures).getByText("310")).toBeInTheDocument();
    expect(within(figures).getByText("2025")).toBeInTheDocument();
    expect(figures).toHaveAttribute("title", expect.stringContaining("From GitHub"));
    // They are context: connecting does not wait for them.
    expect(screen.getByRole("button", { name: "Connect library" })).toBeEnabled();
  });

  it("says when a repository is archived on GitHub", async () => {
    world({
      entry: entryUnfetched,
      sources: [],
      facts: {
        stars: 10,
        forks: 1,
        pushedAt: null,
        createdYear: null,
        archived: true,
        fetchedAt: new Date().toISOString(),
      },
    });
    wrap({ name: "sources", entry: "acme" });
    expect(await screen.findByText("Archived on GitHub")).toBeInTheDocument();
  });

  it("shows no figures, and no error, when GitHub cannot be reached", async () => {
    world({ entry: entryUnfetched, sources: [], facts: null });
    wrap({ name: "sources", entry: "acme" });
    expect(await screen.findByRole("button", { name: "Connect library" })).toBeInTheDocument();
    expect(screen.queryByLabelText(/on GitHub/)).toBeNull();
    expect(screen.queryByText(/something went wrong/i)).toBeNull();
  });

  it("shows what the catalog knows, without fetching anything, behind one Connect button", async () => {
    world({ entry: entryUnfetched, sources: [] });
    wrap({ name: "sources", entry: "acme" });
    expect(await screen.findByRole("button", { name: "Connect library" })).toBeInTheDocument();
    // Who publishes it is the title and the kicker, so there is no block that says it again;
    // what GitHub vouches for rides on the kicker.
    expect(screen.queryByText("Publisher")).toBeNull();
    expect(screen.getByText("From the builders")).toHaveAttribute(
      "title",
      expect.stringMatching(/GitHub shows the acme organization as verified/),
    );
    // What Habi would read of the repository, from the catalog.
    expect(screen.getByRole("heading", { name: "Habi reads" })).toBeInTheDocument();
    // No review is recorded for any library, so the page does not announce the absence of one.
    expect(screen.queryByText(/Reviewed/)).toBeNull();
    // The repository name is the link out, not a separate button.
    expect(screen.getByRole("button", { name: /acme\/skills/ })).toBeInTheDocument();
    expect(screen.queryByText(/View on GitHub/)).toBeNull();
    // Looking at the page fetched nothing and connected nothing.
    expect(invoke.mock.calls.some(([cmd]) => cmd === "connect_catalog_entry")).toBe(false);
  });

  it("lists what in a project makes the catalog suggest the library, only when it says so", async () => {
    world({
      entry: {
        ...entryUnfetched,
        fitsWhen: [
          { kind: "file", text: "wrangler.toml" },
          { kind: "dependency", text: "wrangler" },
          { kind: "tag", text: "uses React" },
        ],
      },
      sources: [],
    });
    wrap({ name: "sources", entry: "acme" });
    expect(await screen.findByRole("heading", { name: "Fits projects with" })).toBeInTheDocument();
    expect(screen.getByText("wrangler.toml")).toBeInTheDocument();
    expect(screen.getByText("uses React")).toBeInTheDocument();
  });

  it("says plainly when GitHub does not vouch for the publisher's organization", async () => {
    world({
      entry: {
        ...entryUnfetched,
        ownership: {
          method: "org-site-matches-domain",
          checked: "2026-10-03",
          evidence: "The acme organization is not verified by GitHub, but its website is acme.dev",
        },
      },
      sources: [],
    });
    wrap({ name: "sources", entry: "acme" });
    expect(
      await screen.findByText(/not verified by GitHub, but its website is acme\.dev/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Fits projects with" })).toBeNull();
  });

  it("weaves while connecting, with a way to cancel, then opens the connected library", async () => {
    const user = userEvent.setup();
    const state = world({ entry: entryUnfetched, sources: [], holdConnect: true });
    wrap({ name: "sources", entry: "acme" });
    await user.click(await screen.findByRole("button", { name: "Connect library" }));
    expect(await screen.findByText(/nothing is installed or run/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    state.release?.();
    // It moves on to the connected library, which Back does not return to this page from.
    await waitFor(() => expect(route()).toMatchObject({ name: "sources", sourceId: sourceConnected.id }));
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "connect_catalog_entry")).toHaveLength(1);
    expect(invoke).toHaveBeenCalledWith(
      "connect_catalog_entry",
      expect.objectContaining({ entryId: "acme" }),
    );
    // Nothing else was done on the way: no install, no copy.
    expect(invoke.mock.calls.some(([cmd]) => /plan_install|import_skills|apply_plan/.test(String(cmd)))).toBe(
      false,
    );
  });

  it("goes straight to a library that is already connected, connecting nothing", async () => {
    world({ entry: entryConnected, sources: [sourceConnected] });
    wrap({ name: "sources", entry: "acme" });
    await waitFor(() => expect(route()).toMatchObject({ sourceId: sourceConnected.id }));
    expect(invoke.mock.calls.some(([cmd]) => cmd === "connect_catalog_entry")).toBe(false);
  });

  it("keeps nothing and says so when connecting is cancelled, and offers to connect again", async () => {
    const user = userEvent.setup();
    world({ entry: entryUnfetched, sources: [], holdConnect: true });
    wrap({ name: "sources", entry: "acme" });
    await user.click(await screen.findByRole("button", { name: "Connect library" }));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(await screen.findByText("You stopped the weaving. Nothing was kept.")).toBeInTheDocument();
    expect(route()).toMatchObject({ entry: "acme" });
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() =>
      expect(invoke.mock.calls.filter(([cmd]) => cmd === "connect_catalog_entry")).toHaveLength(2),
    );
  });

  it("explains a failed connection and waits for a click instead of retrying on its own", async () => {
    const user = userEvent.setup();
    world({ entry: entryUnfetched, sources: [], connectUnreachable: true });
    wrap({ name: "sources", entry: "acme" });
    await user.click(await screen.findByRole("button", { name: "Connect library" }));
    expect(await screen.findByText("could not reach github.com")).toBeInTheDocument();
    expect(screen.getByText(/Check your network or VPN/)).toBeInTheDocument();
    expect(screen.getByText(/thread snapped/i)).toBeInTheDocument();
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "connect_catalog_entry")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(invoke.mock.calls.filter(([cmd]) => cmd === "connect_catalog_entry")).toHaveLength(2),
    );
  });
});

describe("a connected catalog library", () => {
  beforeEach(() => {
    world({ entry: entryConnected, sources: [sourceConnected] });
  });

  it("states who publishes it, its licence and size, from what was read", async () => {
    wrap(inLibrary());
    const strip = await screen.findByRole("region", { name: "About Acme" });
    expect(within(strip).getByText(/From the builders/)).toBeInTheDocument();
    expect(within(strip).getByText(/official/)).toBeInTheDocument();
    expect(within(strip).getByText("MIT")).toBeInTheDocument();
    expect(within(strip).getByText("4 skills")).toBeInTheDocument();
    expect(within(strip).getByText(/main@/)).toBeInTheDocument();
    // Ownership is not a review, and the page does not blur the two.
    await userEvent.click(within(strip).getByRole("button", { name: /Source/ }));
    expect(within(strip).queryByText(/Reviewed/)).toBeNull();
    expect(within(strip).getByText(/GitHub shows the acme organization as verified/)).toBeInTheDocument();
  });

  it("offers what a connected library offers, and no second way to connect", async () => {
    wrap(inLibrary({ itemId: "migrations" }));
    expect(await screen.findByRole("button", { name: /Add to a project/ })).toBeInTheDocument();
    // The other ways to use it sit behind one menu rather than beside the main button.
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    expect(await screen.findByRole("menuitem", { name: /Add to this machine/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Edit a copy/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Connect/ })).toBeNull();
  });

  it("groups its skills by plugin and lists them in that order", async () => {
    wrap(inLibrary());
    const index = await screen.findByRole("list", { name: /Skills in/ });
    const groups = within(index).getAllByText(/^(payments|platform)$/);
    expect(groups.map((g) => g.textContent)).toEqual(["payments", "platform"]);
    const titles = within(index)
      .getAllByRole("button")
      .map((b) => b.querySelector(".index-title")?.textContent);
    expect(titles).toEqual(["API design", "Migrations", "CI review", "Wrangler"]);
  });

  it("follows the arrow keys through the grouped order", async () => {
    const user = userEvent.setup();
    wrap(inLibrary());
    const index = await screen.findByRole("list", { name: /Skills in/ });
    (within(index).getAllByRole("button")[0] as HTMLElement).focus();
    await user.keyboard("{ArrowDown}{ArrowDown}");
    await waitFor(() => expect(route()).toMatchObject({ sourceId: sourceConnected.id, itemId: "ci-review" }));
  });

  it("lists what stood out, where, and says it is not a guarantee", async () => {
    const user = userEvent.setup();
    wrap(inLibrary());
    const strip = await screen.findByRole("region", { name: "About Acme" });
    await user.click(within(strip).getByRole("button", { name: /Inspection/ }));
    const panel = document.getElementById("strip-inspection") as HTMLElement;
    expect(within(panel).getByText(/downloads and runs code/i)).toBeInTheDocument();
    expect(within(panel).getAllByText(/install-tool\.sh:2/).length).toBeGreaterThan(0);
    expect(within(panel).getByText(/nothing was run/i)).toBeInTheDocument();
    expect(within(panel).getByText(/misses things and flags harmless ones/i)).toBeInTheDocument();
    // Opening a flagged skill goes to the file that was flagged.
    await user.click(within(panel).getByRole("button", { name: /Migrations/ }));
    await waitFor(() =>
      expect(route()).toMatchObject({ itemId: "migrations", file: "scripts/install-tool.sh" }),
    );
  });

  it("shows a skill's own signals in its details, as signals and not as a verdict", async () => {
    const user = userEvent.setup();
    wrap(inLibrary({ itemId: "migrations" }));
    await user.click(await screen.findByRole("button", { name: /1 caution signal/ }));
    const details = document.getElementById("skill-details") as HTMLElement;
    expect(within(details).getByText(/downloads and runs code/i)).toBeInTheDocument();
    expect(within(details).getAllByText(/install-tool\.sh:2/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/\bsafe\b/i)).toBeNull();
  });

  it("can be disconnected from its own header, saying what stays untouched", async () => {
    const user = userEvent.setup();
    wrap(inLibrary());
    const strip = await screen.findByRole("region", { name: "About Acme" });
    await user.click(within(strip).getByRole("button", { name: "Disconnect" }));
    const dialog = await screen.findByRole("dialog", { name: /Disconnect Acme\?/ });
    expect(within(dialog).getByText(/stay exactly as they are/i)).toBeInTheDocument();
    // Nothing happens until it is confirmed.
    expect(invoke.mock.calls.some(([cmd]) => cmd === "remove_source")).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("remove_source", { sourceId: sourceConnected.id }),
    );
    await waitFor(() => expect(route()).toEqual({ name: "sources" }));
  });

  it("has a way back to the libraries, in the library's own header", async () => {
    const user = userEvent.setup();
    wrap(inLibrary());
    const strip = await screen.findByRole("region", { name: "About Acme" });
    await user.click(within(strip).getByRole("button", { name: /Libraries/ }));
    await waitFor(() => expect(route()).toEqual({ name: "sources" }));
  });

  it("folds the package panel when another skill is chosen", async () => {
    const user = userEvent.setup();
    wrap(inLibrary({ itemId: "api-design" }));
    await screen.findByRole("region", { name: "About Acme" });
    setInspectorOpen(true);
    await waitFor(() => expect(readInspector()).toBe(true));
    await user.click(screen.getByTestId("pick-ci-review"));
    await waitFor(() => expect(readInspector()).toBe(false));
  });

  it("lights the thread only for what is true", async () => {
    wrap(inLibrary());
    const thread = await screen.findByRole("list", { name: /How far this library has come/ });
    const steps = within(thread).getAllByRole("listitem");
    expect(steps.map((s) => s.className.includes("is-done"))).toEqual([true, false]);
  });

  it("has no accessibility violations", async () => {
    const { container } = wrap(inLibrary({ itemId: "migrations" }));
    await screen.findByRole("region", { name: "About Acme" });
    const result = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(result.violations).toEqual([]);
  });
});

const ver = (label: string, n: number, release = true) => ({ label, release, commit: String(n).repeat(40) });
const calls = (cmd: string) => invoke.mock.calls.filter(([c]) => c === cmd);

const newer: SourceUpdate = {
  sourceId: sourceConnected.id,
  current: ver("v1.0.0", 1),
  latest: ver("v1.1.0", 2),
  available: true,
  checkedAt: new Date().toISOString(),
};

const changed: UpdateReport = {
  sourceId: sourceConnected.id,
  from: ver("v1.0.0", 1),
  to: ver("v1.1.0", 2),
  at: new Date().toISOString(),
  added: [{ id: "wrangler", title: "Wrangler" }],
  updated: [{ id: "migrations", title: "Migrations" }],
  removed: [{ id: "old-checklist", title: "Old checklist" }],
};

describe("updating a library is the user's choice", () => {
  it("offers a newer release, and moves nothing until asked", async () => {
    const user = userEvent.setup();
    world({ entry: entryConnected, sources: [sourceConnected], update: newer, afterUpdate: changed });
    wrap(inLibrary());
    expect(await screen.findByText(/is out\./)).toBeInTheDocument();
    expect(screen.getByText(/You are reading/)).toBeInTheDocument();
    expect(calls("refresh_source")).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Update" }));
    await waitFor(() => expect(calls("refresh_source")).toHaveLength(1));
    // The offer goes, and what the update changed takes its place.
    expect(await screen.findByRole("button", { name: /Updated/ })).toBeInTheDocument();
    expect(screen.queryByText(/is out\./)).toBeNull();
  });

  it("names what an update changed, and marks those skills in the index until they are seen", async () => {
    const user = userEvent.setup();
    world({ entry: entryConnected, sources: [sourceConnected], report: changed });
    wrap(inLibrary());
    const index = await screen.findByRole("list", { name: /Skills in/ });
    const row = (title: string) =>
      within(index)
        .getAllByRole("button")
        .find((b) => b.querySelector(".index-title")?.textContent === title) as HTMLElement;
    expect(within(row("Wrangler")).getByText("new")).toBeInTheDocument();
    expect(within(row("Migrations")).getByText("changed")).toBeInTheDocument();
    expect(within(row("API design")).queryByText(/^(new|changed)$/)).toBeNull();

    await user.click(screen.getByRole("button", { name: /Updated/ }));
    expect(screen.getByText("Old checklist")).toBeInTheDocument();
    // A removed skill is not there to open.
    expect(screen.queryByRole("button", { name: "Old checklist" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Mark as seen" }));
    await waitFor(() => expect(calls("dismiss_update_report")).toHaveLength(1));
    await waitFor(() => expect(within(row("Wrangler")).queryByText("new")).toBeNull());
  });

  it("says nothing when the library is up to date", async () => {
    world({ entry: entryConnected, sources: [sourceConnected], update: { ...newer, available: false } });
    wrap(inLibrary());
    await screen.findByRole("region", { name: "About Acme" });
    expect(screen.queryByText(/is out\./)).toBeNull();
    expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
  });

  it("asks once on opening, and not again within the hour", async () => {
    world({ entry: entryConnected, sources: [sourceConnected] });
    const first = wrap(inLibrary());
    await screen.findByRole("region", { name: "About Acme" });
    await waitFor(() => expect(calls("check_source_update")).toHaveLength(1));
    first.unmount();

    world({ entry: entryConnected, sources: [sourceConnected], update: { ...newer, available: false } });
    wrap(inLibrary());
    await screen.findByRole("region", { name: "About Acme" });
    expect(calls("check_source_update")).toHaveLength(0);
  });

  it("names the release a library reads, and says so before it is connected", async () => {
    const fetched = entryConnected.fetched;
    if (!fetched) throw new Error("the connected fixture has been fetched");
    world({
      entry: { ...entryConnected, followsReleases: true, fetched: { ...fetched, release: "v1.0.0" } },
      sources: [sourceConnected],
    });
    const first = wrap(inLibrary());
    const strip = await screen.findByRole("region", { name: "About Acme" });
    expect(within(strip).getByText("v1.0.0")).toBeInTheDocument();
    expect(within(strip).queryByText(/main@/)).toBeNull();
    first.unmount();

    world({ entry: { ...entryUnfetched, followsReleases: true }, sources: [] });
    wrap({ name: "sources", entry: "acme" });
    expect(await screen.findByText("The latest release")).toBeInTheDocument();
  });

  it("says in the list which libraries have something newer", async () => {
    world({ entry: entryConnected, sources: [sourceConnected], update: newer });
    wrap();
    const connected = await screen.findByRole("region", { name: /Connected/ });
    expect(await within(connected).findByText("v1.1.0 available")).toBeInTheDocument();
  });
});
