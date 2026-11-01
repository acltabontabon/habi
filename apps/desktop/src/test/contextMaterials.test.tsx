import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalSkill } from "../bindings/LocalSkill";
import type { SkillFileEntry } from "../bindings/SkillFileEntry";
import { api } from "../lib/api";
import { Materials } from "../views/skills/studio/files/Materials";
import { MaterialWorkspace } from "../views/skills/studio/files/MaterialWorkspace";
import type { SkillDraft } from "../views/skills/studio/useSkillDraft";

// These checks exercise package operations and their contextual callbacks. The shared
// editor's persistence/conflict behavior remains covered by the Studio suite.
vi.mock("../views/skills/studio/files/FileEditor", () => ({
  FileEditor: ({ file }: { file: { path: string; text: string } }) => (
    <section aria-label={`Editing ${file.path}`}>{file.text}</section>
  ),
  BinaryView: () => <div>Binary preview</div>,
  size: (n: number) => `${n} B`,
}));

afterEach(() => vi.restoreAllMocks());
const entry = (path: string, executable = false): SkillFileEntry => ({
  path,
  executable,
  size: 10,
  digest: path,
  text: true,
});
const initial = {
  summary: { id: "test" },
  files: [entry("SKILL.md"), entry("scripts/check.py", true)],
  diagnostics: [],
} as unknown as LocalSkill;

function Harness({
  startWith,
  purpose,
  packageSkill = initial,
  onCreated = vi.fn(),
  onReference = vi.fn(),
  initialPath = null,
  readOnly = false,
}: {
  startWith?: string;
  purpose?: string;
  packageSkill?: LocalSkill;
  onCreated?: (path: string, purpose?: string) => void;
  onReference?: (path: string, purpose?: string) => void;
  initialPath?: string | null;
  readOnly?: boolean;
}) {
  const [skill, setSkill] = useState(packageSkill);
  const [path, setPath] = useState(initialPath);
  return (
    <Materials
      contextual
      startWith={startWith}
      purpose={purpose}
      onCreated={onCreated}
      skill={skill}
      readOnly={readOnly}
      active
      source={false}
      path={path}
      instructions="Use `scripts/check.py` to inspect changes."
      beforeChange={async () => {}}
      onSkill={setSkill}
      onPath={setPath}
      onSource={() => {}}
      onReference={onReference}
      onWhen={() => {}}
    />
  );
}
function mockRead() {
  vi.spyOn(api, "readSkillFile").mockImplementation(async (_id, path) => ({
    path,
    text: "print('review')\n",
    binary: false,
    size: 16,
    digest: path,
    preview: null,
  }));
}

