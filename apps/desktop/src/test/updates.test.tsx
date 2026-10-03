import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateInfo } from "../bindings/UpdateInfo";
import { ToastProvider } from "../components/Toasts";
import { RELEASES } from "../lib/release";
import { UpdatesProvider } from "../lib/updates";
import { AboutView } from "../views/AboutView";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

type Handler = (args: Record<string, unknown>) => unknown;
let handlers: Record<string, Handler> = {};
const calls: string[] = [];

const offer: UpdateInfo = {
  version: "0.2.0",
  currentVersion: "0.1.0",
  date: "2026-11-03T00:00:00Z",
  notes: "### Added\n\n- **A new thing.** It does something.",
};

beforeEach(() => {
  handlers = {
    app_info: () => ({ version: "0.1.0", dataDir: "~/habi", startupError: null }),
    get_settings: () => ({ autoRefreshHours: 12, checkForUpdates: true }),
  };
  calls.length = 0;
  localStorage.clear();
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string, args: Record<string, unknown> = {}) => {
    calls.push(cmd);
    const handler = handlers[cmd];
    if (handler) return handler(args);
    throw { code: "notFound", message: `no mock for ${cmd}` };
  });
});

function about() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <UpdatesProvider>
          <AboutView />
        </UpdatesProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("About", () => {
  it("shows the version, the notes of each release, and who made Habi", async () => {
    about();
    expect(await screen.findByText("Version 0.1.0")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "What's new" })).toBeInTheDocument();
    // Whatever the changelog holds is listed, newest first.
    for (const release of RELEASES) {
      expect(screen.getByRole("heading", { name: release.version })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: /Alvin Cris Tabontabon/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Buy me a coffee/ })).toBeInTheDocument();
  });

  it("opens the support page through Habi, not the webview", async () => {
    handlers.open_external = () => null;
    const user = userEvent.setup();
    about();
    await user.click(await screen.findByRole("button", { name: /Buy me a coffee/ }));
    expect(invoke).toHaveBeenCalledWith("open_external", { url: "https://ko-fi.com/aclt_attic" });
  });
});

describe("updating", () => {
  it("says when this is the newest version", async () => {
    handlers.check_for_update = () => null;
    const user = userEvent.setup();
    about();
    await user.click(await screen.findByRole("button", { name: "Check for updates" }));
    expect(await screen.findByText("Habi is up to date")).toBeInTheDocument();
  });

  it("offers a newer version with its notes, installs it, then restarts", async () => {
    handlers.check_for_update = () => offer;
    handlers.install_update = () => null;
    handlers.restart_app = () => null;
    const user = userEvent.setup();
    about();
    await user.click(await screen.findByRole("button", { name: "Check for updates" }));
    expect(await screen.findByText("Habi 0.2.0 is available")).toBeInTheDocument();
    expect(screen.getByText("A new thing.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Update and restart" }));
    await waitFor(() => expect(calls).toContain("restart_app"));
    expect(calls.indexOf("install_update")).toBeLessThan(calls.indexOf("restart_app"));
  });

  it("keeps the update on offer when installing fails, and tries again", async () => {
    let attempts = 0;
    handlers.check_for_update = () => offer;
    handlers.install_update = () => {
      attempts += 1;
      if (attempts === 1) throw { code: "update_install", message: "The update could not be installed." };
      return null;
    };
    handlers.restart_app = () => null;
    const user = userEvent.setup();
    about();
    await user.click(await screen.findByRole("button", { name: "Check for updates" }));
    await user.click(await screen.findByRole("button", { name: "Update and restart" }));
    expect(await screen.findByText("The update could not be installed.")).toBeInTheDocument();
    expect(calls).not.toContain("restart_app");

    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(calls).toContain("restart_app"));
    expect(attempts).toBe(2);
  });

  it("does not restart over edits that could not be saved", async () => {
    handlers.check_for_update = () => offer;
    handlers.install_update = () => null;
    const autosave = await import("../lib/useAutosave");
    vi.spyOn(autosave, "flushAutosaves").mockResolvedValue(false);
    const user = userEvent.setup();
    about();
    await user.click(await screen.findByRole("button", { name: "Check for updates" }));
    await user.click(await screen.findByRole("button", { name: "Update and restart" }));
    expect(await screen.findByText(/Some edits are not saved yet/)).toBeInTheDocument();
    expect(calls).not.toContain("restart_app");
  });
});
