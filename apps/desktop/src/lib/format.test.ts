import { describe, expect, it } from "vitest";
import { clientsPhrase, relativeTime, shortId } from "./format";

describe("format helpers", () => {
  it("phrases client lists naturally", () => {
    expect(clientsPhrase(["claude-code"])).toBe("Claude Code");
    expect(clientsPhrase(["claude-code", "codex"])).toBe("Claude Code and Codex");
    expect(clientsPhrase(["claude-code", "cursor", "codex"])).toBe("Claude Code, Cursor and Codex");
  });

  it("shortens digests and commits", () => {
    expect(shortId("sha256:0123456789abcdef")).toBe("0123456789");
    expect(shortId("cf1145d5f8aa")).toBe("cf1145d5f8");
  });

  it("describes relative times", () => {
    const now = new Date("2026-10-02T12:00:00Z");
    expect(relativeTime("2026-10-02T11:59:50Z", now)).toBe("just now");
    expect(relativeTime("2026-10-02T11:30:00Z", now)).toBe("30 min ago");
    expect(relativeTime("2026-10-02T09:00:00Z", now)).toBe("3 h ago");
    expect(relativeTime("2026-09-30T12:00:00Z", now)).toBe("2 days ago");
    expect(relativeTime(null, now)).toBe("never");
  });
});
