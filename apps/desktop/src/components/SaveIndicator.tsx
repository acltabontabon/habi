/**
 * Save state shown next to an autosaved form.
 *
 * The visible word follows every state; screen readers hear only the
 * transitions that matter ("Saved", "Not saved", "Changed outside Habi"),
 * not "Unsaved changes" and "Saving…" after every pause in typing.
 *
 * Ambient, it says nothing while all is well: only "Saving…" while a write
 * is under way and "Couldn't save" when one failed. Success is silence.
 */
import { useRef } from "react";
import { relativeTime } from "../lib/format";
import type { SaveState } from "../lib/useAutosave";

const ANNOUNCED: Partial<Record<SaveState, string>> = {
  saved: "Saved",
  error: "Not saved",
  conflict: "Changed outside Habi",
};

export function SaveIndicator({
  state,
  savedAt,
  ambient,
  onRetry,
}: {
  state: SaveState;
  savedAt?: string;
  ambient?: boolean;
  /** Offered beside "Couldn't save". */
  onRetry?: () => void;
}) {
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
  if (ambient) {
    const quiet = state === "clean" || state === "saved" || state === "pending";
    return (
      <span className={`save-ambient save-${state}`}>
        {quiet ? null : state === "saving" ? (
          <span>Saving…</span>
        ) : (
          <>
            <span>{state === "conflict" ? "Changed outside Habi" : "Couldn’t save"}</span>
            {state === "error" && onRetry ? (
              <button type="button" className="link-btn" onClick={onRetry}>
                Retry
              </button>
            ) : null}
          </>
        )}
        <span className="visually-hidden" role="status" aria-live="polite">
          {announced.current}
        </span>
      </span>
    );
  }
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
