import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/Toasts";
import { NavProvider, useNav } from "../lib/nav";
import { UpdatesView } from "../views/UpdatesView";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

type Handler = (args: Record<string, unknown>) => unknown;
let handlers: Record<string, Handler> = {};

beforeEach(() => {
  handlers = {};
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string, args: Record<string, unknown> = {}) => {
    const handler = handlers[cmd];
    if (handler) return handler(args);
    if (["list_sources", "recent_projects"].includes(cmd)) return [];
    throw { code: "notFound", message: `no mock for ${cmd}` };
  });
});

function Where() {
  return <output>{JSON.stringify(useNav().route)}</output>;
}

function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <NavProvider initial={{ name: "updates" }}>
          <UpdatesView />
          <Where />
        </NavProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const pending = (over: Record<string, unknown> = {}) => ({
  libraries: [],
  copies: [],
  unreadable: [],
  ...over,
});

describe("updates, in one place", () => {
  it("says so when nothing is behind", async () => {
    handlers.pending_updates = () => pending();
    show();
    expect(await screen.findByText("Everything is up to date")).toBeInTheDocument();
  });

  it("lists a library with something newer, and fetches it when asked", async () => {
    const fetched = vi.fn(() => ({ changed: true }));
    handlers.refresh_source = fetched;
    handlers.pending_updates = () =>
      pending({
        libraries: [
          {
            sourceId: "team",
            name: "Team library",
            current: { label: "v1.4.0", release: true, commit: "a".repeat(40) },
            latest: { label: "v1.5.0", release: true, commit: "b".repeat(40) },
          },
        ],
      });
    show();
    expect(await screen.findByText("v1.4.0 → v1.5.0")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Get update" }));
    await waitFor(() => expect(fetched).toHaveBeenCalledWith(expect.objectContaining({ sourceId: "team" })));
  });

  it("lists copies by where they are, each with the way to its own review", async () => {
    handlers.pending_updates = () =>
      pending({
        copies: [
          {
            place: { kind: "project", id: "p1", name: "billing-service" },
            library: "Team library",
            keys: ["k1", "k2"],
            titles: ["Code review", "Release notes"],
          },
          { place: { kind: "machine" }, library: "Team library", keys: ["k3"], titles: ["eng"] },
          { place: { kind: "mySkills" }, library: "Team library", keys: ["s1"], titles: ["My review"] },
        ],
      });
    show();
    const rows = within(await screen.findByRole("region", { name: "Installed copies that can follow" }));
    expect(rows.getByText("billing-service")).toBeInTheDocument();
    expect(rows.getByText("2 items from Team library")).toBeInTheDocument();
    expect(rows.getByText("Code review, Release notes")).toBeInTheDocument();
    expect(rows.getByText("This machine")).toBeInTheDocument();
    expect(rows.getAllByRole("button", { name: "Update…" })).toHaveLength(2);
    // An editable copy is merged in the skill's own review.
    await userEvent.click(rows.getByRole("button", { name: "Open it" }));
    expect(screen.getByRole("status").textContent).toContain('"skillId":"s1"');
  });

  it("says which project could not be read, and why", async () => {
    handlers.pending_updates = () =>
      pending({ unreadable: [{ id: "p9", name: "legacy", reason: "the lock file is not valid" }] });
    show();
    expect(await screen.findByText(/legacy: what is installed there could not be read/)).toBeInTheDocument();
    expect(screen.getByText("the lock file is not valid")).toBeInTheDocument();
  });
});
