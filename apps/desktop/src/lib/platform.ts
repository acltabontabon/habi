/** Platform-aware wording for keyboard shortcuts. Handlers accept both Ctrl and ⌘; only the hint differs. */

type NavigatorWithData = Navigator & { userAgentData?: { platform?: string } };

function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as NavigatorWithData;
  return /mac/i.test(nav.userAgentData?.platform || nav.platform || "");
}

/** The modifier shortcuts are named with: "⌘" on macOS, "Ctrl" elsewhere. */
export function modKey(): string {
  return isMac() ? "⌘" : "Ctrl";
}

/** A shortcut as shown: "⌘K" or "⌘⇧O" on macOS, "Ctrl+K" or "Ctrl+Shift+O" elsewhere. */
export function modShortcut(keys: string): string {
  return isMac() ? `⌘${keys}` : `Ctrl+${keys.replace(/⇧/g, "Shift+")}`;
}
