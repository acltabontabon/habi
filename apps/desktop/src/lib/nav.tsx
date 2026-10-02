/** Minimal in-app navigation: a typed route plus back history. */
import { createContext, type ReactNode, useCallback, useContext, useMemo, useRef, useState } from "react";
import { Dialog } from "../components/Dialog";
import { Button } from "../components/ui";
import { hasUnsavedEdits } from "./useAutosave";

export type ProjectTab = "recommendations" | "found" | "evidence" | "installed";

export type Route =
  | { name: "welcome" }
  | { name: "project"; projectId: string; tab: ProjectTab; itemKey?: string }
  | { name: "skills"; skillId?: string }
  | {
      name: "sources";
      /** A connected library. */
      sourceId?: string;
      /** A catalog library, connected or only being previewed. */
      entry?: string;
      /** A page for bringing in a library of your own. */
      view?: "git" | "folder";
      itemId?: string;
      file?: string;
    }
  | { name: "contributions"; contributionId?: string }
  | { name: "settings" };

type Nav = {
  route: Route;
  /** `replace` swaps the current screen instead of stacking a new one (a screen that only passes through). */
  navigate: (route: Route, options?: { replace?: boolean }) => void;
  back: () => void;
  canGoBack: boolean;
  /** The screen "back" returns to, if any. */
  previous: Route | undefined;
};

const NavContext = createContext<Nav | null>(null);

const LAST_PROJECT = "habi.lastProject";

export function rememberProject(projectId: string | null) {
  try {
    if (projectId) localStorage.setItem(LAST_PROJECT, projectId);
    else localStorage.removeItem(LAST_PROJECT);
  } catch {
    // Storage may be unavailable; remembering is only a convenience.
  }
}

export function lastProject(): string | null {
  try {
    return localStorage.getItem(LAST_PROJECT);
  } catch {
    return null;
  }
}

/** Which library a sources route is in ("" for the overview and connect pages). */
function libraryOf(route: Extract<Route, { name: "sources" }>): string {
  return route.sourceId ?? (route.entry ? `entry:${route.entry}` : "");
}

export function NavProvider({ initial, children }: { initial: Route; children: ReactNode }) {
  const [stack, setStack] = useState<Route[]>([initial]);
  const route = stack[stack.length - 1] ?? initial;
  // Leaving a screen whose edits could not be saved would lose them: the
  // move waits for the author's answer, and the editor stays open meanwhile.
  const [held, setHeld] = useState<(() => void) | null>(null);
  const top = useRef(route);
  top.current = route;
  const guarded = useCallback((go: () => void) => {
    if (hasUnsavedEdits()) setHeld(() => go);
    else go();
  }, []);

  const go = useCallback((next: Route, replace = false) => {
    if (next.name === "project") rememberProject(next.projectId);
    setStack((s) => {
      const top = s[s.length - 1];
      if (replace) return [...s.slice(0, -1), next];
      if (top && JSON.stringify(top) === JSON.stringify(next)) return s;
      // Selecting items within one project view replaces instead of stacking.
      if (top?.name === "project" && next.name === "project" && top.projectId === next.projectId) {
        return [...s.slice(0, -1), next];
      }
      // Within a library, choosing skills replaces; opening one of a skill's
      // files stacks, so Back returns to the skill.
      if (
        top?.name === "sources" &&
        next.name === "sources" &&
        libraryOf(top) !== "" &&
        libraryOf(top) === libraryOf(next)
      ) {
        const opensFile = Boolean(next.file) && !top.file && top.itemId === next.itemId;
        if (!opensFile) return [...s.slice(0, -1), next];
      }
      return [...s.slice(-30), next];
    });
  }, []);

  const navigate = useCallback(
    (next: Route, options?: { replace?: boolean }) => {
      if (JSON.stringify(top.current) === JSON.stringify(next)) return;
      guarded(() => go(next, options?.replace));
    },
    [guarded, go],
  );

  const back = useCallback(
    () => guarded(() => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s))),
    [guarded],
  );

  const value = useMemo(
    () => ({
      route,
      navigate,
      back,
      canGoBack: stack.length > 1,
      previous: stack.length > 1 ? stack[stack.length - 2] : undefined,
    }),
    [route, navigate, back, stack],
  );
  return (
    <NavContext.Provider value={value}>
      {children}
      <Dialog
        open={held !== null}
        onOpenChange={(open) => {
          if (!open) setHeld(null);
        }}
        title="Unsaved edits"
        description="Some edits on this screen are not saved: the file changed outside Habi, or writing it failed. Leaving now loses them."
        footer={
          <>
            <Button
              variant="danger"
              onClick={() => {
                held?.();
                setHeld(null);
              }}
            >
              Leave without them
            </Button>
            <Button variant="primary" onClick={() => setHeld(null)}>
              Stay and fix
            </Button>
          </>
        }
      >
        <p className="muted">Stay to keep them; the screen explains how to save them.</p>
      </Dialog>
    </NavContext.Provider>
  );
}

export function useNav(): Nav {
  const nav = useContext(NavContext);
  if (!nav) throw new Error("useNav outside NavProvider");
  return nav;
}
