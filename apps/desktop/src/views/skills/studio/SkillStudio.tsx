/**
 * The Skill Studio: one skill, as one document.
 *
 * The head is the skill's identity (SKILL.md's frontmatter, set as a
 * document head). Below it, one surface in three modes — the instructions,
 * when Habi should suggest it, and the package's files — and beside it a
 * panel that follows what the author is doing: the outline while writing,
 * an evaluation while editing rules, file details among files, where it came
 * from, and how to use and share it. The panel docks when there is room and
 * becomes a sheet when there is not. Modes stay mounted once visited, so
 * undo history, scroll positions and pending saves survive a switch.
 *
 * Edits save to the draft on this machine as they are typed; nothing here
 * installs, runs or publishes.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LocalSkill } from "../../../bindings/LocalSkill";
import { Icon } from "../../../components/Icon";
import { SourceEditor } from "../../../components/lazy";
import type { SourceEditorHandle } from "../../../components/SourceEditor";
import { useToast } from "../../../components/Toasts";
import { Button, ErrorNotice, Notice, Working } from "../../../components/ui";
import { useActions } from "../../../lib/actions";
import { api } from "../../../lib/api";
import { useNav } from "../../../lib/nav";
import { invalidateSkills, keys, useRecentProjects, useSkillsOverview } from "../../../lib/queries";
import { useSafeInvoke } from "../../../lib/safeInvoke";
import { type ScreenCommand, useRegisterScreenCommands } from "../../../lib/screenCommands";
import type { NavTarget, StudioMode } from "../../../lib/studioNav";
import { ApplicabilityPreview } from "../ApplicabilityPreview";
import { ConditionBuilder } from "../ConditionBuilder";
import { FilesPane } from "../FilesPane";
import { ShareSkillDialog } from "../ShareSkillDialog";
import { UseSkillDialog } from "../UseSkillDialog";
import { InstructionsMode } from "./InstructionsMode";
import { Masthead } from "./Masthead";
import { InstructionsPanel, LineagePanel, SharePanel } from "./Panels";
import { NOT_SAVED, type SkillDraft, useSkillDraft } from "./useSkillDraft";

const MODES: { id: StudioMode; label: string; short: string }[] = [
  { id: "instructions", label: "Instructions", short: "Instructions" },
  { id: "rules", label: "When it applies", short: "Rules" },
  { id: "files", label: "Files", short: "Files" },
];

type PanelView = "context" | "lineage" | "share";

const PANEL_TITLE: Record<StudioMode, string> = {
  instructions: "While writing",
  rules: "Would Habi suggest it?",
  files: "About files",
};

/** The Studio's own width (not the window's): the sidebar and the panel take their share. */
function useWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(() => ref.current?.clientWidth ?? 1200);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(el);
    setWidth(el.clientWidth);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

const otherDialogOpen = () => document.querySelector('[role="dialog"], [role="alertdialog"]') !== null;

export function SkillStudio({ id }: { id: string }) {
  const { navigate } = useNav();
  const skill = useQuery({
    queryKey: keys.skill(id),
    queryFn: () => api.getSkill(id),
    staleTime: 0,
    gcTime: 0,
  });
  if (skill.isPending) return <Working>Opening the skill…</Working>;
  if (skill.isError) {
    return (
      <div className="page narrow">
        <ErrorNotice
          error={skill.error}
          title="This skill could not be opened"
          action={
            <Button size="sm" onClick={() => navigate({ name: "skills" })}>
              My skills
            </Button>
          }
        />
      </div>
    );
  }
  return <Studio key={id} initial={skill.data} />;
}

