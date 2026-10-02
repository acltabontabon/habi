import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ToastProvider, useToast } from "./components/Toasts";
import { ErrorNotice, Working } from "./components/ui";
import { type Actions, ActionsContext } from "./lib/actions";
import { api } from "./lib/api";
import { guardWindowClose } from "./lib/closing";
import { lastProject, NavProvider, type Route, useNav } from "./lib/nav";
import { isOwnChange, staleKey } from "./lib/ownChanges";
import { keys, useAppInfo } from "./lib/queries";
import { useScheduledRefresh } from "./lib/schedule";
import { CommandPalette } from "./views/CommandPalette";
import { ContributionsView } from "./views/contributions/ContributionsView";
import { ProjectView } from "./views/project/ProjectView";
import { SettingsView } from "./views/SettingsView";
import { Sidebar } from "./views/Sidebar";
import { AddSkillsDialog, type AddSkillsStart } from "./views/skills/AddSkillsDialog";
import { NewSkillDialog } from "./views/skills/NewSkillDialog";
import { SkillsView } from "./views/skills/SkillsView";
import { SourcesView } from "./views/sources/SourcesView";
import { Welcome } from "./views/Welcome";

function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
}

export function App() {
  const client = useMemo(makeClient, []);
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>
        <Startup />
      </ToastProvider>
    </QueryClientProvider>
  );
}

/** Decides the first screen: the last open project if it still exists, else the welcome. */
function Startup() {
  const info = useAppInfo();
  const [initial, setInitial] = useState<Route | null>(null);

  useEffect(() => {
    if (!info.data || info.data.startupError) return;
    const remembered = lastProject();
    if (!remembered) {
      setInitial({ name: "welcome" });
      return;
    }
    api
      .recentProjects()
      .then((recent) => {
        const found = recent.find((p) => p.id === remembered && p.exists);
        setInitial(
          found ? { name: "project", projectId: found.id, tab: "recommendations" } : { name: "welcome" },
        );
      })
      .catch(() => setInitial({ name: "welcome" }));
  }, [info.data]);

  if (info.isError) {
    return (
      <div className="startup">
        <ErrorNotice error={info.error} title="Habi could not start" />
      </div>
    );
  }
  if (info.data?.startupError) {
    return (
      <div className="startup">
        <ErrorNotice
          error={new Error(info.data.startupError.message)}
          title="Habi could not open its local data"
        />
        <p className="muted">
          Data folder: <code>{info.data.dataDir || "unknown"}</code>. Nothing in your projects was changed.
        </p>
      </div>
    );
  }
  if (!initial) {
    return (
      <div className="startup">
        <Working>Opening Habi…</Working>
      </div>
    );
  }
  return (
    <NavProvider initial={initial}>
      <Shell />
    </NavProvider>
  );
}

function Shell() {
  const { route, navigate, back } = useNav();
  const client = useQueryClient();
  const toast = useToast();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [creating, setCreating] = useState<{ projectId?: string; projectName?: string } | null>(null);
  const [adding, setAdding] = useState<AddSkillsStart | null>(null);
  useScheduledRefresh();

  const openProject = useCallback(
    async (options?: { stay?: boolean }) => {
      try {
        const p = await api.pickProject();
        if (!p) return;
        void client.invalidateQueries({ queryKey: keys.recent });
        if (options?.stay) toast.show(`${p.name} opened. Habi only reads it.`);
        else navigate({ name: "project", projectId: p.id, tab: "recommendations" });
      } catch (e) {
        toast.show(e instanceof Error ? e.message : String(e), "danger");
      }
    },
    [client, navigate, toast],
  );
  const actions = useMemo<Actions>(
    () => ({
      openProject,
      newSkill: (context) => setCreating(context ?? {}),
      addSkills: (start) => setAdding(start ?? { source: "choose" }),
    }),
    [openProject],
  );

  // Each screen starts at its top; the scroll position of the last one is not carried over.
  const screen =
    route.name === "project"
      ? `project:${route.projectId}:${route.tab}`
      : route.name === "skills"
        ? `skills:${route.skillId ?? ""}`
        : route.name === "contributions"
          ? `sharing:${route.contributionId ?? ""}`
          : route.name === "sources"
            ? `sources:${route.sourceId ?? ""}`
            : route.name;
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the screen changes.
  useEffect(() => {
    document.getElementById("main")?.scrollTo({ top: 0 });
  }, [screen]);

  // Re-inspect when files in the open project change.
  useEffect(() => {
    let stop: (() => void) | undefined;
    void listen<{ projectId: string; paths: string[] }>("project-changed", (event) => {
      // Files Habi itself just wrote are not outside changes.
      if (isOwnChange(event.payload.projectId)) return;
      void client.setQueryData(staleKey(event.payload.projectId), event.payload.paths);
    }).then((unlisten) => {
      stop = unlisten;
    });
    return () => stop?.();
  }, [client]);

  // Closing the window waits for pending edits to be written.
  useEffect(() => {
    let stop: (() => void) | undefined;
    let done = false;
    try {
      void guardWindowClose(() =>
        toast.show(
          "Some edits could not be saved, so Habi stayed open. Close again to quit without them.",
          "danger",
        ),
      )
        .then((unlisten) => {
          if (done) unlisten();
          else stop = unlisten;
        })
        .catch(() => undefined);
    } catch {
      // Not in a Tauri window (the design preview): nothing to guard.
    }
    return () => {
      done = true;
      stop?.();
    };
  }, [toast]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      // While a dialog is open, global shortcuts would act behind it (and
      // could open a second dialog on top). ⌘K still closes the palette.
      const otherDialog = document.querySelector('[role="dialog"]:not(.palette), [role="alertdialog"]');
      const anyDialog = otherDialog ?? document.querySelector('[role="dialog"]');
      if (e.key.toLowerCase() === "k") {
        if (otherDialog) return;
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }
      if (anyDialog) return;
      if (e.key === "[") {
        e.preventDefault();
        back();
      } else if (mod && e.key === ",") {
        e.preventDefault();
        navigate({ name: "settings" });
      } else if (mod && e.key.toLowerCase() === "o") {
        e.preventDefault();
        void openProject();
      } else if (mod && e.key.toLowerCase() === "n") {
        e.preventDefault();
        setCreating({});
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate, back, openProject]);

  return (
    <ActionsContext.Provider value={actions}>
      <div className="shell">
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <Sidebar onOpenPalette={() => setPaletteOpen(true)} />
        <main id="main" className="main" tabIndex={-1}>
          {/* A screen that fails to render is replaced; the sidebar still works, and leaving clears it. */}
          <ErrorBoundary key={screen} area={route.name}>
            {route.name === "welcome" && <Welcome />}
            {route.name === "project" && (
              <ProjectView
                key={route.projectId}
                projectId={route.projectId}
                tab={route.tab}
                itemKey={route.itemKey}
              />
            )}
            {route.name === "skills" && <SkillsView skillId={route.skillId} />}
            {route.name === "sources" && (
              <SourcesView sourceId={route.sourceId} itemId={route.itemId} file={route.file} />
            )}
            {route.name === "contributions" && <ContributionsView contributionId={route.contributionId} />}
            {route.name === "settings" && <SettingsView />}
          </ErrorBoundary>
        </main>
        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
        {creating ? (
          <NewSkillDialog
            projectId={creating.projectId}
            projectName={creating.projectName}
            onClose={() => setCreating(null)}
          />
        ) : null}
        {adding ? <AddSkillsDialog start={adding} onClose={() => setAdding(null)} /> : null}
      </div>
    </ActionsContext.Provider>
  );
}
