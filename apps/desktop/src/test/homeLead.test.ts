import { describe, expect, it } from "vitest";
import type { Contribution } from "../bindings/Contribution";
import type { LocalSkillSummary } from "../bindings/LocalSkillSummary";
import { countUnshared, type HomeFacts, homeLead, nameList, STATIC_LEAD } from "../lib/homeLead";

const calm: HomeFacts = {
  projects: [{ id: "p1", name: "billing", fits: 5 }],
  libraries: 2,
  newer: [],
  unshared: 0,
};

describe("the home lead", () => {
  it("says the static line when nothing needs saying", () => {
    expect(homeLead(calm)).toEqual({ text: STATIC_LEAD });
    expect(homeLead({ projects: [], libraries: 0, newer: [], unshared: 0 }).text).toBe(STATIC_LEAD);
  });

  it("asks for a library before anything else when projects have none to match", () => {
    const lead = homeLead({ ...calm, libraries: 0, newer: [{ id: "s", name: "Acme" }], unshared: 3 });
    expect(lead.text).toMatch(/No library is connected/);
    expect(lead.action?.to).toEqual({ name: "sources" });
  });

  it("names the projects with nothing matched, and opens the first", () => {
    const lead = homeLead({
      ...calm,
      projects: [
        { id: "a", name: "scuttle", fits: 0 },
        { id: "b", name: "munimuni", fits: 4 },
        { id: "c", name: "draft-canvas", fits: 0 },
      ],
    });
    expect(lead.text).toBe("scuttle and draft-canvas have nothing matched yet.");
    expect(lead.action).toEqual({
      label: "Open scuttle",
      to: { name: "project", projectId: "a", tab: "recommendations" },
    });
    const single = homeLead({ ...calm, projects: [{ id: "a", name: "scuttle", fits: 0 }] });
    expect(single.text).toBe("scuttle has nothing matched yet.");
    // The name is already in the sentence, so the action does not repeat it.
    expect(single.action?.label).toBe("Open it");
  });

  it("does not call a project unmatched before it has been looked at", () => {
    expect(homeLead({ ...calm, projects: [{ id: "a", name: "new", fits: null }] }).text).toBe(STATIC_LEAD);
  });

  it("then points at libraries with something newer", () => {
    const one = homeLead({ ...calm, newer: [{ id: "s1", name: "Cloudflare" }] });
    expect(one.text).toBe("Cloudflare has a newer version.");
    expect(one.action).toEqual({ label: "See what changed", to: { name: "sources", sourceId: "s1" } });
    const two = homeLead({
      ...calm,
      newer: [
        { id: "s1", name: "Cloudflare" },
        { id: "s2", name: "OpenAI" },
      ],
    });
    expect(two.text).toBe("Cloudflare and OpenAI have newer versions.");
  });

  it("then the skills that were never shared", () => {
    expect(homeLead({ ...calm, unshared: 1 }).text).toBe(
      "1 skill of yours has not been shared with a library.",
    );
    expect(homeLead({ ...calm, unshared: 2 })).toMatchObject({
      text: "2 skills of yours have not been shared with a library.",
      action: { to: { name: "skills" } },
    });
  });

  it("claims nothing about what is not yet known", () => {
    const lead = homeLead({ projects: calm.projects, libraries: null, newer: null, unshared: null });
    expect(lead.text).toBe(STATIC_LEAD);
  });
});

describe("naming several", () => {
  it("lists up to three, then counts the rest", () => {
    expect(nameList(["a"])).toBe("a");
    expect(nameList(["a", "b"])).toBe("a and b");
    expect(nameList(["a", "b", "c"])).toBe("a, b and c");
    expect(nameList(["a", "b", "c", "d", "e"])).toBe("a, b and 3 more");
  });
});

const skill = (id: string, type: "created" | "library", deletedAt: string | null = null) =>
  ({
    id,
    deletedAt,
    origin: type === "created" ? { type: "created" } : { type: "library" },
  }) as unknown as LocalSkillSummary;

const contribution = (skillId: string, state: Contribution["state"]) =>
  ({ state, origin: { type: "localSkill", skillId } }) as unknown as Contribution;

describe("skills never shared", () => {
  it("counts only skills written here that are not in the trash and have no live contribution", () => {
    const skills = [
      skill("written", "created"),
      skill("sent", "created"),
      skill("dropped", "created"),
      skill("copied", "library"),
      skill("trashed", "created", "2026-10-01"),
    ];
    const contributions = [contribution("sent", "published"), contribution("dropped", "discarded")];
    // "written" and "dropped" (its contribution was discarded) have never been put forward.
    expect(countUnshared(skills, contributions)).toBe(2);
  });
});