function Studio({ initial }: { initial: LocalSkill }) {
  const draft = useSkillDraft(initial);
  const { id, skill, trashed, broken } = draft;
  const { navigate } = useNav();
  const { openProject } = useActions();
  const client = useQueryClient();
  const toast = useToast();
  const safely = useSafeInvoke();
  const projects = useRecentProjects();
  const overview = useSkillsOverview();
  const standing = overview.data?.find((s) => s.skillId === id);

  const root = useRef<HTMLDivElement>(null);
  const width = useWidth(root);
  const docked = width >= 960;
  const [mode, setMode] = useState<StudioMode>(broken ? "files" : "instructions");
  const [visited, setVisited] = useState<Set<StudioMode>>(() => new Set([broken ? "files" : "instructions"]));
  const [panelOpen, setPanelOpen] = useState(true);
  const [view, setView] = useState<PanelView>("context");
  const [writing, setWriting] = useState(true);
  const [cursorLine, setCursorLine] = useState(1);
  const [identEditing, setIdentEditing] = useState(false);
  const [fileRequest, setFileRequest] = useState<{ path: string; nonce: number } | null>(null);
  const [dialog, setDialog] = useState<"use" | "share" | null>(null);
  const editor = useRef<SourceEditorHandle>(null);
  const tabs = useRef<HTMLDivElement>(null);

  // Docked when there is room; a sheet, closed until asked for, when there is not.
  const wasDocked = useRef(docked);
  useEffect(() => {
    if (wasDocked.current !== docked) setPanelOpen(docked);
    wasDocked.current = docked;
  }, [docked]);

  const go = useCallback((next: StudioMode) => {
    setMode(next);
    setView("context");
    setVisited((v) => (v.has(next) ? v : new Set([...v, next])));
  }, []);

  const openPanel = (next: PanelView) => {
    setView(next);
    setPanelOpen(true);
  };
  /** The toggle opens the panel for what is being done, and closes whatever is open. */
  const togglePanel = useCallback(() => {
    setPanelOpen((open) => {
      if (!open) setView("context");
      return !open;
    });
  }, []);

  // A sheet takes focus when it opens, and gives it back to the toggle when it closes.
  const panelRef = useRef<HTMLElement>(null);
  const sheetWasOpen = useRef(false);
  useEffect(() => {
    const sheet = !docked && panelOpen;
    if (sheet && !sheetWasOpen.current) {
      requestAnimationFrame(() =>
        panelRef.current?.querySelector<HTMLElement>(".studio-panel-close")?.focus(),
      );
    } else if (!sheet && sheetWasOpen.current && !docked) {
      root.current?.querySelector<HTMLElement>(".studio-panel-toggle")?.focus();
    }
    sheetWasOpen.current = sheet;
  }, [docked, panelOpen]);

  const reveal = (line: number) => {
    go("instructions");
    setWriting(true);
    requestAnimationFrame(() => requestAnimationFrame(() => editor.current?.revealLine(line)));
  };

  const openFile = (path: string) => {
    if (path === "SKILL.md") return go("instructions");
    if (/^habi\.ya?ml$/.test(path)) return go("rules");
    go("files");
    setFileRequest({ path, nonce: Date.now() });
  };

  /** From a problem, a dialog or the palette to the place that fixes it. */
  const focusTarget = (t: NavTarget) => {
    setDialog(null);
    if (!docked) setPanelOpen(false);
    if (t.field === "identifier") {
      setIdentEditing(true);
      return;
    }
    if (t.field) {
      requestAnimationFrame(() =>
        window.document.getElementById(t.field === "title" ? "studio-title" : "studio-purpose")?.focus(),
      );
      return;
    }
    if (t.path) return openFile(t.path);
    if (t.mode === "instructions" && t.line) return reveal(t.line);
    if (t.mode) go(t.mode);
  };

  // Keys that belong to the Studio: modes, the panel, preview.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.defaultPrevented || otherDialogOpen()) return;
      const index = ["1", "2", "3"].indexOf(e.key);
      if (index >= 0 && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        const next = MODES[index];
        if (next) go(next.id);
      } else if (e.key === "\\") {
        e.preventDefault();
        togglePanel();
      } else if (e.shiftKey && e.key.toLowerCase() === "p" && mode === "instructions") {
        e.preventDefault();
        setWriting((w) => !w);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, mode, togglePanel]);

  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const keysToMove = ["ArrowRight", "ArrowLeft", "Home", "End"];
    if (!keysToMove.includes(e.key)) return;
    e.preventDefault();
    const index = MODES.findIndex((m) => m.id === mode);
    const nextIndex =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? MODES.length - 1
          : (index + (e.key === "ArrowRight" ? 1 : MODES.length - 1)) % MODES.length;
    const next = MODES[nextIndex];
    if (next) {
      go(next.id);
      requestAnimationFrame(() =>
        tabs.current?.querySelector<HTMLButtonElement>(`#studio-tab-${next.id}`)?.focus(),
      );
    }
  };

  // ----- actions on what is saved

  const openDialog = async (which: "use" | "share") => {
    draft.setActionError(null);
    if (!(await draft.saveFirst())) return;
    try {
      // Dialogs act on what is saved, so they read it back first.
      draft.adopt(await api.getSkill(id), { document: false, metadata: false });
      setDialog(which);
    } catch (e) {
      draft.setActionError(e);
    }
  };

  const exportFolder = async () => {
    draft.setActionError(null);
    if (!(await draft.saveFirst())) return;
    try {
      const path = await api.exportSkill(id);
      if (path) toast.show(`Exported to ${path}. It works there without Habi.`);
    } catch (e) {
      draft.setActionError(e);
    }
  };

  const trash = async () => {
    draft.setActionError(null);
    if (!(await draft.saveFirst())) return;
    try {
      await api.trashSkill(id);
      invalidateSkills(client);
      toast.show(`“${draft.title || "Untitled skill"}” moved to the trash. Restore it from My skills.`);
      navigate({ name: "skills" });
    } catch (e) {
      draft.setActionError(e);
    }
  };

  const restore = async () => {
    try {
      draft.adopt(await api.restoreSkill(id), { document: true, metadata: true });
      invalidateSkills(client);
    } catch (e) {
      draft.setActionError(e);
    }
  };

  const reveal_ = () => safely(() => api.revealSkill(id), "The folder was not shown");

  // The palette offers the Studio's modes and actions while it is open.
  const commandsRef = useRef({ go, openPanel, togglePanel, setWriting });
  commandsRef.current = { go, openPanel, togglePanel, setWriting };
  const commands = useMemo<ScreenCommand[]>(
    () => [
      ...MODES.map((m, i) => ({
        id: `mode-${m.id}`,
        label: `Go to ${m.label}`,
        keywords: m.short,
        keys: `⌘${i + 1}`,
        icon: (m.id === "files" ? "file" : m.id === "rules" ? "thread" : "pencil") as ScreenCommand["icon"],
        run: () => commandsRef.current.go(m.id),
      })),
      {
        id: "preview",
        label: "Preview the instructions",
        keys: "⌘⇧P",
        icon: "eye",
        run: () => {
          commandsRef.current.go("instructions");
          commandsRef.current.setWriting(false);
        },
      },
      {
        id: "share",
        label: "Use in a project, share or export…",
        keywords: "install export contribute",
        icon: "share",
        run: () => commandsRef.current.openPanel("share"),
      },
      {
        id: "lineage",
        label: "Where it comes from and what changed",
        keywords: "lineage origin upstream diff",
        icon: "branch",
        run: () => commandsRef.current.openPanel("lineage"),
      },
      {
        id: "panel",
        label: "Show or hide the side panel",
        keys: "⌘\\",
        icon: "panel",
        run: () => commandsRef.current.togglePanel(),
      },
    ],
    [],
  );
  useRegisterScreenCommands(draft.title ? `In ${draft.title}` : "In this skill", commands);

  const supporting = skill.files.filter((f) => f.path !== "SKILL.md" && !/^habi\.ya?ml$/.test(f.path));
  const panelTitle =
    view === "lineage" ? "Where it comes from" : view === "share" ? "Use & share" : PANEL_TITLE[mode];
  const compact = width < 700;

  return (
    <div
      ref={root}
      className={`studio is-${mode}${docked ? " is-docked" : " is-sheet"}${panelOpen ? " has-panel" : ""}${
        compact ? " is-compact" : ""
      }`}
    >
      <div className="studio-column">
        <Masthead
          draft={draft}
          standing={standing}
          onOpen={openPanel}
          onTrash={() => void trash()}
          onReveal={reveal_}
          onRestore={() => void restore()}
          identEditing={identEditing}
          setIdentEditing={setIdentEditing}
        />

        <StudioNotices draft={draft} onRepair={() => go("files")} />

        <div className="studio-bar" role="presentation">
          <div className="studio-modes" role="tablist" aria-label="Parts of the skill" ref={tabs}>
            {MODES.map((m, i) => (
              <button
                key={m.id}
                type="button"
                role="tab"
                id={`studio-tab-${m.id}`}
                aria-selected={mode === m.id}
                aria-controls={`studio-mode-${m.id}`}
                tabIndex={mode === m.id ? 0 : -1}
                className={`studio-mode${mode === m.id ? " is-active" : ""}`}
                title={`${m.label} (⌘${i + 1})`}
                onClick={() => go(m.id)}
                onKeyDown={onTabKey}
              >
                {compact ? m.short : m.label}
                {m.id === "files" && supporting.length > 0 ? (
                  <span className="studio-mode-count">{supporting.length}</span>
                ) : null}
                {m.id === "rules" && skill.summary.hasApplicability ? (
                  <span className="studio-mode-dot" title="Has rules" />
                ) : null}
              </button>
            ))}
          </div>
          <div className="studio-bar-tools">
            {mode === "instructions" && !broken ? (
              <fieldset className="studio-switch">
                <legend className="visually-hidden">Instructions view</legend>
                <button
                  type="button"
                  aria-pressed={writing}
                  className={writing ? "is-on" : undefined}
                  onClick={() => setWriting(true)}
                >
                  Write
                </button>
                <button
                  type="button"
                  aria-pressed={!writing}
                  className={!writing ? "is-on" : undefined}
                  title="Preview (⌘⇧P)"
                  onClick={() => setWriting(false)}
                >
                  Preview
                </button>
              </fieldset>
            ) : null}
            <button
              type="button"
              className="studio-panel-toggle"
              aria-expanded={panelOpen}
              aria-controls="studio-panel"
              title={`${panelOpen ? "Hide" : "Show"} the side panel (⌘\\)`}
              onClick={togglePanel}
            >
              <Icon name="panel" size={15} />
              <span className={docked ? "visually-hidden" : undefined}>{panelOpen ? "Hide" : "Context"}</span>
            </button>
          </div>
        </div>

        <div className="studio-body">
          <div className="studio-main">
            {MODES.filter((m) => visited.has(m.id)).map((m) => (
              <section
                key={m.id}
                role="tabpanel"
                id={`studio-mode-${m.id}`}
                aria-labelledby={`studio-tab-${m.id}`}
                className={`studio-mode-panel is-${m.id}`}
                hidden={mode !== m.id}
              >
                {m.id === "instructions" ? (
                  <InstructionsMode
                    draft={draft}
                    editor={editor}
                    writing={writing}
                    onCursorLine={setCursorLine}
                    onOpenFile={openFile}
                  />
                ) : m.id === "rules" ? (
                  <RulesMode draft={draft} />
                ) : (
                  <FilesPane
                    skill={skill}
                    readOnly={trashed}
                    request={fileRequest}
                    beforeChange={async () => {
                      if (!(await draft.flushAll())) throw new Error(NOT_SAVED);
                    }}
                    onSkill={(fresh, path) =>
                      draft.adopt(fresh, {
                        document: path === "SKILL.md",
                        metadata: path === undefined || /^habi\.ya?ml$/.test(path),
                      })
                    }
                  />
                )}
              </section>
            ))}
          </div>
        </div>
      </div>

      {panelOpen && !docked ? (
        <button
          type="button"
          className="studio-scrim"
          aria-label="Close the side panel"
          tabIndex={-1}
          onClick={() => setPanelOpen(false)}
        />
      ) : null}
      {panelOpen ? (
        <aside
          ref={panelRef}
          className={`studio-panel is-${view === "context" ? mode : view}`}
          id="studio-panel"
          aria-label={panelTitle}
          onKeyDown={(e) => {
            if (e.key === "Escape" && !docked) {
              e.stopPropagation();
              setPanelOpen(false);
            }
          }}
        >
          <header className="studio-panel-head">
            {view !== "context" ? (
              <button
                type="button"
                className="studio-panel-back"
                onClick={() => setView("context")}
                title="Back to the panel for this mode"
              >
                <Icon name="arrowLeft" size={13} />
                <span className="visually-hidden">Back</span>
              </button>
            ) : null}
            <h2 className="studio-panel-title">{panelTitle}</h2>
            <button
              type="button"
              className="studio-panel-close"
              aria-label="Close the side panel"
              onClick={() => setPanelOpen(false)}
            >
              <Icon name="close" size={14} />
            </button>
          </header>
          <div className="studio-panel-body" key={`${view}:${mode}`}>
            {view === "share" ? (
              <SharePanel
                draft={draft}
                standing={standing}
                onFix={focusTarget}
                onUse={() => void openDialog("use")}
                onShare={() => void openDialog("share")}
                onExport={() => void exportFolder()}
              />
            ) : view === "lineage" ? (
              <LineagePanel
                draft={draft}
                standing={standing}
                beforeReview={draft.saveFirst}
                onShare={() => void openDialog("share")}
              />
            ) : mode === "instructions" ? (
              <InstructionsPanel
                draft={draft}
                cursorLine={cursorLine}
                writing={writing}
                onReveal={reveal}
                onInsert={(text) => editor.current?.insert(text)}
                onOpenFile={openFile}
                onAddFile={() => go("files")}
              />
            ) : mode === "rules" ? (
              <ApplicabilityPreview
                request={draft.previewRequest(null)}
                requestKey={`${draft.rulesKey}|${(projects.data ?? []).map((p) => p.id).join(",")}`}
                hasProjects={(projects.data ?? []).some((p) => p.exists)}
                onOpenProject={() => void openProject({ stay: true })}
              />
            ) : (
              <FilesAbout />
            )}
          </div>
        </aside>
      ) : null}

      {dialog === "use" ? (
        <UseSkillDialog skill={skill} onClose={() => setDialog(null)} onFix={focusTarget} />
      ) : null}
      {dialog === "share" ? (
        <ShareSkillDialog skill={skill} onClose={() => setDialog(null)} onFix={focusTarget} />
      ) : null}
    </div>
  );
}

