import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalSkill } from "../bindings/LocalSkill";
import type { TextDiff } from "../bindings/TextDiff";
import type { UpstreamPlan } from "../bindings/UpstreamPlan";
import type { UpstreamStatus } from "../bindings/UpstreamStatus";
import { ToastProvider } from "../components/Toasts";
import { UpstreamPanel } from "../views/skills/UpstreamPanel";

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
    throw { code: "notFound", message: `no mock for ${cmd}` };
  });
});

function wrap(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>,
  );
}

function skillFrom(origin: LocalSkill["summary"]["origin"]): LocalSkill {
  return {
    summary: {
      id: "k",
      name: "review",
      title: "Review",
      description: "Reviews changes",
      origin,
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-10-01T00:00:00Z",
      deletedAt: null,
      errors: 0,
      warnings: 0,
      hasApplicability: false,
      fileCount: 4,
      contentDigest: "d",
    },
    diagnostics: [],
  } as unknown as LocalSkill;
}

const libraryOrigin = {
  type: "library",
  sourceName: "Team",
  sourceIdentity: "local:Team",
  itemId: "review",
  snapshot: "old",
} as const;

const status = (state: UpstreamStatus["state"], detail: string | null = null): UpstreamStatus => ({
  skillId: "k",
  state,
  sourceName: "Team",
  sourceId: "s1",
  itemId: "review",
  originSnapshot: "old",
  currentSnapshot: "new",
  detail,
});

const oneLine: TextDiff = {
  hunks: [
    {
      header: "@@ -1 +1 @@",
      lines: [
        { tag: "removed", oldLine: 1, newLine: null, text: "old" },
        { tag: "added", oldLine: null, newLine: 1, text: "new" },
      ],
    },
  ],
  added: 1,
  removed: 1,
  binary: false,
  truncated: false,
};

const plan: UpstreamPlan = {
  status: status("changed"),
  files: [
    {
      path: "references/a.md",
      status: "library",
      libraryChange: "modified",
      yourChange: null,
      libraryDiff: oneLine,
      yourDiff: null,
      note: null,
    },
    {
      path: "references/b.md",
      status: "yours",
      libraryChange: null,
      yourChange: "modified",
      libraryDiff: null,
      yourDiff: oneLine,
      note: null,
    },
    {
      path: "references/c.md",
      status: "conflict",
      libraryChange: "modified",
      yourChange: "modified",
      libraryDiff: oneLine,
      yourDiff: oneLine,
      note: null,
    },
  ],
  unchanged: 1,
  take: 1,
  keep: 1,
  conflicts: 1,
  token: "t1",
  blocked: null,
};

describe("updates for a copy of a library item", () => {
  it("shows nothing for drafts or when the library has not changed", async () => {
    handlers = { skill_upstream: () => status("unchanged") };
    const { container, rerender } = wrap(
      <UpstreamPanel skill={skillFrom(libraryOrigin)} beforeReview={async () => true} onApplied={() => {}} />,
    );
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("skill_upstream", { id: "k" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelector(".notice")).toBeNull();
    invoke.mockClear();
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <ToastProvider>
          <UpstreamPanel
            skill={skillFrom({ type: "created" })}
            beforeReview={async () => true}
            onApplied={() => {}}
          />
        </ToastProvider>
      </QueryClientProvider>,
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it("says plainly when the item was removed, without offering an action", async () => {
    handlers = {
      skill_upstream: () => status("removed", "“Review” is no longer in Team. Your copy stays as it is."),
    };
    wrap(
      <UpstreamPanel skill={skillFrom(libraryOrigin)} beforeReview={async () => true} onApplied={() => {}} />,
    );
    expect(await screen.findByText(/no longer in Team/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("requires a choice for each conflict and names the action", async () => {
    const applied = vi.fn();
    const flushed = vi.fn(async () => true);
    handlers = {
      skill_upstream: () => status("changed"),
      plan_upstream_sync: () => plan,
      apply_upstream_sync: (args) => {
        applied(args);
        return skillFrom(libraryOrigin);
      },
    };
    const onApplied = vi.fn();
    wrap(<UpstreamPanel skill={skillFrom(libraryOrigin)} beforeReview={flushed} onApplied={onApplied} />);
    const user = userEvent.setup();
    expect(await screen.findByText("Updated in Team since you copied it")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Review update…" }));
    expect(flushed).toHaveBeenCalled();

    const dialog = await screen.findByRole("dialog");
    expect(await screen.findByText("1 decision needed")).toBeInTheDocument();
    expect(screen.getByText("Library change — taken")).toBeInTheDocument();
    expect(screen.getByText("Your edit — kept")).toBeInTheDocument();
    // Undecided: the action names what is known so far and cannot run.
    const pending = screen.getByRole("button", { name: "Take 1 library change, keep your edit" });
    expect(pending).toBeDisabled();

    await user.click(screen.getByRole("radio", { name: "Keep mine" }));
    const confirm = screen.getByRole("button", { name: "Take 1 library change, keep your 2 edits" });
    expect(confirm).toBeEnabled();
    await user.click(screen.getByRole("radio", { name: "Take the library's" }));
    expect(screen.getByRole("button", { name: "Take 2 library changes, keep your edit" })).toBeEnabled();

    const results = await axe.run(dialog);
    expect(results.violations.map((v) => v.id)).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Take 2 library changes, keep your edit" }));
    await waitFor(() =>
      expect(applied).toHaveBeenCalledWith({
        id: "k",
        token: "t1",
        decisions: { "references/c.md": "takeLibrary" },
      }),
    );
    await waitFor(() => expect(onApplied).toHaveBeenCalled());
  });
});
