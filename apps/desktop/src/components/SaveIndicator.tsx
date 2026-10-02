/**
 * Save state shown next to an autosaved form.
 *
 * The visible word follows every state; screen readers hear only the
 * transitions that matter ("Saved", "Not saved", "Changed outside Habi"),
 * not "Unsaved changes" and "Saving…" after every pause in typing.
 */
import { useRef } from "react";
import { relativeTime } from "../lib/format";
import type { SaveState } from "../lib/useAutosave";

const ANNOUNCED: Partial<Record<SaveState, string>> = {
  saved: "Saved",
  error: "Not saved",
  conflict: "Changed outside Habi",
};

export function SaveIndicator({ state, savedAt }: { state: SaveState; savedAt?: string }) {
  const text: Record<SaveState, string> = {
    clean: savedAt ? `Saved ${relativeTime(savedAt)}` : "Saved",
    saved: "Saved",
    pending: "Unsaved changes",
    saving: "Saving…",
    error: "Not saved",
    conflict: "Changed outside Habi",
  };
  // Keep the last announcement until a different meaningful state arrives.
  const announced = useRef("");
  const next = ANNOUNCED[state];
  if (next) announced.current = next;
  return (
    <span className={`save-state save-${state}`}>
      <span className="save-dot" aria-hidden="true" />
      <span>{text[state]}</span>
      <span className="visually-hidden" role="status" aria-live="polite">
        {announced.current}
      </span>
    </span>
  );
}