function StudioNotices({ draft, onRepair }: { draft: SkillDraft; onRepair: () => void }) {
  const { conflict, saveError, actionError, broken, skill } = draft;
  if (!conflict && !saveError && !actionError && !broken) return null;
  return (
    <div className="studio-notices">
      {conflict ? (
        <Notice
          tone="warn"
          title="This skill's files changed outside Habi"
          action={
            <>
              <Button size="sm" onClick={() => void draft.reloadFromDisk()}>
                Show the other version
              </Button>
              <Button size="sm" variant="quiet" onClick={() => void draft.keepMine()}>
                Keep mine
              </Button>
            </>
          }
        >
          Saving is paused so neither version is lost. “Show the other version” replaces what is on screen
          with the files on disk; “Keep mine” writes what is on screen over them.
        </Notice>
      ) : null}
      {saveError ? (
        <ErrorNotice
          error={saveError}
          title="Your latest edits are not saved yet"
          action={
            <Button size="sm" onClick={() => void draft.flushAll()}>
              Try again
            </Button>
          }
        />
      ) : null}
      {actionError ? <ErrorNotice error={actionError} /> : null}
      {broken ? (
        <Notice
          tone="warn"
          title="SKILL.md cannot be read as frontmatter and instructions"
          action={
            <Button size="sm" onClick={onRepair}>
              Open under Files
            </Button>
          }
        >
          {skill.documentError}. Repair the file as plain text; nothing was overwritten.
        </Notice>
      ) : null}
    </div>
  );
}

