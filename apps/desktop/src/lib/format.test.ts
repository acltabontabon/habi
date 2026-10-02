import { describe, expect, it } from "vitest";
import { clientsPhrase, pruneSummary, relativeTime, shortId } from "./format";

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

  it("says what Free up space did, plainly", () => {
    const none = {
      operationsRemoved: 0,
      snapshotsRemoved: 0,
      objectsRemoved: 0,
      bytesFreed: 0,
      skippedBusy: 0,
    };
    expect(pruneSummary(none)).toBe("Nothing to clean up.");
    expect(pruneSummary({ ...none, operationsRemoved: 3, objectsRemoved: 12, bytesFreed: 3_565_158 })).toBe(
      "Removed 3 old operation records and 12 stored file versions, freed 3.4 MB.",
    );
    expect(pruneSummary({ ...none, skippedBusy: 1 })).toBe(
      "Nothing to clean up. 1 project or library was in use and skipped; try again later.",
    );
  });
});
