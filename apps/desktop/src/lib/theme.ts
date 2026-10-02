/**
 * Light/dark theme: follows the system unless the user picks one. One
 * choice for the whole window, so every control showing it stays in step;
 * the system setting is only followed while the choice is "system".
 */
import { useSyncExternalStore } from "react";

export type ThemeChoice = "system" | "light" | "dark";
const KEY = "habi.theme";
const listeners = new Set<() => void>();

function readChoice(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

let choice: ThemeChoice = readChoice();
let media: MediaQueryList | null = null;

function apply() {
  const dark = choice === "dark" || (choice === "system" && media?.matches === true);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

export function initTheme() {
  if (!media && typeof window.matchMedia === "function") {
    media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", () => {
      if (choice === "system") apply();
    });
  }
  apply();
}

export function setTheme(next: ThemeChoice) {
  try {
    if (next === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, next);
  } catch {
    // Not persisted; the choice still applies for this session.
  }
  if (next === choice) return;
  choice = next;
  apply();
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTheme(): [ThemeChoice, (c: ThemeChoice) => void] {
  return [useSyncExternalStore(subscribe, () => choice), setTheme];
}
