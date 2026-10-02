import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { type ReactNode, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportInspection } from "../bindings/ImportInspection";
import type { ShareForm } from "../bindings/ShareForm";
import type { SkillPreview } from "../bindings/SkillPreview";
import { ToastProvider } from "../components/Toasts";
import { type Actions, ActionsContext } from "../lib/actions";
import { HabiError } from "../lib/api";
import { NavProvider } from "../lib/nav";
import { identifierProblem, slugify } from "../lib/skills";
import { tagFromInput } from "../lib/tags";
import { useAutosave } from "../lib/useAutosave";
import { AddSkillsDialog } from "../views/skills/AddSkillsDialog";
import { ApplicabilityPreview } from "../views/skills/ApplicabilityPreview";
import { ConditionBuilder } from "../views/skills/ConditionBuilder";
import { SkillsEmpty } from "../views/skills/SkillsEmpty";
import { Welcome } from "../views/Welcome";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const actions: Actions = { openProject: vi.fn(async () => {}), newSkill: vi.fn(), addSkills: vi.fn() };

function wrap(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <NavProvider initial={{ name: "welcome" }}>
          <ActionsContext.Provider value={actions}>{ui}</ActionsContext.Provider>
        </NavProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const emptyForm: ShareForm = {
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

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "recent_projects" || cmd === "list_skills" || cmd === "list_sources") return [];
    throw { code: "notFound", message: `no mock for ${cmd}` };
  });
});

