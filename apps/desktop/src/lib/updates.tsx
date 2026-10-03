/**
 * Habi's own updates. While the window is visible and a network is there, Habi asks GitHub
 * (through Rust, see src-tauri/src/updates.rs) whether a newer release exists, at launch and then
 * every few hours, unless the person turned that off. Finding one changes nothing: installing
 * waits for the person, writes pending edits first, and restarts into the new version.
 */
import { listen } from "@tauri-apps/api/event";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { UpdateInfo } from "../bindings/UpdateInfo";
import type { UpdateProgress } from "../bindings/UpdateProgress";
import { api } from "./api";
import { flushAutosaves } from "./useAutosave";

export type UpdateState =
  /** Nothing asked yet (or automatic checks are off). */
  | { phase: "idle" }
  | { phase: "checking" }
  /** Asked, and this is the newest. */
  | { phase: "current"; checkedAt: number }
  | { phase: "available"; info: UpdateInfo }
  | { phase: "installing"; info: UpdateInfo; downloaded: number; total: number | null }
  /** Installed, waiting for edits that could not be saved before restarting. */
  | { phase: "ready"; info: UpdateInfo; unsaved: boolean }
  | { phase: "error"; message: string; info?: UpdateInfo };

type Updates = {
  state: UpdateState;
  /** Asks now. A manual check says when it fails; a scheduled one stays quiet. */
  check: () => Promise<void>;
  install: () => Promise<void>;
  restart: () => Promise<void>;
};

const idle: Updates = {
  state: { phase: "idle" },
  check: async () => {},
  install: async () => {},
  restart: async () => {},
};

const UpdatesContext = createContext<Updates>(idle);

/** First look shortly after launch, so opening Habi is never waiting on the network. */
const FIRST_CHECK_MS = 8_000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function UpdatesProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<UpdateState>({ phase: "idle" });
  // The newest state without waiting for a render, so overlapping calls see each other.
  const current = useRef(state);
  const set = useCallback((next: UpdateState) => {
    current.current = next;
    setState(next);
  }, []);

  const check = useCallback(async () => {
    const phase = current.current.phase;
    if (phase === "checking" || phase === "installing" || phase === "ready") return;
    // An offer already found stands, even if asking again fails.
    if (phase === "available") return;
    set({ phase: "checking" });
    try {
      const info = await api.checkForUpdate();
      set(info ? { phase: "available", info } : { phase: "current", checkedAt: Date.now() });
    } catch (e) {
      set({ phase: "error", message: messageOf(e) });
    }
  }, [set]);

  const restart = useCallback(async () => {
    const at = current.current;
    if (at.phase !== "ready" && at.phase !== "installing") return;
    const { info } = at;
    // Restarting does not wait for autosave, so nothing may be left unwritten.
    if (!(await flushAutosaves())) {
      set({ phase: "ready", info, unsaved: true });
      return;
    }
    try {
      await api.restartApp();
    } catch (e) {
      set({ phase: "error", message: messageOf(e), info });
    }
  }, [set]);

  const install = useCallback(async () => {
    const at = current.current;
    const info = at.phase === "available" || at.phase === "error" ? at.info : undefined;
    if (!info) return;
    set({ phase: "installing", info, downloaded: 0, total: null });
    let stop: (() => void) | undefined;
    try {
      stop = await listen<UpdateProgress>("update-progress", (event) => {
        const now = current.current;
        if (now.phase === "installing") {
          set({ ...now, downloaded: event.payload.downloaded, total: event.payload.total });
        }
      });
      await api.installUpdate();
      set({ phase: "ready", info, unsaved: false });
    } catch (e) {
      set({ phase: "error", message: messageOf(e), info });
      return;
    } finally {
      stop?.();
    }
    await restart();
  }, [restart, set]);

  // Scheduled checks, like the libraries' (schedule.ts): visible window, a network, and the
  // person's say-so, read each time so turning it off takes effect at once.
  useEffect(() => {
    let last = 0;
    let running = false;
    const tick = async (minGap: number) => {
      if (running || document.visibilityState !== "visible" || !navigator.onLine) return;
      if (Date.now() - last < minGap) return;
      running = true;
      try {
        const settings = await api.getSettings();
        if (!settings.checkForUpdates) return;
        const phase = current.current.phase;
        if (phase === "installing" || phase === "ready" || phase === "available") return;
        last = Date.now();
        const before = current.current;
        const info = await api.checkForUpdate();
        // Never replaces what a person is looking at (a manual check in progress).
        if (current.current === before) {
          set(info ? { phase: "available", info } : { phase: "current", checkedAt: Date.now() });
        }
      } catch {
        // A background check never interrupts; the next one tries again.
      } finally {
        running = false;
      }
    };
    const first = window.setTimeout(() => void tick(0), FIRST_CHECK_MS);
    const timer = window.setInterval(() => void tick(CHECK_EVERY_MS / 2), CHECK_EVERY_MS / 4);
    const onVisible = () => void tick(CHECK_EVERY_MS);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [set]);

  const value = useMemo(() => ({ state, check, install, restart }), [state, check, install, restart]);
  return <UpdatesContext.Provider value={value}>{children}</UpdatesContext.Provider>;
}

export function useUpdates(): Updates {
  return useContext(UpdatesContext);
}

/** The version whose notes this person last looked at, to mark What's new after an update. */
const SEEN_KEY = "habi.seenVersion";

export function seenVersion(): string | null {
  try {
    return localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
}

export function markVersionSeen(version: string) {
  try {
    localStorage.setItem(SEEN_KEY, version);
  } catch {
    // Remembering is only a convenience.
  }
}

/**
 * Whether this version has notes the person has not looked at: true after an update, never on a
 * first run (which only records the version). Read on each render; opening About clears it.
 */
export function useNewVersionMark(version: string | undefined): boolean {
  const seen = seenVersion();
  useEffect(() => {
    if (version && seen === null) markVersionSeen(version);
  }, [version, seen]);
  return Boolean(version && seen !== null && seen !== version);
}
