import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ProjectPick } from "./bindings/ProjectPick";
import type { ProjectRecord } from "./bindings/ProjectRecord";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ToastProvider, useToast } from "./components/Toasts";
import { Tooltips } from "./components/Tooltips";
import { ErrorNotice, Working } from "./components/ui";
import { type Actions, ActionsContext, type NewSkillContext } from "./lib/actions";
import { api } from "./lib/api";
import { guardWindowClose } from "./lib/closing";
import { NavProvider, useNav } from "./lib/nav";
import { isOwnChange, staleKey } from "./lib/ownChanges";
import { invalidateSkills, keys, useAppInfo } from "./lib/queries";
import { useScheduledRefresh } from "./lib/schedule";
import { UpdatesProvider } from "./lib/updates";
import { AboutView } from "./views/AboutView";
import { CommandPalette } from "./views/CommandPalette";
import { ContributionsView } from "./views/contributions/ContributionsView";
import { ProjectChooser, SkillsFolderCaught } from "./views/OpenProject";
import { PrivacyView } from "./views/PrivacyView";
import { ProjectView } from "./views/project/ProjectView";
import { SettingsView } from "./views/SettingsView";
import { Sidebar } from "./views/Sidebar";
import { AddSkillsDialog, type AddSkillsStart } from "./views/skills/AddSkillsDialog";
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
  // State, not useMemo: a hot reload recomputes memos, and a new client would leave
  // everything already mounted (the sidebar) watching the old one.
  const [client] = useState(makeClient);
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>
        <Startup />
        <Tooltips />
      </ToastProvider>
    </QueryClientProvider>
  );
}

/** Waits for Habi's data to open, then starts on the home page. */
function Startup() {
  const info = useAppInfo();

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
  if (!info.data) {
    return (
      <div className="startup">
        <Working>Opening Habi…</Working>
      </div>
    );
  }
  return (
    <UpdatesProvider>
      <NavProvider initial={{ name: "welcome" }}>
        <Shell />
      </NavProvider>
    </UpdatesProvider>
  );
}

function isTextEntry(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest('input, textarea, select, [contenteditable="true"], .cm-editor') !== null
  );
}

/** Where opening a project is: Habi's chooser, or a skills folder caught from the native picker. */
type Opening =
  | { step: "chooser"; stay: boolean }
  | { step: "skills"; pick: Extract<ProjectPick, { kind: "skills" }>; stay: boolean };

function Shell() {
  const { route, navigate, back } = useNav();
  const client = useQueryClient();
  const toast = useToast();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [adding, setAdding] = useState<AddSkillsStart | null>(null);
  useScheduledRefresh();

  const [opening, setOpening] = useState<Opening | null>(null);

  const opened = useCallback(
    (p: ProjectRecord, stay: boolean) => {
      void client.invalidateQueries({ queryKey: keys.recent });
      if (stay) toast.show(`${p.name} opened. Habi only reads it.`);
      else navigate({ name: "project", projectId: p.id, tab: "recommendations" });
    },
    [client, navigate, toast],
  );
  const pick = useCallback(
    async (stay: boolean) => {
      setOpening(null);
      try {
        const picked = await api.pickProject();
        if (!picked) return;
        if (picked.kind === "skills") setOpening({ step: "skills", pick: picked, stay });
        else opened(picked.project, stay);
      } catch (e) {
        toast.show(e instanceof Error ? e.message : String(e), "danger");
      }
    },
    [opened, toast],
  );
  const openProject = useCallback(async (options?: { stay?: boolean }) => {
    setOpening({ step: "chooser", stay: Boolean(options?.stay) });
  }, []);
  const openFolder = async (open: Promise<ProjectRecord>, stay: boolean) => {
    setOpening(null);
    try {
      opened(await open, stay);
    } catch (e) {
      toast.show(e instanceof Error ? e.message : String(e), "danger");
    }
  };
  const connectAsLibrary = (location: string) => {
    setOpening(null);
    navigate({ name: "sources", view: "folder", location });
  };
  // A new skill is a page to write on, at once: no form, nothing to decide first.
  const newSkill = useCallback(
    async (context?: NewSkillContext) => {
      try {
        const skill = await api.createSkill(
          { title: context?.title ?? "", description: "", template: context?.template ?? "blank" },
          context?.projectId ?? null,
        );
        invalidateSkills(client);
        navigate({ name: "skills", skillId: skill.summary.id });
      } catch (e) {
        toast.show(e instanceof Error ? e.message : String(e), "danger");
      }
    },
    [client, navigate, toast],
  );
  const actions = useMemo<Actions>(
    () => ({
      openProject,
      newSkill: (context) => void newSkill(context),
      addSkills: (start) => setAdding(start ?? { source: "choose" }),
    }),
    [openProject, newSkill],
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
            ? `sources:${route.sourceId ?? route.entry ?? route.view ?? ""}`
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
      // A focused control (the code editor's ⌘[ outdent) handled it already.
      if (!mod || e.defaultPrevented) return;
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
        // In text, ⌘[ belongs to the field (outdent), not to Back.
        if (isTextEntry(e.target)) return;
        e.preventDefault();
        back();
      } else if (mod && e.key === ",") {
        e.preventDefault();
        navigate({ name: "settings" });
      } else if (mod && !e.shiftKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        void openProject();
      } else if (mod && !e.shiftKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        void newSkill();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate, back, openProject, newSkill]);

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
              <SourcesView
                sourceId={route.sourceId}
                entry={route.entry}
                view={route.view}
                location={route.location}
                itemId={route.itemId}
                file={route.file}
              />
            )}
            {route.name === "contributions" && <ContributionsView contributionId={route.contributionId} />}
            {route.name === "settings" && <SettingsView />}
            {route.name === "about" && <AboutView />}
            {route.name === "privacy" && <PrivacyView />}
          </ErrorBoundary>
        </main>
        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
        {adding ? <AddSkillsDialog start={adding} onClose={() => setAdding(null)} /> : null}
        {opening?.step === "chooser" ? (
          <ProjectChooser
            onOpen={(path) => void openFolder(api.openBrowsedProject(path), opening.stay)}
            onLibrary={(path) => connectAsLibrary(path)}
            onElsewhere={() => void pick(opening.stay)}
            onClose={() => setOpening(null)}
          />
        ) : null}
        {opening?.step === "skills" ? (
          <SkillsFolderCaught
            pick={opening.pick}
            onLibrary={() => connectAsLibrary(opening.pick.path)}
            onOpenAnyway={() => void openFolder(api.openPickedProject(opening.pick.path), opening.stay)}
            onChooseAgain={() => void pick(opening.stay)}
            onClose={() => setOpening(null)}
          />
        ) : null}
      </div>
    </ActionsContext.Provider>
  );
}