describe("autosave", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(save: (v: string) => Promise<void>) {
    return renderHook(({ value }) => useAutosave<string>({ value, keyOf: (v) => v, save, delay: 500 }), {
      initialProps: { value: "one" },
    });
  }

  it("says saved only after the write succeeds", async () => {
    let finish: () => void = () => {};
    const save = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const hook = setup(save);
    expect(hook.result.current.state).toBe("clean");
    hook.rerender({ value: "two" });
    expect(hook.result.current.state).toBe("pending");
    expect(save).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(save).toHaveBeenCalledWith("two");
    expect(hook.result.current.state).toBe("saving");
    await act(async () => {
      finish();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(hook.result.current.state).toBe("saved");
  });

  it("writes edits made during a save, and reports a failed write as not saved", async () => {
    const written: string[] = [];
    let fail = false;
    const save = vi.fn(async (v: string) => {
      if (fail) throw new HabiError({ code: "io", message: "disk full" });
      written.push(v);
    });
    const hook = setup(save);
    hook.rerender({ value: "two" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    hook.rerender({ value: "three" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(written).toEqual(["two", "three"]);
    expect(hook.result.current.state).toBe("saved");

    fail = true;
    hook.rerender({ value: "four" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(hook.result.current.state).toBe("error");
    expect(written).toEqual(["two", "three"]);
  });

  it("stops on a conflict until the author chooses, then keeps theirs", async () => {
    let conflict = true;
    const written: string[] = [];
    const save = vi.fn(async (v: string) => {
      if (conflict) throw new HabiError({ code: "conflict", message: "changed outside Habi" });
      written.push(v);
    });
    const hook = setup(save);
    hook.rerender({ value: "mine" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(hook.result.current.state).toBe("conflict");
    // Further edits do not overwrite the other version behind the author's back.
    hook.rerender({ value: "mine, edited" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(save).toHaveBeenCalledTimes(1);
    conflict = false;
    await act(async () => {
      hook.result.current.retry();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(written).toEqual(["mine, edited"]);
    expect(hook.result.current.state).toBe("saved");
  });
});

describe("condition builder", () => {
  function Harness({ onForm }: { onForm: (f: ShareForm) => void }) {
    const [form, setForm] = useState(emptyForm);
    return (
      <ConditionBuilder
        form={form}
        projects={[]}
        onChange={(f) => {
          setForm(f);
          onForm(f);
        }}
      />
    );
  }

  it("turns plain names into conditions without asking for YAML", async () => {
    const user = userEvent.setup();
    const onForm = vi.fn();
    wrap(<Harness onForm={onForm} />);
    const applies = screen.getByRole("region", { name: "Applies to a project when" });
    await user.type(within(applies).getByLabelText("Add a condition"), "Spring Boot{Enter}");
    expect(onForm).toHaveBeenLastCalledWith(
      expect.objectContaining({ appliesTags: ["framework:spring-boot"] }),
    );
    expect(within(applies).getByText("uses Spring Boot")).toBeInTheDocument();

    await user.selectOptions(within(applies).getByLabelText("Add a condition: kind"), "dependency");
    await user.type(within(applies).getByLabelText("Add a condition"), "org.liquibase:liquibase-core{Enter}");
    expect(onForm).toHaveBeenLastCalledWith(
      expect.objectContaining({ appliesDependencies: ["org.liquibase:liquibase-core"] }),
    );
    // With two conditions, how they combine becomes a choice.
    await user.click(within(applies).getByRole("radio", { name: "any one holds" }));
    expect(onForm).toHaveBeenLastCalledWith(expect.objectContaining({ matchMode: "any" }));

    await user.click(within(applies).getByRole("button", { name: "Remove: uses Spring Boot" }));
    expect(onForm).toHaveBeenLastCalledWith(expect.objectContaining({ appliesTags: [] }));
  });

  it("explains an unknown technology instead of inventing a rule", async () => {
    const user = userEvent.setup();
    const onForm = vi.fn();
    wrap(<Harness onForm={onForm} />);
    const applies = screen.getByRole("region", { name: "Applies to a project when" });
    await user.type(within(applies).getByLabelText("Add a condition"), "something vague{Enter}");
    expect(onForm).not.toHaveBeenCalled();
    expect(within(applies).getByRole("alert")).toHaveTextContent(/Choose a technology/);
  });

  it("has no detectable accessibility violations", async () => {
    const { container } = wrap(<Harness onForm={() => {}} />);
    const results = await axe.run(container);
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  });
});

describe("applicability preview", () => {
  const project = (id: string, name: string) => ({
    id,
    name,
    path: `~/work/${name}`,
    exists: true,
    lastOpenedAt: "2026-10-02T00:00:00Z",
    exclusions: [],
    sample: false,
    summary: null,
  });
  const result = (applicability: "applies" | "doesNotApply" | "needsInformation", reason: string) => ({
    applicability,
    scope: "module" as const,
    modules: [],
    reason,
    specificity: 1,
  });
  const preview = (reason: string): SkillPreview => ({
    appliesWhen: { op: "tag", tag: "framework:spring-boot" },
    excludes: null,
    scope: "module",
    problem: null,
    projects: [
      {
        project: project("p2", "storefront"),
        result: result("doesNotApply", "Conditions not met"),
        error: null,
        inspectedAt: "2026-10-02T00:00:00Z",
        incomplete: [],
        prerequisites: [],
      },
      {
        project: project("p3", "reporting-service"),
        result: result("needsInformation", "Not established: parent POM is outside the repository"),
        error: null,
        inspectedAt: "2026-10-02T00:00:00Z",
        incomplete: [],
        prerequisites: [],
      },
      {
        project: project("p1", "billing-service"),
        result: result("applies", reason),
        error: null,
        inspectedAt: "2026-10-02T00:00:00Z",
        incomplete: [],
        prerequisites: [],
      },
    ],
  });

  it("keeps applies, absent and unknown apart, and never calls a match a test", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "preview_skill") return preview("Uses Spring Boot (pom.xml:6)");
      return null;
    });
    wrap(
      <ApplicabilityPreview
        request={{ skillId: "s", form: emptyForm, metadataText: null }}
        requestKey="a"
        hasProjects
        onOpenProject={() => {}}
      />,
    );
    const rows = await screen.findAllByRole("listitem");
    // Matches first, then open questions, then the rest.
    expect(
      rows.map((r) => within(r).getByText(/Applies|Needs information|Does not apply/).textContent),
    ).toEqual(["Applies", "Needs information", "Does not apply"]);
    expect(screen.getByText("1 of 3 projects · 1 unknown")).toBeInTheDocument();
    expect(screen.getByText(/not that the skill was tried there/)).toBeInTheDocument();
    expect(screen.queryByText(/tested|verified/i)).toBeNull();
  });

  it("cancels the obsolete job and ignores its late answer", async () => {
    const pending: { resolve: (p: SkillPreview) => void; job: string }[] = [];
    const cancelled: string[] = [];
    invoke.mockImplementation((cmd: string, args: { jobId: string }) => {
      if (cmd === "preview_skill") {
        return new Promise<SkillPreview>((resolve) => pending.push({ resolve, job: args.jobId }));
      }
      if (cmd === "cancel_job") cancelled.push(args.jobId);
      return Promise.resolve(true);
    });
    const view = (key: string) => (
      <ApplicabilityPreview
        request={{ skillId: "s", form: emptyForm, metadataText: null }}
        requestKey={key}
        hasProjects
        onOpenProject={() => {}}
      />
    );
    const client = new QueryClient();
    const { rerender } = render(<QueryClientProvider client={client}>{view("first")}</QueryClientProvider>);
    await waitFor(() => expect(pending).toHaveLength(1));
    rerender(<QueryClientProvider client={client}>{view("second")}</QueryClientProvider>);
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(cancelled).toEqual([pending[0]?.job]);
    // The newer answer arrives first; the older one must not replace it.
    await act(async () => pending[1]?.resolve(preview("NEW RULES")));
    await act(async () => pending[0]?.resolve(preview("OLD RULES")));
    expect(await screen.findByText("NEW RULES")).toBeInTheDocument();
    expect(screen.queryByText("OLD RULES")).toBeNull();
  });

  it("does not block the draft when no project is open", () => {
    wrap(
      <ApplicabilityPreview
        request={{ skillId: "s", form: emptyForm, metadataText: null }}
        requestKey="a"
        hasProjects={false}
        onOpenProject={() => {}}
      />,
    );
    expect(screen.getByText(/The draft does not need one/)).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith("preview_skill", expect.anything());
  });
});

describe("add skills", () => {
  const candidate = (over: Partial<ImportInspection["candidates"][number]>) => ({
    path: "skills/incident-notes",
    name: "incident-notes",
    title: "Incident notes",
    description: "Turn a chat log into a timeline.",
    license: null,
    hasMetadata: false,
    files: ["SKILL.md"],
    size: 100,
    problems: [],
    complete: true,
    digest: "sha256:a",
    duplicate: null,
    suggestedName: null,
    ...over,
  });

  it("inspects before writing and never preselects a duplicate", async () => {
    const user = userEvent.setup();
    const calls: { cmd: string; args: unknown }[] = [];
    invoke.mockImplementation(async (cmd: string, args: unknown) => {
      calls.push({ cmd, args });
      if (cmd === "recent_projects" || cmd === "list_sources") return [];
      if (cmd === "pick_import_folder") return "/skills";
      if (cmd === "inspect_import") {
        return {
          origin: "/skills",
          notes: [],
          candidates: [
            candidate({}),
            candidate({
              path: "skills/threat-model",
              name: "threat-model",
              title: "Threat model",
              duplicate: { kind: "sameContent", skillId: "x", title: "Threat model" },
              suggestedName: "threat-model-2",
            }),
          ],
        } satisfies ImportInspection;
      }
      if (cmd === "import_skills") return { imported: [], skipped: [] };
      throw { code: "notFound", message: cmd };
    });
    wrap(<AddSkillsDialog start={{ source: "folder" }} onClose={() => {}} />);
    expect(await screen.findByRole("checkbox", { name: "Incident notes" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Threat model" })).not.toBeChecked();
    expect(calls.some((c) => c.cmd === "import_skills")).toBe(false);

    // Taking the duplicate anyway asks for a new identifier, prefilled and editable.
    await user.click(screen.getByRole("checkbox", { name: "Threat model" }));
    expect(screen.getByLabelText(/Import as/)).toHaveValue("threat-model-2");
    await user.click(screen.getByRole("button", { name: "Copy 2 skills to My skills" }));
    const sent = calls.find((c) => c.cmd === "import_skills")?.args as { selections: unknown };
    expect(sent.selections).toEqual([
      { path: "skills/incident-notes", rename: null },
      { path: "skills/threat-model", rename: "threat-model-2" },
    ]);
  });
});

describe("identifiers and technologies", () => {
  it("derives and checks identifiers like the core does", () => {
    expect(slugify("Release notes: écrire & ship")).toBe("release-notes-crire-ship");
    expect(identifierProblem("migration-review")).toBeNull();
    expect(identifierProblem("Migration Review")).toMatch(/lowercase/);
    expect(identifierProblem("a--b")).toMatch(/Hyphens/);
    expect(identifierProblem("")).toMatch(/Needed/);
  });

  it("maps names to tags and refuses free text", () => {
    expect(tagFromInput("spring boot")).toBe("framework:spring-boot");
    expect(tagFromInput("lang:kotlin")).toBe("lang:kotlin");
    expect(tagFromInput("team:payments")).toBe("team:payments");
    expect(tagFromInput("anything else")).toBeNull();
  });
});

describe("my skills, before the first skill", () => {
  it("explains what a skill is and offers both ways in", async () => {
    const user = userEvent.setup();
    const { container } = wrap(<SkillsEmpty />);
    await user.click(screen.getByRole("button", { name: /Create a skill/ }));
    expect(actions.newSkill).toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /A folder/ }));
    expect(actions.addSkills).toHaveBeenLastCalledWith({ source: "folder" });
    await user.click(screen.getByRole("button", { name: /A Git repository/ }));
    expect(actions.addSkills).toHaveBeenLastCalledWith({ source: "git" });
    // An idea opens the dialog already filled in.
    await user.click(screen.getByRole("button", { name: /Ship a release/ }));
    expect(actions.newSkill).toHaveBeenLastCalledWith({
      title: "Ship a release",
      template: "implementationGuide",
    });
    // Pointing at a note lights the lines of the specimen it explains.
    await user.hover(screen.getByRole("button", { name: /Steps/ }));
    expect(container.querySelectorAll(".specimen-line.is-lit")).toHaveLength(5);
    const results = await axe.run(container);
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  });
});

describe("welcome", () => {
  it("leads with one action, opening a project, and needs no library", async () => {
    const user = userEvent.setup();
    const { container } = wrap(<Welcome />);
    const open = await screen.findByRole("button", { name: "Open a project…" });
    expect(open).toHaveClass("btn-primary");
    expect(container.querySelectorAll(".btn-primary")).toHaveLength(1);
    // A library is optional: offered as a quiet link, never as the main action.
    expect(screen.getByRole("button", { name: "Connect a library" })).toHaveClass("link-quiet");
    await user.click(open);
    expect(actions.openProject).toHaveBeenCalled();
    // One primary action; creating and adding skills live in the sidebar,
    // the palette and project views, with their shortcuts shown here.
    expect(screen.queryByRole("button", { name: /Create a skill/ })).toBeNull();
    expect(screen.getByText("new skill")).toBeInTheDocument();
    expect(screen.getByText("read-only")).toBeInTheDocument();
    // First run: the labeled sample workspace is the one alternative, and
    // where things stand is a plain line.
    expect(screen.getByRole("button", { name: "Try the sample workspace" })).not.toHaveClass("btn-primary");
    expect(screen.getByRole("button", { name: "Write a skill" })).toHaveClass("link-quiet");
    expect(container.querySelector(".home-status")).toHaveTextContent(
      "0 libraries · 0 of your skills · nothing shared yet",
    );
    expect(screen.getByText(/Nothing changes until you review a plan/)).toBeInTheDocument();
    const results = await axe.run(container);
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  });
});
