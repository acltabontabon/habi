import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/Toasts";
import { setInspectorOpen } from "../lib/inspector";
import { ContentsToggle, SkillReader } from "../views/reader/SkillReader";
import details from "./fixtures/item-details.json";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const detail = (details as Record<string, unknown>)["api-contract-review"];

beforeEach(() => {
  sessionStorage.clear();
  setInspectorOpen(false);
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string, args: { path?: string }) => {
    if (cmd === "item_detail") return detail;
    if (cmd === "item_file")
      return {
        path: args.path,
        text: "# Breaking changes\n\nRemoving a field breaks clients.\n",
        size: 52,
        binary: false,
      };
    throw { code: "notFound", message: `no mock for ${cmd}` };
  });
});

function Reader() {
  const [file, setFile] = useState<string | null>(null);
  return (
    <SkillReader
      sourceId="team"
      itemId="api-contract-review"
      title="API contract review"
      file={file}
      onFile={setFile}
      head={
        <>
          <h2>Skill overview</h2>
          <ContentsToggle />
        </>
      }
    />
  );
}

function wrap() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <Reader />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("skill reader", () => {
  it("opens the package beside the skill; a file replaces the skill, and Esc steps back", async () => {
    const user = userEvent.setup();
    const { container } = wrap();
    expect(await screen.findByRole("heading", { name: "Skill overview" })).toBeInTheDocument();
    // The package is one action away, not a permanent column.
    expect(screen.queryByRole("region", { name: "Package contents" })).toBeNull();
    await user.click(screen.getByRole("button", { name: /Contents/ }));
    expect(screen.getByRole("region", { name: "Package contents" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Contents/ })).toHaveAttribute("aria-expanded", "true");

    await user.click(screen.getByRole("button", { name: /breaking-changes\.md/ }));
    expect(await screen.findByRole("heading", { name: "Breaking changes" })).toBeInTheDocument();
    // One document surface: the skill's head and SKILL.md are not shown beside it.
    expect(screen.queryByRole("heading", { name: "Skill overview" })).toBeNull();
    expect(container.querySelectorAll(".reader-main")).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "references/breaking-changes.md" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /breaking-changes\.md/ })).toHaveAttribute(
      "aria-current",
      "page",
    );

    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);

    // Esc: back to the skill, with the package still open…
    await user.keyboard("{Escape}");
    expect(await screen.findByRole("heading", { name: "Skill overview" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /SKILL\.md/ })).toHaveAttribute("aria-current", "page");
    // …then Esc closes the package.
    await user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: /Contents/ })).toHaveAttribute("aria-expanded", "false");
  });

  it("toggles the package with ⌘I and remembers it for the session", async () => {
    const user = userEvent.setup();
    wrap();
    await screen.findByRole("heading", { name: "Skill overview" });
    await user.keyboard("{Meta>}i{/Meta}");
    expect(screen.getByRole("region", { name: "Package contents" })).toBeInTheDocument();
    expect(sessionStorage.getItem("habi.packageInspector")).toBe("open");
  });
});
