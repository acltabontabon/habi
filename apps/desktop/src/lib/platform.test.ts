import { afterEach, describe, expect, it, vi } from "vitest";
import { modKey, modShortcut } from "./platform";

describe("shortcut hints", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("names Ctrl where there is no ⌘ (and in jsdom)", () => {
    expect(modKey()).toBe("Ctrl");
    expect(modShortcut("K")).toBe("Ctrl+K");
    expect(modShortcut("⇧O")).toBe("Ctrl+Shift+O");
    expect(modShortcut(",")).toBe("Ctrl+,");
  });

  it("names ⌘ on macOS, from userAgentData or the platform", () => {
    vi.stubGlobal("navigator", { platform: "MacIntel" });
    expect(modKey()).toBe("⌘");
    expect(modShortcut("⇧O")).toBe("⌘⇧O");
    vi.stubGlobal("navigator", { platform: "", userAgentData: { platform: "macOS" } });
    expect(modShortcut("K")).toBe("⌘K");
    vi.stubGlobal("navigator", { platform: "MacIntel", userAgentData: { platform: "Windows" } });
    expect(modShortcut("K")).toBe("Ctrl+K");
  });
});
