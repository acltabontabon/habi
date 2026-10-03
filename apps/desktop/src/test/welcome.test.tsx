import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/Toasts";
import { HEADLINES, headlineParts, pickHeadline } from "../lib/headlines";
import { installCommand } from "../lib/tools";
import { WelcomeOverlay } from "../views/WelcomeOverlay";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

type Handler = (args: Record<string, unknown>) => unknown;
let handlers: Record<string, Handler> = {};
let machine = { gitAvailable: true, ghAvailable: true, glabAvailable: true };
let showWelcome = true;

beforeEach(() => {
  machine = { gitAvailable: true, ghAvailable: true, glabAvailable: true };
  showWelcome = true;
  handlers = {
    app_info: () => ({
      version: "0.1.0",
      dataDir: "~/habi",
      platform: "macos",
      startupError: null,
      ...machine,
    }),
    get_settings: () => ({ autoRefreshHours: 12, checkForUpdates: true, showWelcome }),
  };
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string, args: Record<string, unknown> = {}) => {
    const handler = handlers[cmd];
    if (handler) return handler(args);
    throw { code: "notFound", message: `no mock for ${cmd}` };
  });
});

function welcome() {
  const onClose = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <WelcomeOverlay onClose={onClose} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return onClose;
}

describe("Welcome", () => {
  it("says what Habi is for, and that everything is in place", async () => {
    welcome();
    expect(
      await screen.findByRole("heading", { name: (name) => HEADLINES.some((h) => h.text === name) }),
    ).toBeInTheDocument();
    expect(screen.getByText("Find")).toBeInTheDocument();
    expect(await screen.findByText("Ready to pull libraries.")).toBeInTheDocument();
    // Only Git is checked; the rest is what Habi works with.
    expect(screen.getAllByText("found")).toHaveLength(1);
    expect(screen.getByRole("img", { name: /Installs for Claude Code, Cursor, Codex/ })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Projects Habi reads" })).toHaveTextContent(/Java.*Python/);
    // Nothing to fix, so nothing to check again.
    expect(screen.queryByRole("button", { name: "Check again" })).not.toBeInTheDocument();
  });

  it("answers its headline with what Habi does", async () => {
    welcome();
    const heading = await screen.findByRole("heading", {
      name: (name) => HEADLINES.some((h) => h.text === name),
    });
    const shown = HEADLINES.find((h) => h.text === heading.textContent);
    expect(screen.getByText(shown?.sub ?? "")).toBeInTheDocument();
  });

  it("tells the person Git is needed, and how to get it", async () => {
    machine = { gitAvailable: false, ghAvailable: true, glabAvailable: true };
    handlers.open_external = () => null;
    const user = userEvent.setup();
    welcome();
    expect(await screen.findByText("Git is needed to pull libraries.")).toBeInTheDocument();
    expect(screen.getByText("xcode-select --install")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Other ways to install/ }));
    expect(invoke).toHaveBeenCalledWith("open_external", { url: "https://git-scm.com/downloads" });
  });

  it("looks again after the person installs it", async () => {
    machine = { gitAvailable: false, ghAvailable: false, glabAvailable: false };
    const user = userEvent.setup();
    welcome();
    await screen.findByText("Git is needed to pull libraries.");
    machine = { gitAvailable: true, ghAvailable: false, glabAvailable: false };
    await user.click(screen.getByRole("button", { name: "Check again" }));
    expect(await screen.findByText("Ready to pull libraries.")).toBeInTheDocument();
    // The optional CLIs are not asked for here; Settings offers them.
    expect(screen.queryByText("brew install gh")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Check again" })).not.toBeInTheDocument();
  });

  it("closes keeping the welcome on, unless the person opts out", async () => {
    const user = userEvent.setup();
    const onClose = welcome();
    await user.click(await screen.findByRole("button", { name: "Get started" }));
    expect(onClose).toHaveBeenCalledWith(false);
  });

  it("remembers the opt-out when it closes", async () => {
    const user = userEvent.setup();
    const onClose = welcome();
    await user.click(await screen.findByRole("checkbox", { name: /Don’t show this again/ }));
    await user.click(screen.getByRole("button", { name: "Get started" }));
    expect(onClose).toHaveBeenCalledWith(true);
  });

  it("starts with the box ticked when the welcome is already off", async () => {
    showWelcome = false;
    welcome();
    await waitFor(() =>
      expect(screen.getByRole("checkbox", { name: /Don’t show this again/ })).toBeChecked(),
    );
  });

  it("closes with Escape", async () => {
    const user = userEvent.setup();
    const onClose = welcome();
    await screen.findByRole("button", { name: "Get started" });
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledWith(false);
  });
});

describe("setup help", () => {
  it("gives a one-line install only where there is a dependable one", () => {
    expect(installCommand("git", "macos")).toBe("xcode-select --install");
    expect(installCommand("gh", "windows")).toContain("winget");
    expect(installCommand("git", "linux")).toBeUndefined();
  });

  it("picks one headline, always from the list", () => {
    expect(pickHeadline(() => 0)).toBe(HEADLINES[0]);
    expect(pickHeadline(() => 0.9999)).toBe(HEADLINES[HEADLINES.length - 1]);
    expect(HEADLINES).toContain(pickHeadline());
  });

  it("highlights a phrase that is really in each headline", () => {
    for (const h of HEADLINES) {
      const [before, em, after] = headlineParts(h);
      expect(em).toBe(h.em);
      expect(before + em + after).toBe(h.text);
    }
  });

  it("keeps the headlines free of numbers, which would need a source", () => {
    for (const h of HEADLINES) expect(h.text).not.toMatch(/\d/);
  });

  it("keeps the headlines short enough to set large, and never repeats one", () => {
    for (const h of HEADLINES) expect(h.text.length).toBeLessThanOrEqual(64);
    // The line under it fits on one line, even in the smallest window.
    for (const h of HEADLINES) expect(h.sub.length, h.sub).toBeLessThanOrEqual(58);
    expect(new Set(HEADLINES.map((h) => h.text)).size).toBe(HEADLINES.length);
  });
});
