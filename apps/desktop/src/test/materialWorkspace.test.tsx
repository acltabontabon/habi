import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { history } from "prosemirror-history";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalSkill } from "../bindings/LocalSkill";
import { ToastProvider } from "../components/Toasts";
import type { DocEditorHandle } from "../views/skills/studio/doc/DocEditor";
import { parseBody } from "../views/skills/studio/doc/markdown/parse";
import { write } from "../views/skills/studio/doc/markdown/reconcile";
import { type MaterialTarget, MaterialWorkspace } from "../views/skills/studio/files/MaterialWorkspace";
import type { SkillDraft } from "../views/skills/studio/useSkillDraft";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
// The material panel delegates file editing to the existing autosaving editor. Its own suite covers
// CodeMirror and autosave; this boundary exposes whether a failed close unmounts that editor.
vi.mock("../views/skills/studio/files/FileEditor", () => ({
  FileEditor: ({ file, readOnly }: { file: { path: string; text: string }; readOnly: boolean }) => (
    <textarea aria-label={`Editing ${file.path}`} defaultValue={file.text} readOnly={readOnly} />
  ),
  BinaryView: () => <span>Binary material</span>,
  size: (bytes: number) => `${bytes} bytes`,
}));

Element.prototype.scrollIntoView = () => {};
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () =>
  ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }) as DOMRect;
const views: EditorView[] = [];
afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
});
beforeEach(() => {
  invoke.mockReset();
});

const entry = (path: string) => ({ path, size: 20, digest: path, executable: false, text: true });
function fixture(body: string): LocalSkill {
  return {
    composes: [],
    compositionState: { interrupted: false, unmentioned: [] },
    summary: {
      id: "materials-test",
      name: "review",
      title: "Review",
      description: "Reviews a change.",
      origin: { type: "created" },
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-10-01T00:00:00Z",
      deletedAt: null,
      errors: 0,
      warnings: 0,
      links: [],
      hasApplicability: false,
      fileCount: 3,
      contentDigest: "original",
      modifiedLocally: null,
    },
    document: { name: "review", description: "Reviews a change.", body },
    documentDigest: "document",
    documentError: null,
    form: {
      title: "Review",
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
    metadataText: null,
    metadataDigest: null,
    metadataStatus: "undeclared",
    appliesWhen: null,
    excludes: null,
    scope: "module",
    files: [entry("SKILL.md"), entry("scripts/check.sh"), entry("references/policy.md")],
    diagnostics: [],
    location: "/tmp/material-workspace-test",
  };
}

function mount({
  body = "Read the change.\n",
  target = { path: null },
  readOnly = false,
}: {
  body?: string;
  target?: MaterialTarget;
  readOnly?: boolean;
} = {}) {
  let current = fixture(body);
  const parsed = parseBody(body);
  const view = new EditorView(document.createElement("div"), {
    state: EditorState.create({ doc: parsed.doc, plugins: [history()] }),
    editable: () => !readOnly,
  });
  views.push(view);
  const focus = vi.fn();
  const editor = { current: { view: () => view, focus } as unknown as DocEditorHandle };
  const flush = vi.fn(async () => true);
  const onAttach = vi.fn();
  const onClose = vi.fn();
  const onSource = vi.fn();
  const adopt = vi.fn();
  invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "read_skill_file")
      return { path: args.path, text: "echo checked\n", digest: "file-v1", binary: false, size: 13 };
    if (cmd === "write_skill_file") {
      current = { ...current, files: [...current.files, entry(String(args.path))] };
      return current;
    }
    if (cmd === "set_skill_file_executable") {
      current = {
        ...current,
        files: current.files.map((f) => (f.path === args.path ? { ...f, executable: true } : f)),
      };
      return current;
    }
    throw new Error(`Unexpected command ${cmd}`);
  });
  // biome-ignore lint/correctness/noComponentHookFactories: one stable component per isolated test mount.
  function Harness() {
    const [skill, setSkill] = useState(current);
    const [selected, setSelected] = useState(target);
    const draft = {
      id: skill.summary.id,
      skill,
      document: skill.document,
      trashed: readOnly,
      flushAll: flush,
      adopt: (fresh: LocalSkill, options: unknown) => {
        adopt(fresh, options);
        setSkill(fresh);
      },
    } as unknown as SkillDraft;
    return (
      <MaterialWorkspace
        draft={draft}
        target={selected}
        editor={editor}
        onTarget={setSelected}
        onAttach={onAttach}
        onClose={onClose}
        onSource={onSource}
      />
    );
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <Harness />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return {
    ...result,
    view,
    text: () => write(view.state.doc, parsed.baseline).text,
    flush,
    onAttach,
    onClose,
    focus,
    adopt,
  };
}

