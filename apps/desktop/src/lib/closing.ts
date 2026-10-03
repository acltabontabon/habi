/**
 * Closing the window writes pending edits first. If some cannot be saved,
 * the window stays open and says so; closing again soon after quits without
 * them, so a failing or stuck save can never trap the user. A close long
 * after that warning is a new decision, and warns again.
 */
import { getCurrentWindow } from "@tauri-apps/api/window";
import { flushAutosaves } from "./useAutosave";

/** How long a close waits for saves before treating them as failed. */
const PATIENCE_MS = 5000;
/** After a warning, closing again within this long quits without the unsaved edits. */
export const WARNED_FOR_MS = 60_000;

/**
 * Decides each close: resolves true to let the window close, false to keep it
 * open (having called `onUnsaved`).
 */
export function closeDecider(
  flush: () => Promise<boolean>,
  onUnsaved: () => void,
  now: () => number = Date.now,
): () => Promise<boolean> {
  let warnedAt: number | null = null;
  return async () => {
    let timer: number | undefined;
    const saved = await Promise.race([
      flush(),
      new Promise<boolean>((resolve) => {
        timer = window.setTimeout(() => resolve(false), PATIENCE_MS);
      }),
    ]);
    window.clearTimeout(timer);
    const warnedRecently = warnedAt !== null && now() - warnedAt < WARNED_FOR_MS;
    warnedAt = null;
    if (saved || warnedRecently) return true;
    warnedAt = now();
    onUnsaved();
    return false;
  };
}

/** Starts guarding the window close. Resolves to a function that stops it. */
export function guardWindowClose(onUnsaved: () => void): Promise<() => void> {
  const decide = closeDecider(flushAutosaves, onUnsaved);
  return getCurrentWindow().onCloseRequested(async (event) => {
    if (!(await decide())) event.preventDefault();
  });
}
