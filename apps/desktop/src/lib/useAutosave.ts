/**
 * Debounced, honest autosave.
 *
 * The state says "saved" only after a write succeeded. Edits made while a
 * write is in flight are written next; a conflict (the file changed outside
 * Habi) stops saving until the author chooses a version; leaving the screen
 * flushes pending edits.
 *
 * Every mounted autosave is registered, so closing the window can write
 * them all first and navigation can stop before edits that could not be
 * saved are lost.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { HabiError } from "./api";

type Registered = {
  flush: () => Promise<boolean>;
  unsaved: () => boolean;
  /** Edits waiting for the pause, or a write still in flight. */
  pending: () => boolean;
};
const registered = new Set<Registered>();
/** The last write of an editor that has since closed: still counted until it settles. */
const finalWrites = new Set<Promise<boolean>>();

/** Writes every open editor's pending edits. Resolves true when all of them are saved. */
export async function flushAutosaves(): Promise<boolean> {
  const results = await Promise.all([
    ...[...registered].map((r) => r.flush().catch(() => false)),
    ...finalWrites,
  ]);
  return results.every(Boolean);
}

/** Whether an open editor holds edits that could not be saved (a conflict or a failed write). */
export function hasUnsavedEdits(): boolean {
  return [...registered].some((r) => r.unsaved());
}

/** Whether an open editor holds edits that are not written yet (but could still be). */
export function hasPendingEdits(): boolean {
  return finalWrites.size > 0 || [...registered].some((r) => r.pending());
}

export type SaveState = "clean" | "pending" | "saving" | "saved" | "error" | "conflict";

export type Autosave = {
  state: SaveState;
  error: unknown;
  /** Write now, if there is anything to write. Resolves true when everything is saved. */
  flush: () => Promise<boolean>;
  /** After a conflict: write the author's version over the other one. */
  retry: () => void;
  /** Forget the edits tracked so far (after reloading the other version). */
  reset: (savedKey: string) => void;
};

export function useAutosave<T>(options: {
  value: T;
  /** Stable text form of the value, to tell whether it changed. */
  keyOf: (value: T) => string;
  /** Writes the value. Must throw on failure. */
  save: (value: T) => Promise<void>;
  delay?: number;
  enabled?: boolean;
}): Autosave {
  const { value, keyOf, save, delay = 700, enabled = true } = options;
  const [state, setState] = useState<SaveState>("clean");
  const [error, setError] = useState<unknown>(null);
  const latest = useRef(value);
  const savedKey = useRef(keyOf(value));
  const saveRef = useRef(save);
  const keyRef = useRef(keyOf);
  const inFlight = useRef<Promise<void> | null>(null);
  const timer = useRef<number | null>(null);
  const blocked = useRef(false);
  const failed = useRef(false);
  const alive = useRef(true);
  const enabledRef = useRef(enabled);
  latest.current = value;
  saveRef.current = save;
  keyRef.current = keyOf;
  enabledRef.current = enabled;

  const run = useCallback(async (): Promise<boolean> => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    // Turned off, it writes nothing, whoever asks: a blur, leaving the screen, closing the window.
    if (!enabledRef.current) return true;
    // A loop, not a single wait: of several callers woken together, only the first may write; the
    // rest must see its write in flight (and then its saved key) rather than save the same snapshot again.
    while (inFlight.current) await inFlight.current;
    if (blocked.current) return false;
    const snapshot = latest.current;
    const key = keyRef.current(snapshot);
    if (key === savedKey.current) {
      failed.current = false;
      return true;
    }
    if (alive.current) setState("saving");
    const attempt = (async (): Promise<boolean> => {
      try {
        await saveRef.current(snapshot);
        savedKey.current = key;
        failed.current = false;
        if (!alive.current) return true;
        setError(null);
        if (keyRef.current(latest.current) === key) setState("saved");
        else setState("pending");
        return true;
      } catch (e) {
        failed.current = true;
        if (!alive.current) return false;
        setError(e);
        if (e instanceof HabiError && e.code === "conflict") {
          blocked.current = true;
          setState("conflict");
        } else {
          setState("error");
        }
        return false;
      }
    })();
    const mine = attempt.then(() => undefined);
    inFlight.current = mine;
    const ok = await attempt;
    if (inFlight.current === mine) inFlight.current = null;
    // Edits made during the write are saved next.
    if (alive.current && !blocked.current && keyRef.current(latest.current) !== savedKey.current) {
      if (timer.current === null) timer.current = window.setTimeout(() => void run(), 250);
    }
    return ok;
  }, []);

  const key = keyOf(value);
  useEffect(() => {
    if (!enabled || blocked.current) return;
    if (key === savedKey.current) return;
    setState((s) => (s === "saving" ? s : "pending"));
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void run(), delay);
  }, [key, enabled, delay, run]);

  // Leaving the screen or closing the window writes pending edits.
  useEffect(() => {
    alive.current = true;
    const entry: Registered = {
      flush: run,
      unsaved: () => blocked.current || failed.current,
      pending: () => inFlight.current !== null || keyRef.current(latest.current) !== savedKey.current,
    };
    registered.add(entry);
    const onHide = () => void run();
    window.addEventListener("beforeunload", onHide);
    window.addEventListener("blur", onHide);
    return () => {
      window.removeEventListener("beforeunload", onHide);
      window.removeEventListener("blur", onHide);
      registered.delete(entry);
      // Registered until it settles, so closing the window waits for it (see flushAutosaves).
      const final = run().catch(() => false);
      finalWrites.add(final);
      void final.finally(() => finalWrites.delete(final));
      alive.current = false;
    };
  }, [run]);

  const retry = useCallback(() => {
    blocked.current = false;
    void run();
  }, [run]);

  const reset = useCallback((saved: string) => {
    blocked.current = false;
    failed.current = false;
    savedKey.current = saved;
    setError(null);
    setState("clean");
  }, []);

  return { state, error, flush: run, retry, reset };
}
