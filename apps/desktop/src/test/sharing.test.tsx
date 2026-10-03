import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppInfo } from "../bindings/AppInfo";
import type { Contribution } from "../bindings/Contribution";
import type { DraftFile } from "../bindings/DraftFile";
import type { ReviewStatus } from "../bindings/ReviewStatus";
import { ToastProvider } from "../components/Toasts";
import { NavProvider, type Route } from "../lib/nav";
import { finalAction, nextAction, sharingChip, targetBranch, visibilityText } from "../lib/sharing";
import { ContributionsView } from "../views/contributions/ContributionsView";

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
    throw { code: "notFound", message: `no mock for ${cmd}` };
  });
});

function wrap(ui: ReactNode, initial: Route = { name: "contributions" }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <NavProvider initial={initial}>{ui}</NavProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const noDiff = { hunks: [], added: 0, removed: 0, binary: false, truncated: false };
const file = (path: string, status: DraftFile["status"], extra: Partial<DraftFile> = {}): DraftFile => ({
  path: `skills/jpa/${path}`,
  previousPath: null,
  status,
  size: 10,
  diff: status === "unchanged" || status === "renamed" ? noDiff : { ...noDiff, added: 2, removed: 1 },
  included: true,
  required: null,
  ...extra,
});

const base: Contribution = {
  id: "c1",
  sourceId: "team",
  sourceName: "Team",
  title: "Share JPA review",
  message: "",
  itemPath: "skills/jpa",
  baseCommit: "abcdef123456",
  branch: "habi/contrib/jpa-1a2b3c",
  state: "draft",
  origin: { type: "libraryItem", itemId: "jpa" },
  form: {
    title: "JPA review",
    owner: "",
    repositoryScope: false,
    conditionsEditable: true,
    matchMode: "all",
    appliesTags: [],
    appliesDependencies: [],
    appliesFiles: [],
    excludeTags: [],
    excludeDependencies: [],
    tools: [],
    examples: [],
  },
  files: [
    file("SKILL.md", "modified"),
    file("docs/notes.md", "renamed", { previousPath: "skills/jpa/references/notes.md" }),
    file("scripts/check.sh", "added", { included: false }),
    file("habi.yaml", "unchanged"),
    file("references/other.md", "unchanged"),
  ],
  validation: [],
  suggestedTags: [],
  commitId: null,
  publishedUrl: null,
  publishedNote: null,
  patchPath: null,
  inLibrary: false,
  remote: {
    display: "https://github.com/acme/skills.git",
    onThisMachine: false,
    host: "github",
    tracked: { kind: "branch", name: "main" },
    requestUnavailable: null,
  },
  review: null,
  revision: 0,
  revising: false,
  stagingPath: "~/habi/contributions/c1/files",
  pushedCommit: null,
  attention: null,
  publishedAt: null,
  basedOn: null,
  basedOnRecorded: false,
  createdAt: "2026-10-02T00:00:00Z",
  updatedAt: "2026-10-02T00:00:00Z",
};

const remote = base.remote as NonNullable<Contribution["remote"]>;

const review: ReviewStatus = {
  host: "github",
  url: "https://github.com/acme/skills/pull/7",
  number: 7,
  state: "open",
  headCommit: null,
  approvedBy: [],
  comments: [],
  commentsTruncated: false,
  targetBranch: "main",
  visibility: "private",
  checkedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
};

const info = (gh: boolean, glab = false): AppInfo => ({
  version: "0",
  dataDir: "",
  platform: "macos",
  gitAvailable: true,
  ghAvailable: gh,
  glabAvailable: glab,
  startupError: null,
});

const sent: Contribution = {
  ...base,
  state: "published",
  commitId: "c0ffee",
  pushedCommit: "c0ffee",
  publishedUrl: review.url,
  publishedAt: new Date().toISOString(),
  basedOn: null,
  basedOnRecorded: false,
};

describe("sharing state", () => {
  it("never presents a prepared or pushed branch as a review request", () => {
    expect(sharingChip(base).label).toBe("Draft");
    expect(sharingChip({ ...base, revising: true, review }).label).toBe("Draft");
    expect(sharingChip({ ...base, state: "committed" }).label).toBe("Ready to submit");
    expect(sharingChip({ ...base, state: "exported" }).label).toBe("Ready to submit");
    expect(sharingChip({ ...sent, publishedUrl: null }).label).toBe("Branch pushed");
    expect(sharingChip(sent).label).toBe("Open PR");
    // Identical to the library before anything was prepared is not "merged".
    expect(sharingChip({ ...base, inLibrary: true }).label).toBe("Draft");
    expect(sharingChip({ ...sent, publishedUrl: null, inLibrary: true }).label).toBe("In the library");
  });

  it("states host-reported states with when they were checked", () => {
    const at = review.checkedAt;
    expect(sharingChip({ ...sent, review })).toMatchObject({ label: "Open PR", checkedAt: at });
    expect(sharingChip({ ...sent, review: { ...review, state: "changesRequested" } })).toMatchObject({
      label: "Changes requested",
      checkedAt: at,
    });
    expect(sharingChip({ ...sent, review: { ...review, state: "merged" } }).label).toBe("Merged");
    expect(sharingChip({ ...sent, review: { ...review, state: "closed" } }).label).toBe("Closed");
    expect(sharingChip({ ...sent, review: { ...review, host: "gitlab" } }).label).toBe("Open MR");
    expect(sharingChip({ ...base, state: "committed" }).checkedAt).toBeNull();
  });

  it("puts a failed operation above everything else", () => {
    const failed = {
      ...sent,
      attention: { kind: "send" as const, message: "denied", at: "2026-10-02T00:00:00Z" },
    };
    expect(sharingChip(failed).label).toBe("Needs attention");
    expect(nextAction(failed)).toEqual({ kind: "details", label: "Retry" });
  });

  it("offers exactly one next action", () => {
    expect(nextAction(base).label).toBe("Continue editing");
    expect(nextAction({ ...base, state: "committed" }).label).toBe("Review changes");
    expect(nextAction(sent)).toEqual({ kind: "open", label: "Open PR", url: review.url });
    expect(nextAction({ ...sent, review: { ...review, state: "changesRequested" } }).label).toBe(
      "Review changes",
    );
  });

  it("names the final action after the host and the tools that are installed", () => {
    const ready = { ...base, state: "committed" as const, commitId: "c0ffee" };
    expect(finalAction(ready, info(true)).label).toBe("Create pull request");
    expect(finalAction(ready, info(true)).openRequest).toBe(true);
    const gitlab = { ...ready, remote: { ...remote, host: "gitlab" as const } };
    expect(finalAction(gitlab, info(false, true)).label).toBe("Create merge request");
    const noCli = finalAction(ready, info(false));
    expect(noCli).toMatchObject({ label: "Push branch", openRequest: false });
    expect(noCli.note).toMatch(/export a patch/);
    const local = { ...ready, remote: { ...remote, onThisMachine: true, host: null } };
    expect(finalAction(local, info(true)).label).toBe("Push branch");
    // A revision of an open request pushes to the same branch and request.
    expect(finalAction({ ...sent, state: "committed" }, info(true)).label).toBe("Push revision");
  });

  it("says what it does not know about the destination", () => {
    expect(targetBranch(base)).toBe("main");
    expect(targetBranch({ ...base, remote: { ...remote, tracked: { kind: "default" } } })).toBe(
      "the repository's default branch",
    );
    expect(visibilityText(base)).toBe("Unknown — not checked");
    expect(visibilityText({ ...sent, review })).toBe("Private (reported by GitHub)");
  });
});

describe("sharing activity list", () => {
  it("shows one state, the destination and one action per contribution", async () => {
    const failed: Contribution = {
      ...base,
      id: "c2",
      title: "Share failing",
      state: "committed",
      attention: { kind: "send", message: "Permission denied", at: new Date().toISOString() },
    };
    handlers = {
      list_contributions: () => [{ ...sent, review }, failed, { ...base, id: "c3", title: "Share draft" }],
    };
    wrap(<ContributionsView />);
    const rows = (await screen.findAllByRole("listitem")).filter((r) => r.classList.contains("share-row"));
    // What needs you comes first; a request already out for review follows.
    expect(rows.map((r) => r.querySelector(".share-row-title")?.textContent)).toEqual([
      "Share failing",
      "Share draft",
      "Share JPA review",
    ]);
    const [attention, draft, open] = rows as [HTMLElement, HTMLElement, HTMLElement];
    // The state chip, and the action that opens the request on the host.
    expect(open.querySelector(".state-chip")?.textContent).toBe("Open PR");
    expect(within(open).getByRole("button", { name: "Open PR: Share JPA review" })).toBeInTheDocument();
    expect(within(open).getByText(/^checked 5 min ago$/)).toBeInTheDocument();
    expect(within(open).getByText("Team")).toBeInTheDocument();
    expect(within(open).getByText("habi/contrib/jpa-1a2b3c")).toBeInTheDocument();
    expect(
      within(open).getByRole("img", { name: /^Progress: Review done, Branch done, Send done$/ }),
    ).toBeInTheDocument();
    expect(
      within(draft).getByRole("img", { name: /^Progress: Review next, Branch to do, Send to do$/ }),
    ).toBeInTheDocument();
    expect(within(open).getAllByRole("button")).toHaveLength(2); // title link to details + "Open PR"
    expect(within(attention).getByText("Needs attention")).toBeInTheDocument();
    expect(
      within(attention)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Retry"]);
    expect(
      within(draft)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Continue editing"]);
  });
});

describe("contribution review", () => {
  it("lists changed files first, collapses unchanged ones and saves the selection", async () => {
    let current = base;
    handlers = {
      contribution: () => current,
      app_info: () => info(true),
      select_contribution_files: (args) => {
        const excluded = args.excluded as string[];
        current = {
          ...current,
          files: current.files.map((f) => ({
            ...f,
            included: f.status === "unchanged" || !excluded.includes(f.path),
          })),
        };
        return current;
      },
    };
    const user = userEvent.setup();
    wrap(<ContributionsView contributionId="c1" />, { name: "contributions", contributionId: "c1" });
    const changed = await screen.findByRole("list", { name: "Changed files" });
    expect(within(changed).getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getByText("2 unchanged files")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "docs/notes.md, renamed" }));
    expect(screen.getByText("Moved; the content is identical.")).toBeInTheDocument();
    expect(screen.getByText("references/notes.md")).toBeInTheDocument();

    // Leaving SKILL.md out sends every other left-out file along.
    await user.click(screen.getByRole("checkbox", { name: "Include SKILL.md" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("select_contribution_files", {
        id: "c1",
        excluded: ["skills/jpa/scripts/check.sh", "skills/jpa/SKILL.md"],
      }),
    );
    expect(await screen.findByRole("checkbox", { name: "Include SKILL.md" })).not.toBeChecked();
  });

  it("separates blocking problems from warnings and says what was checked", async () => {
    handlers = {
      contribution: () => ({
        ...base,
        validation: [
          { level: "error", message: "SKILL.md refers to scripts/check.sh, which is left out.", path: null },
          { level: "warning", message: "Nothing much.", path: null },
        ],
      }),
      app_info: () => info(true),
    };
    wrap(<ContributionsView contributionId="c1" />, { name: "contributions", contributionId: "c1" });
    expect(await screen.findByText(/Blocking · 1/)).toBeInTheDocument();
    expect(screen.getByText(/Warnings · 1/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Prepare branch" })).toBeDisabled();
    expect(screen.queryByText(/No problems found/)).toBeNull();
  });

  it("says exactly what was checked when nothing needs fixing", async () => {
    handlers = { contribution: () => base, app_info: () => info(true) };
    wrap(<ContributionsView contributionId="c1" />, { name: "contributions", contributionId: "c1" });
    expect(
      await screen.findByText(
        /Checked: package format, Habi metadata, file references, secrets — nothing to fix\./,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("This does not test what the skill does.")).toBeInTheDocument();
    expect(screen.getByText("main")).toBeInTheDocument();
    expect(screen.getByText("Unknown — not checked")).toBeInTheDocument();
  });

  it("offers the honest fallback when no command-line tool can open a request", async () => {
    handlers = {
      contribution: () => ({ ...base, state: "committed", commitId: "c0ffee" }),
      app_info: () => info(false),
    };
    wrap(<ContributionsView contributionId="c1" />, { name: "contributions", contributionId: "c1" });
    expect(await screen.findByRole("button", { name: "Push branch…" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export patch…" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Create pull request/ })).toBeNull();
  });
});
