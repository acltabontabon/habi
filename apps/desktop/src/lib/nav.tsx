/** Minimal in-app navigation: a typed route plus back history. */
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";

export type ProjectTab = "recommendations" | "found" | "evidence" | "installed";

export type Route =
  | { name: "welcome" }
  | { name: "project"; projectId: string; tab: ProjectTab; itemKey?: string }
  | { name: "skills"; skillId?: string }
  | { name: "sources"; sourceId?: string; itemId?: string; file?: string }
  | { name: "contributions"; contributionId?: string }
  | { name: "settings" };

type Nav = {
  route: Route;
  navigate: (route: Route) => void;
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

export function NavProvider({ initial, children }: { initial: Route; children: ReactNode }) {
  const [stack, setStack] = useState<Route[]>([initial]);
  const route = stack[stack.length - 1] ?? initial;

  const navigate = useCallback((next: Route) => {
    if (next.name === "project") rememberProject(next.projectId);
    setStack((s) => {
      const top = s[s.length - 1];
      if (top && JSON.stringify(top) === JSON.stringify(next)) return s;
      // Selecting items within one project view replaces instead of stacking.
      if (top?.name === "project" && next.name === "project" && top.projectId === next.projectId) {
        return [...s.slice(0, -1), next];
      }
      // Within a library, choosing skills replaces; opening one of a skill's
      // files stacks, so Back returns to the skill.
      if (top?.name === "sources" && next.name === "sources" && top.sourceId === next.sourceId) {
        const opensFile = Boolean(next.file) && !top.file && top.itemId === next.itemId;
        if (!opensFile) return [...s.slice(0, -1), next];
      }
      return [...s.slice(-30), next];
    });
  }, []);

  const back = useCallback(() => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)), []);

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
  return <NavContext.Provider value={value}>{children}</NavContext.Provider>;
}

export function useNav(): Nav {
  const nav = useContext(NavContext);
  if (!nav) throw new Error("useNav outside NavProvider");
  return nav;
}
