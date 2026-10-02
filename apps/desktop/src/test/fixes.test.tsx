import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CheckPreview } from "../bindings/CheckPreview";
import type { CheckRun } from "../bindings/CheckRun";
import type { Contribution } from "../bindings/Contribution";
import type { LocalSkill } from "../bindings/LocalSkill";
import type { ProjectOverview } from "../bindings/ProjectOverview";
import type { ShareForm } from "../bindings/ShareForm";
import type { Source } from "../bindings/Source";
import { localLinkPath, Markdown } from "../components/Markdown";
import { ToastProvider } from "../components/Toasts";
import { Button } from "../components/ui";
import { NavProvider, type Route } from "../lib/nav";
import { ContributionsView } from "../views/contributions/ContributionsView";
import { ChecksPanel } from "../views/project/ChecksPanel";
import { ShareSkillDialog } from "../views/skills/ShareSkillDialog";
import details from "./fixtures/item-details.json";
import billing from "./fixtures/overview-billing-service.json";

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
    if (cmd === "recent_projects" || cmd === "list_skills") return [];
    throw { code: "notFound", message: `no mock for ${cmd}` };
  });
});

function wrap(ui: ReactNode, initial: Route = { name: "welcome" }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <NavProvider initial={initial}>{ui}</NavProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const form: ShareForm = {
  title: "Migration review",
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
};

const contribution: Contribution = {
  id: "c1",
  sourceId: "team",
  sourceName: "Team",
  title: "Share Migration review",
  message: "",
  itemPath: "skills/migration-review",
  baseCommit: "abc",
  branch: "habi/contrib/migration-review-1",
  state: "draft",
  origin: { type: "localSkill", skillId: "k" },
  form,
  files: [
    {
      path: "skills/migration-review/SKILL.md",
      previousPath: null,
      status: "added",
      size: 10,
      diff: { hunks: [], added: 1, removed: 0, binary: false, truncated: false },
      included: true,
      required: "A new skill cannot be shared without its SKILL.md.",
    },
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
  stagingPath: "~/habi/contributions/c/files",
  pushedCommit: null,
  attention: null,
  publishedAt: null,
  basedOn: null,
  basedOnRecorded: false,
  createdAt: "2026-10-02T00:00:00Z",
  updatedAt: "2026-10-02T00:00:00Z",
};

describe("Button", () => {
  it("stays disabled while busy even when the caller passes disabled={false}", async () => {
    const onClick = vi.fn();
    render(
      <Button busy disabled={false} onClick={onClick}>
        Apply
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Apply" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    await userEvent.setup().click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("keeps type=submit when asked", () => {
    render(<Button type="submit">Go</Button>);
    expect(screen.getByRole("button", { name: "Go" })).toHaveAttribute("type", "submit");
  });
});

describe("checks", () => {
  it("keeps showing a run's result after preparing the next preview", async () => {
    const overview = billing as unknown as ProjectOverview;
    const recommendation = overview.recommendations.find((r) => r.item.id === "liquibase-migration-review");
    if (!recommendation) throw new Error("fixture changed");
    const detail = (details as Record<string, { item: { contentDigest: string } }>)[
      "liquibase-migration-review"
    ];
    let previews = 0;
    const preview = (): CheckPreview => ({
      previewId: `p${++previews}`,
      itemKey: recommendation.item.key,
      itemTitle: recommendation.item.title,
      itemDigest: detail?.item.contentDigest ?? "",
      checkId: "changelog-is-wellformed",
      title: "Changelog is well formed",
      description: null,
      module: ".",
      program: "mvn",
      resolvedProgram: "/usr/bin/mvn",
      args: ["validate"],
      cwd: ".",
      environment: "Your environment",
      timeoutSeconds: 60,
      warnings: [],
      bindings: [],
      ready: true,
    });
    const run: CheckRun = {
      id: "r1",
      itemKey: recommendation.item.key,
      itemDigest: detail?.item.contentDigest ?? "",
      checkId: "changelog-is-wellformed",
      module: ".",
      argv: ["mvn", "validate"],
      cwd: ".",
      projectFingerprint: "f",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      exitCode: 0,
      status: "timedOut",
      outputTail: "BUILD OUTPUT TAIL",
    };
    handlers = {
      item_detail: () => detail,
      check_runs: () => [],
      prepare_check: () => preview(),
      run_check: () => run,
    };
    const user = userEvent.setup();
    wrap(<ChecksPanel overview={overview} recommendation={recommendation} />);
    await user.click(await screen.findByRole("button", { name: "Preview the command" }));
    await user.click(await screen.findByRole("button", { name: "Run this command" }));
    await waitFor(() => expect(previews).toBe(2));
    // Plain words, not the raw status value, and the output stays visible.
    expect(await screen.findByText("Timed out")).toBeInTheDocument();
    expect(screen.getByText("BUILD OUTPUT TAIL")).toBeInTheDocument();
    expect(screen.queryByText("timedOut")).toBeNull();
  });
});

describe("share dialog", () => {
  const library: Source = {
    id: "team",
    name: "Team",
    kind: "git",
    role: "team",
    location: "https://github.com/acme/skills.git",
    subdir: null,
    tracked: { kind: "default" },
    createdAt: "2026-10-01T00:00:00Z",
    snapshot: "abc",
    snapshotAt: "2026-10-01T00:00:00Z",
    commitSummary: null,
    lastAttemptAt: null,
    lastError: null,
    warning: null,
    freshness: "current",
    sample: false,
  };
  const skill = {
    summary: {
      id: "k",
      name: "migration-review",
      title: "Migration review",
      description: "Reviews migrations",
      origin: { type: "draft" },
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-10-01T00:00:00Z",
      deletedAt: null,
      errors: 0,
      warnings: 0,
      hasApplicability: true,
      fileCount: 1,
      contentDigest: "d",
    },
    diagnostics: [],
  } as unknown as LocalSkill;

  it("continues an open contribution instead of starting a second request", async () => {
    const pushed: Contribution = {
      ...contribution,
      state: "published",
      pushedCommit: "def",
      publishedUrl: "https://github.com/acme/skills/pull/7",
    };
    handlers = {
      list_sources: () => [library],
      list_contributions: () => [pushed],
      start_contribution: () => contribution,
    };
    wrap(<ShareSkillDialog skill={skill} onClose={() => {}} />);
    const continueButton = await screen.findByRole("button", { name: "Continue sharing" });
    expect(continueButton).toHaveClass("btn-primary");
    const fresh = screen.getByRole("button", { name: "Start a new contribution" });
    expect(fresh).not.toHaveClass("btn-primary");
    expect(screen.getByText(/revision of the same pull request/)).toBeInTheDocument();
    await userEvent.setup().click(continueButton);
    expect(invoke.mock.calls.some(([cmd]) => cmd === "start_contribution")).toBe(false);
  });

  it("offers a new contribution once the earlier request was merged", async () => {
    const merged: Contribution = {
      ...contribution,
      state: "published",
      pushedCommit: "def",
      review: {
        host: "github",
        url: "https://github.com/acme/skills/pull/7",
        number: 7,
        state: "merged",
        headCommit: null,
        approvedBy: [],
        comments: [],
        commentsTruncated: false,
        targetBranch: "main",
        visibility: null,
        checkedAt: new Date().toISOString(),
      },
    };
    handlers = { list_sources: () => [library], list_contributions: () => [merged] };
    wrap(<ShareSkillDialog skill={skill} onClose={() => {}} />);
    expect(await screen.findByRole("button", { name: "Review what will be shared…" })).toHaveClass(
      "btn-primary",
    );
    expect(screen.queryByRole("button", { name: "Continue sharing" })).toBeNull();
  });
});

describe("contribution page", () => {
  it("asks before discarding and says what happens to an open request", async () => {
    const pushed: Contribution = {
      ...contribution,
      state: "published",
      commitId: "c0ffee",
      pushedCommit: "c0ffee",
      publishedUrl: "https://github.com/acme/skills/pull/7",
    };
    handlers = {
      contribution: () => pushed,
      app_info: () => ({ ghAvailable: true, glabAvailable: false }),
      discard_contribution: () => null,
    };
    const user = userEvent.setup();
    wrap(<ContributionsView contributionId="c1" />, { name: "contributions", contributionId: "c1" });
    await user.click(await screen.findByRole("button", { name: /^Discard this contribution/ }));
    expect(invoke.mock.calls.some(([cmd]) => cmd === "discard_contribution")).toBe(false);
    expect(screen.getByText(/deletes its prepared branch here/)).toBeInTheDocument();
    expect(screen.getByText(/An open pull request on GitHub stays open/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Keep it" }));
    expect(screen.queryByText(/deletes its prepared branch here/)).toBeNull();
    await user.click(screen.getByRole("button", { name: /^Discard this contribution/ }));
    await user.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(invoke.mock.calls.some(([cmd]) => cmd === "discard_contribution")).toBe(true));
  });

  it("saves unsaved reviewer edits before preparing the branch", async () => {
    const order: string[] = [];
    let saved = contribution;
    handlers = {
      contribution: () => saved,
      app_info: () => ({ ghAvailable: true, glabAvailable: false }),
      update_contribution: (args) => {
        order.push(`update:${String(args.title)}`);
        saved = { ...saved, title: String(args.title) };
        return saved;
      },
      commit_contribution: () => {
        order.push("commit");
        return { ...saved, state: "committed", commitId: "c0ffee" };
      },
      list_contributions: () => [saved],
    };
    const user = userEvent.setup();
    wrap(<ContributionsView contributionId="c1" />, { name: "contributions", contributionId: "c1" });
    const title = await screen.findByLabelText("Contribution title");
    await user.clear(title);
    await user.type(title, "Better title");
    await user.click(screen.getByRole("button", { name: "Prepare branch" }));
    await waitFor(() => expect(order).toContain("commit"));
    expect(order[order.length - 1]).toBe("commit");
    expect(order).toContain("update:Better title");
  });

  it("shows a failed push inside the Send dialog", async () => {
    const prepared: Contribution = { ...contribution, state: "committed", commitId: "c0ffee" };
    handlers = {
      contribution: () => prepared,
      app_info: () => ({ ghAvailable: true, glabAvailable: false }),
      publish_contribution: () => {
        throw { code: "gitAuthentication", message: "Permission denied (publickey)." };
      },
    };
    const user = userEvent.setup();
    wrap(<ContributionsView contributionId="c1" />, { name: "contributions", contributionId: "c1" });
    await user.click(await screen.findByRole("button", { name: "Create pull request…" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(screen.getByRole("button", { name: "Create pull request" }));
    expect(await screen.findByText("Permission denied (publickey).")).toBeInTheDocument();
    expect(dialog).toContainElement(screen.getByText("Permission denied (publickey)."));
  });
});

describe("Markdown links", () => {
  it("normalizes relative links and explains links it will not open", async () => {
    expect(localLinkPath("./references/x.md#part")).toBe("references/x.md");
    expect(localLinkPath("references/a%20b.md")).toBe("references/a b.md");
    expect(localLinkPath("https://example.invalid")).toBeNull();
    expect(localLinkPath("../outside.md")).toBeNull();
    const open = vi.fn();
    render(
      <Markdown
        text={"[ref](./references/x.md) [gone](./missing.md) [plain](http://example.invalid)"}
        files={["SKILL.md", "references/x.md"]}
        onLocalLink={open}
      />,
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "ref" }));
    expect(open).toHaveBeenCalledWith("references/x.md");
    expect(screen.getByText(/missing.md is not among this skill's files/)).toBeInTheDocument();
    expect(screen.getByText(/Habi opens only https links/)).toBeInTheDocument();
  });
});
