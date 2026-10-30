import { describe, expect, it } from "vitest";
import type { SkillUsage } from "../bindings/SkillUsage";
import { usageLine, usageTip } from "./usage";

const entry = (usage: SkillUsage["usage"]): SkillUsage => ({ name: "x", tokens: 40, usage });

describe("usageLine", () => {
  it("says what was seen, for the days it covers", () => {
    expect(usageLine(entry({ uses: 12, lastUsed: "2026-10-01T00:00:00Z", days: 30 }), false)).toBe(
      "Used 12× in Claude Code here in 30 days",
    );
    expect(usageLine(entry({ uses: 1, lastUsed: "2026-10-01T00:00:00Z", days: 1 }), false)).toBe(
      "Used 1× in Claude Code here in 1 day",
    );
    expect(usageLine(entry({ uses: 0, lastUsed: null, days: 6 }), false)).toBe(
      "Not used in Claude Code here in 6 days",
    );
  });

  it("says nothing when the transcripts give nothing to go on", () => {
    expect(usageLine(entry(null), false)).toBeNull();
    expect(usageLine(undefined, false)).toBeNull();
    expect(usageTip(entry(null))).toBeUndefined();
  });

  it("says whose count it is, and that it is this machine's", () => {
    for (const usage of [
      { uses: 0, lastUsed: null, days: 6 },
      { uses: 2, lastUsed: "2026-10-01T00:00:00Z", days: 6 },
    ]) {
      const tip = usageTip(entry(usage));
      expect(tip).toContain("Claude Code");
      expect(tip).toContain("on this machine");
      expect(tip).toContain("Other agents, and other people's sessions, are not counted.");
    }
  });

  it("calls a count from a partial read a minimum", () => {
    expect(usageLine(entry({ uses: 3, lastUsed: "2026-10-01T00:00:00Z", days: 30 }), true)).toBe(
      "Used at least 3× in Claude Code here in 30 days",
    );
  });
});
