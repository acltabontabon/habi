/**
 * Whether the package inspector is open. One setting for every skill and
 * every place a skill is read, remembered for the session: someone who
 * keeps looking inside packages keeps seeing them.
 */
import { useSyncExternalStore } from "react";

const KEY = "habi.packageInspector";
const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return sessionStorage.getItem(KEY) === "open";
  } catch {
    return false;
  }
}

let open = read();

export function setInspectorOpen(next: boolean) {
  if (next === open) return;
  open = next;
  try {
    sessionStorage.setItem(KEY, next ? "open" : "closed");
  } catch {
    // Remembering is only a convenience.
  }
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useInspectorOpen(): [boolean, (open: boolean) => void] {
  return [useSyncExternalStore(subscribe, () => open), setInspectorOpen];
}

/** ⌘I / Ctrl+I toggles the inspector wherever a skill is being read. */
export function isInspectorShortcut(e: KeyboardEvent): boolean {
  return (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "i";
}