describe("materials beside the instruction", () => {
  it("creates a contextual Python script and connects its single package path after success", async () => {
    const onCreated = vi.fn();
    const write = vi
      .spyOn(api, "writeSkillFile")
      .mockImplementation(async (_id, path) => ({ ...initial, files: [...initial.files, entry(path)] }));
    const executable = vi.spyOn(api, "setSkillFileExecutable").mockImplementation(async (_id, path) => ({
      ...initial,
      files: [...initial.files, entry(path, true)],
    }));
    mockRead();
    render(<Harness startWith="python" onCreated={onCreated} />);
    await userEvent.type(screen.getByLabelText("New python script"), "changed files{Enter}");
    await waitFor(() => expect(onCreated).toHaveBeenCalledExactlyOnceWith("scripts/changed files.py"));
    expect(write.mock.calls[0]?.[3]).toBeNull();
    expect(executable).toHaveBeenCalledWith("test", "scripts/changed files.py", true);
    expect(await screen.findByLabelText("Editing scripts/changed files.py")).toBeInTheDocument();
    expect(screen.queryByText(/Executable bit set/)).not.toBeInTheDocument();
  });

  it.each([
    ["Shell", "New shell script", "verify.sh", "#!/usr/bin/env bash"],
    ["JavaScript", "New javascript script", "verify.mjs", "#!/usr/bin/env node"],
    ["Other", "New empty script", "verify.rb", ""],
  ])("creates a %s script from the same clean picker", async (type, label, filename, prefix) => {
    const onCreated = vi.fn();
    const write = vi.spyOn(api, "writeSkillFile").mockImplementation(async (_id, path) => ({
      ...initial,
      files: [...initial.files, entry(path)],
    }));
    vi.spyOn(api, "setSkillFileExecutable").mockImplementation(async (_id, path) => ({
      ...initial,
      files: [...initial.files, entry(path, true)],
    }));
    mockRead();
    render(<Harness startWith="python" onCreated={onCreated} />);
    await userEvent.click(screen.getByRole("button", { name: new RegExp(`^${type}$`) }));
    await userEvent.type(screen.getByLabelText(label), `${filename}{Enter}`);
    await waitFor(() => expect(onCreated).toHaveBeenCalledExactlyOnceWith(`scripts/${filename}`));
    expect(write.mock.calls[0]?.[2]).toMatch(new RegExp(`^${prefix}`));
  });

  it("connects authored intent literally when creating and reusing material", async () => {
    const onCreated = vi.fn();
    const onReference = vi.fn();
    const purpose = "  check [untrusted] input before approving  ";
    vi.spyOn(api, "writeSkillFile").mockImplementation(async (_id, path) => ({
      ...initial,
      files: [...initial.files, entry(path)],
    }));
    mockRead();
    render(<Harness purpose={purpose} onCreated={onCreated} onReference={onReference} />);
    await userEvent.click(screen.getByRole("button", { name: "Reference check.py here" }));
    expect(onReference).toHaveBeenCalledExactlyOnceWith("scripts/check.py", purpose.trim());
    await userEvent.click(screen.getByRole("button", { name: /Knowledge to consult/ }));
    await userEvent.click(screen.getByRole("button", { name: "Create a reference" }));
    await userEvent.type(screen.getByLabelText("New reference"), "review{Enter}");
    await waitFor(() =>
      expect(onCreated).toHaveBeenCalledExactlyOnceWith("references/review.md", purpose.trim()),
    );
  });

  it("keeps the chosen intent while an import is pending", async () => {
    const onCreated = vi.fn();
    let complete!: (skill: LocalSkill) => void;
    vi.spyOn(api, "addSkillFiles").mockImplementation(
      () =>
        new Promise<LocalSkill>((resolve) => {
          complete = resolve;
        }),
    );
    mockRead();
    const { rerender } = render(<Harness purpose="check the changed lines" onCreated={onCreated} />);
    await userEvent.click(screen.getByRole("button", { name: "Bring an existing file…" }));
    rerender(<Harness purpose="a later idea" onCreated={onCreated} />);
    complete({ ...initial, files: [...initial.files, entry("scripts/new.py")] });
    await waitFor(() =>
      expect(onCreated).toHaveBeenCalledExactlyOnceWith("scripts/new.py", "check the changed lines"),
    );
  });

  it("chooses materials by their role and reuses a single packaged file", async () => {
    const onReference = vi.fn();
    const packageSkill = {
      ...initial,
      files: [
        ...initial.files,
        entry("references/policy.md"),
        entry("examples/review.md"),
        entry("assets/report.txt"),
      ],
    };
    render(<Harness packageSkill={packageSkill} onReference={onReference} />);
    expect(screen.getByRole("button", { name: "Reference check.py here" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reference policy.md here" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Knowledge to consult/ }));
    expect(screen.getByRole("button", { name: "Reference policy.md here" })).toHaveTextContent(
      "Consult here",
    );
    await userEvent.click(screen.getByRole("button", { name: /Examples to follow/ }));
    expect(screen.getByRole("button", { name: "Reference review.md here" })).toHaveTextContent(
      "Show as example",
    );
    await userEvent.click(screen.getByRole("button", { name: /Assets to adapt/ }));
    await userEvent.click(screen.getByRole("button", { name: "Reference report.txt here" }));
    expect(onReference).toHaveBeenCalledExactlyOnceWith("assets/report.txt");
  });

  it("connects material without asking for duplicate instruction details", async () => {
    const onAttach = vi.fn();
    mockRead();
    const draft = {
      skill: initial,
      document: { body: "Inspect the changed lines." },
      trashed: false,
      flushAll: async () => true,
      adopt: vi.fn(),
    } as unknown as SkillDraft;
    render(
      <MaterialWorkspace
        draft={draft}
        editor={{ current: null }}
        target={{ path: null }}
        onAttach={onAttach}
        onTarget={vi.fn()}
        onClose={vi.fn()}
        onSource={vi.fn()}
      />,
    );
    expect(screen.queryByText("For this instruction")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("How should the agent use this?")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Tools to use/ }));
    await userEvent.click(screen.getByRole("button", { name: "Reference check.py here" }));
    expect(onAttach).toHaveBeenCalledExactlyOnceWith("scripts/check.py");
  });

  it("responds to a new material type requested in the same workspace", async () => {
    const { rerender } = render(<Harness startWith="python" />);
    expect(screen.getByLabelText("New python script")).toBeInTheDocument();
    rerender(<Harness startWith="reference" />);
    expect(await screen.findByLabelText("New reference")).toBeInTheDocument();
    expect(screen.queryByLabelText("New python script")).not.toBeInTheDocument();
  });

  it("focuses direct creation and returns to the choices on Escape", async () => {
    render(<Harness startWith="python" />);
    expect(screen.getByLabelText("New python script")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Tools to use/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create a script" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Bring an existing file…" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: /Tools to use/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Bring an existing file…" })).toBeInTheDocument();
  });

  it("keeps a failed creation ready to correct without adding a broken reference", async () => {
    const onCreated = vi.fn();
    vi.spyOn(api, "writeSkillFile").mockRejectedValue(new Error("File already exists"));
    render(<Harness startWith="reference" onCreated={onCreated} />);
    await userEvent.type(screen.getByLabelText("New reference"), "architecture{Enter}");
    expect(await screen.findByText("File already exists")).toBeInTheDocument();
    expect(screen.getByLabelText("New reference")).toHaveValue("architecture");
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("reuses an existing script without copying or writing it", async () => {
    const onReference = vi.fn();
    const write = vi.spyOn(api, "writeSkillFile");
    render(<Harness onReference={onReference} />);
    await userEvent.click(screen.getByRole("button", { name: "Reference check.py here" }));
    expect(onReference).toHaveBeenCalledExactlyOnceWith("scripts/check.py");
    expect(write).not.toHaveBeenCalled();
  });

  it("connects only newly imported files and opens the first", async () => {
    const onCreated = vi.fn();
    vi.spyOn(api, "addSkillFiles").mockResolvedValue({
      ...initial,
      files: [...initial.files, entry("references/architecture.md"), entry("scripts/changed.sh")],
    });
    mockRead();
    render(<Harness onCreated={onCreated} />);
    await userEvent.click(screen.getByRole("button", { name: "Bring an existing file…" }));
    await waitFor(() =>
      expect(onCreated.mock.calls).toEqual([["references/architecture.md"], ["scripts/changed.sh"]]),
    );
    expect(await screen.findByLabelText("Editing references/architecture.md")).toBeInTheDocument();
  });

  it("offers pasted code as a reusable material with explicit contents", async () => {
    const onCreated = vi.fn();
    const write = vi
      .spyOn(api, "writeSkillFile")
      .mockImplementation(async (_id, path) => ({ ...initial, files: [...initial.files, entry(path)] }));
    mockRead();
    render(<Harness onCreated={onCreated} />);
    await userEvent.click(screen.getByRole("button", { name: "Paste code" }));
    fireEvent.change(screen.getByLabelText("Code"), { target: { value: "import json\nprint('done')" } });
    await userEvent.type(screen.getByLabelText("File name"), "inspect");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledExactlyOnceWith("scripts/inspect.py"));
    expect(write).toHaveBeenCalledWith("test", "scripts/inspect.py", "import json\nprint('done')\n", null);
  });

  it("explains reference consequences before renaming and deleting a material", async () => {
    mockRead();
    const rename = vi.spyOn(api, "renameSkillPath").mockResolvedValue(initial);
    const remove = vi.spyOn(api, "removeSkillPath").mockResolvedValue(initial);
    render(<Harness initialPath="scripts/check.py" />);
    await screen.findByLabelText("Editing scripts/check.py");
    await userEvent.click(screen.getByRole("button", { name: "More for check.py" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Rename or move" }));
    expect(screen.getByText(/Existing references keep their current paths/)).toBeInTheDocument();
    expect(screen.getByText("Review 1 recognized reference")).toBeInTheDocument();
    expect(rename).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await userEvent.click(screen.getByRole("button", { name: "More for check.py" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Remove" }));
    expect(
      screen.getByText(/Its references will remain and may point to a missing file/),
    ).toBeInTheDocument();
    expect(screen.getByText(/It cannot be undone here/)).toBeInTheDocument();
    expect(remove).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(remove).not.toHaveBeenCalled();
  });

  it("does not offer creation or reference edits in a read-only package", () => {
    render(<Harness readOnly startWith="python" />);
    expect(screen.queryByRole("button", { name: "Create a script" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reference check.py here" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("New python script")).not.toBeInTheDocument();
  });
});
