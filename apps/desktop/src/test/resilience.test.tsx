import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "../components/ErrorBoundary";

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
    const logged = invoke.mock.calls.find(([cmd]) => cmd === "log_ui_error");
    expect(logged?.[1]).toMatchObject({ message: "Error: the screen broke" });
    expect(String((logged?.[1] as { detail: string }).detail)).toContain("while showing the test");

    await userEvent.click(screen.getByRole("button", { name: "Save diagnostics…" }));
    await waitFor(() => expect(screen.getByText("Saved to ~/Desktop/habi-diagnostics.txt")).toBeInTheDocument());
    quiet.mockRestore();
  });
});
