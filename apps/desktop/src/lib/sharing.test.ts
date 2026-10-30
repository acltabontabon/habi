import { describe, expect, it } from "vitest";
import { withRehearsal } from "./sharing";

const first =
  "Where it applies — checked by Habi against 2 projects on the author's machine:\n- Applies: a, b";
const second =
  "Where it applies — checked by Habi against 3 projects on the author's machine:\n- Applies: a, b, c";

describe("adding where a skill applies to the message", () => {
  it("adds it below what is there, or as the message", () => {
    expect(withRehearsal("", first)).toBe(first);
    expect(withRehearsal("Why.\n", first)).toBe(`Why.\n\n${first}`);
  });

  it("replaces its earlier paragraph even when the project count changed", () => {
    expect(withRehearsal(`Why.\n\n${first}`, second)).toBe(`Why.\n\n${second}`);
  });

  it("keeps what was written after its earlier paragraph", () => {
    expect(withRehearsal(`Why.\n\n${first}\n\nOne more thing.`, second)).toBe(
      `Why.\n\n${second}\n\nOne more thing.`,
    );
  });
});