/** Rules: the builder, or the YAML as written. */
function RulesMode({ draft }: { draft: SkillDraft }) {
  const projects = useRecentProjects();
  const { form, setForm, yaml, setYaml, yamlMode, switchYaml, trashed, skill } = draft;
  const available = (projects.data ?? []).filter((p) => p.exists);
  return (
    <div className="studio-rules">
      <div className="studio-rules-bar">
        <p className="muted">
          Optional. Stored next to the skill in <span className="mono">habi.yaml</span> — other tools ignore
          it.
        </p>
        <fieldset className="studio-switch">
          <legend className="visually-hidden">How to edit the rules</legend>
          <button
            type="button"
            aria-pressed={!yamlMode}
            className={!yamlMode ? "is-on" : undefined}
            onClick={() => void switchYaml(false)}
          >
            Builder
          </button>
          <button
            type="button"
            aria-pressed={yamlMode}
            className={yamlMode ? "is-on" : undefined}
            onClick={() => void switchYaml(true)}
          >
            YAML
          </button>
        </fieldset>
      </div>
      {yamlMode ? (
        <>
          <SourceEditor
            language="yaml"
            label="habi.yaml"
            value={yaml}
            readOnly={trashed}
            placeholder={"habi: 1\napplies_when:\n  tag: framework:spring-boot"}
            onChange={setYaml}
          />
          <p className="field-hint">
            Saved exactly as typed, including keys Habi does not know.
            {skill.metadataStatus === "invalid"
              ? " It is not valid yet, so it is ignored for matching until fixed."
              : ""}
          </p>
        </>
      ) : form.conditionsEditable ? (
        <fieldset className="builder-fieldset" disabled={trashed}>
          <ConditionBuilder form={form} onChange={setForm} projects={available} />
        </fieldset>
      ) : (
        <Notice
          tone="unknown"
          title="These rules use combinations the builder cannot show"
          action={
            <Button size="sm" onClick={() => void switchYaml(true)}>
              Edit as YAML
            </Button>
          }
        >
          They are kept exactly as written and still evaluated in the preview.
        </Notice>
      )}
    </div>
  );
}

function FilesAbout() {
  return (
    <div className="panel-section">
      <p className="panel-note">
        A skill is a folder: <span className="mono">SKILL.md</span>, and optionally{" "}
        <span className="mono">scripts/</span>, <span className="mono">references/</span> and{" "}
        <span className="mono">assets/</span>. Agents read them when the instructions point there.
      </p>
      <p className="panel-note">Habi never runs a script. Viewing one is only viewing.</p>
    </div>
  );
}