describe("materials beside the capability", () => {
  it("creates a script, references it at the existing selection, and opens its editor", async () => {
    const { view, flush, onAttach, container } = mount({ target: { path: null, create: "shell" } });
    const original = view.state.doc;
    await userEvent.type(screen.getByLabelText("New shell script"), "verify{Enter}");
    expect(await screen.findByLabelText("Editing scripts/verify.sh")).toBeInTheDocument();
    expect(onAttach).toHaveBeenCalledExactlyOnceWith("scripts/verify.sh");
    expect(invoke).toHaveBeenCalledWith(
      "write_skill_file",
      expect.objectContaining({ path: "scripts/verify.sh", baseDigest: null }),
    );
    expect(invoke).toHaveBeenCalledWith(
      "set_skill_file_executable",
      expect.objectContaining({ path: "scripts/verify.sh", executable: true }),
    );
    expect(flush.mock.invocationCallOrder[0]).toBeLessThan(invoke.mock.invocationCallOrder[0] ?? 0);
    expect(view.state.doc).toBe(original);
    expect(container.querySelector(".material-workspace")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "verify.sh" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Run/ })).not.toBeInTheDocument();
  });

  it("keeps the open editor and pending text when a close cannot flush", async () => {
    const { flush, onClose, focus } = mount({ target: { path: "scripts/check.sh" } });
    const file = await screen.findByLabelText("Editing scripts/check.sh");
    await userEvent.type(file, "pending edit");
    flush.mockResolvedValue(false);
    await userEvent.click(screen.getByRole("button", { name: "Close material workspace" }));
    expect(await screen.findByText(/Save or resolve the pending edits/)).toBeInTheDocument();
    expect(screen.getByLabelText("Editing scripts/check.sh")).toBe(file);
    expect(file).toHaveValue("echo checked\npending edit");
    expect(onClose).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    flush.mockResolvedValue(true);
    fireEvent.keyDown(screen.getByRole("complementary", { name: "Material workspace" }), { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(focus).toHaveBeenCalledOnce();
  });

  it("creates a missing reference with a null base, adopting the new package", async () => {
    const { adopt, onAttach } = mount({
      body: "Read [the guide](references/missing.md).\n",
      target: { path: "references/missing.md" },
    });
    expect(screen.getByText("Not in this package")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Create missing file" }));
    expect(await screen.findByLabelText("Editing references/missing.md")).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("write_skill_file", {
      id: "materials-test",
      path: "references/missing.md",
      text: "",
      baseDigest: null,
    });
    expect(adopt).toHaveBeenCalledWith(expect.anything(), { document: false, metadata: false });
    expect(onAttach).not.toHaveBeenCalled();
  });

  it.each(["assets/diagram.png", "references/report.pdf"])(
    "does not create an empty text file for missing %s",
    async (path) => {
      mount({ body: `Read [the material](${path}).\n`, target: { path } });
      expect(screen.getByText("Not in this package")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Create missing file" })).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Bring an existing file" }));
      expect(await screen.findByRole("button", { name: "Bring an existing file…" })).toBeInTheDocument();
      expect(invoke).not.toHaveBeenCalled();
    },
  );

  it("never overwrites a file that appeared after the missing reference was inspected", async () => {
    const { adopt } = mount({ target: { path: "references/missing.md" } });
    invoke.mockRejectedValue({ code: "conflict", message: "The file appeared outside Habi." });
    await userEvent.click(screen.getByRole("button", { name: "Create missing file" }));
    expect(await screen.findByText("The file appeared outside Habi.")).toBeInTheDocument();
    expect(adopt).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke.mock.calls[0]?.[1].baseDigest).toBeNull();
  });

  it("keeps read-only references inspectable without exposing mutation controls", async () => {
    mount({
      body: "Read [the guide](references/policy.md).\n",
      target: { path: "references/policy.md" },
      readOnly: true,
    });
    expect(await screen.findByLabelText("Editing references/policy.md")).toHaveAttribute("readonly");
    expect(screen.queryByRole("region", { name: "Where this material is used" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Disconnect" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect to this instruction" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: /Replace reference/ })).not.toBeInTheDocument();
  });
});
