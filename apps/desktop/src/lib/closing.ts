/**
 * Closing the window writes pending edits first. If some cannot be saved,
 * the window stays open and says so; closing again quits without them, so
 * a failing or stuck save can never trap the user.
 */
import { getCurrentWindow } from "@tauri-apps/api/window";
import { flushAutosaves } from "./useAutosave";

/** How long a close waits for saves before treating them as failed. */
const PATIENCE_MS = 5000;

/** Starts guarding the window close. Resolves to a function that stops it. */
export function guardWindowClose(onUnsaved: () => void): Promise<() => void> {
  let warned = false;
  return getCurrentWindow().onCloseRequested(async (event) => {
    const saved = await Promise.race([
      flushAutosaves(),
      new Promise<boolean>((resolve) => window.setTimeout(() => resolve(false), PATIENCE_MS)),
    ]);
    if (saved || warned) return;
    warned = true;
    event.preventDefault();
    onUnsaved();
  });
}
