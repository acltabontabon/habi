/**
 * Commands a screen offers in the palette while it is open — the Skill
 * Studio's modes and actions, for instance. The screen registers them when it
 * mounts and clears them when it goes; the palette lists whatever is there.
 */
import { useEffect, useSyncExternalStore } from "react";
import type { IconName } from "../components/Icon";

export type ScreenCommand = {
  id: string;
  label: string;
  /** Extra words the palette matches. */
  keywords?: string;
  /** A shortcut, shown quietly. */
  keys?: string;
  icon?: IconName;
  run: () => void;
};

type Registered = { heading: string; commands: ScreenCommand[] };

let current: Registered | null = null;
const listeners = new Set<() => void>();

function set(next: Registered | null) {
  current = next;
  for (const l of listeners) l();
}

export function useScreenCommands(): Registered | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}

/** Offers `commands` under `heading` while the calling screen is mounted. */
export function useRegisterScreenCommands(heading: string, commands: ScreenCommand[]) {
  useEffect(() => {
    const entry = { heading, commands };
    set(entry);
    return () => {
      if (current === entry) set(null);
    };
  }, [heading, commands]);
}
