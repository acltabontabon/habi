import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/Toasts";
import { SkillReader } from "../views/reader/SkillReader";
import details from "./fixtures/item-details.json";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const detail = (details as Record<string, unknown>)["api-contract-review"];

beforeEach(() => {
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
      intro={<h2>Skill overview</h2>}
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
  it("shows one document at a time: a file replaces the skill, and Esc returns", async () => {
    const user = userEvent.setup();
    const { container } = wrap();
    expect(await screen.findByRole("heading", { name: "Skill overview" })).toBeInTheDocument();
    expect(container.querySelectorAll(".reader-main")).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: /breaking-changes\.md/ }));
    expect(await screen.findByRole("heading", { name: "Breaking changes" })).toBeInTheDocument();
    // The skill's introduction and SKILL.md are gone, not stacked beside it.
    expect(screen.queryByRole("heading", { name: "Skill overview" })).toBeNull();
    expect(screen.getByRole("heading", { name: "references/breaking-changes.md" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /breaking-changes\.md/ })).toHaveAttribute(
      "aria-current",
      "page",
    );

    await user.keyboard("{Escape}");
    expect(await screen.findByRole("heading", { name: "Skill overview" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /SKILL\.md/ })).toHaveAttribute("aria-current", "page");

    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  });
});
