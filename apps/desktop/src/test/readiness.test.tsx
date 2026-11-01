import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { type OtherSkill, Readiness } from "../views/skills/studio/Readiness";
import type { SkillDraft } from "../views/skills/studio/useSkillDraft";

const draft = (errors = 0) =>
  ({
    trashed: false,
    title: "A skill",
    document: { name: "a-skill", description: "Does a thing.", body: "Words." },
    skill: {
      summary: { id: "a" },
      diagnostics: Array.from({ length: errors }, () => ({ level: "error", code: "x", message: "Wrong" })),
    },
  }) as unknown as SkillDraft;

const better = [{ kind: "instructions", text: "The instructions are brief.", action: "Add more" }] as never[];

function show(d: SkillDraft, others: OtherSkill[], onOpenOther = vi.fn(), improve: never[] = []) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Readiness
        draft={d}
        standing={undefined}
        identEditing={false}
        setIdentEditing={() => {}}
        onFix={() => {}}
        better={improve}
        onRefine={() => {}}
        others={others}
        onOpenOther={onOpenOther}
      />
    </QueryClientProvider>,
  );
  return onOpenOther;
}

const found: OtherSkill = { name: "a", title: "Found one", status: "found" };
const missing: OtherSkill = { name: "b", title: "Missing one", status: "missing" };

describe("where a skill stands", () => {
  it("says Ready only when the format is valid and every link was found", () => {
    show(draft(), [found]);
    expect(screen.getByRole("button", { name: /^Ready/ })).toBeInTheDocument();
  });

  it("doesn't call a skill Ready when a skill it links to can't be found", () => {
    show(draft(), [found, missing]);
    expect(screen.getByRole("button", { name: /^Valid.*1 skill not found/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Ready/ })).toBeNull();
  });

  it("suggestions don't take Ready away", () => {
    show(draft(), [], vi.fn(), better);
    expect(screen.getByRole("button", { name: /^Ready.*1 to improve/ })).toBeInTheDocument();
  });

  it("a format problem is a Draft, whatever else is true", () => {
    show(draft(1), [missing]);
    expect(screen.getByRole("button", { name: /^Draft/ })).toBeInTheDocument();
  });

  it("answers format, content and other skills separately, and goes to a link", async () => {
    const open = show(draft(), [found, missing]);
    await userEvent.click(screen.getByRole("button", { name: /^Valid/ }));
    for (const part of ["Format", "Content", "Other skills"]) {
      expect(screen.getByText(part)).toBeInTheDocument();
    }
    expect(screen.getByText("Not found here")).toBeInTheDocument();
    expect(screen.getByText(/Agents decide for themselves/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Missing one" }));
    expect(open).toHaveBeenCalledWith("b");
  });
});
