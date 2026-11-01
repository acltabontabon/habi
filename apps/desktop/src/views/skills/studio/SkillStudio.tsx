/**
 * The Skill Studio: one skill, as one document with layers.
 *
 * Opening a skill lands inside its knowledge — the title, what it is for,
 * where it came from, and the instructions themselves, set for reading and
 * writing. Everything else is a layer of the same skill, reached from the
 * head of the document and never on screen until asked for: when Habi should
 * suggest it, the materials that come with it (and, for developers, the
 * package as files). Testing it against a project and its provenance slide
 * in as sheets and leave again. The bar above says only where you are,
 * whether it is ready, and the one thing to do next: Add to a project when it
 * is ready, and while it is a draft, the step that gets it there.
 *
 * Habi handles the machinery. While the skill is a fresh draft, its title
 * follows the first heading and its identifier follows the title; saving is
 * silent unless it fails. Edits save to the draft on this machine as they are
 * typed; nothing here installs, runs or publishes.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { TextSelection } from "prosemirror-state";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { LocalSkill } from "../../../bindings/LocalSkill";
import { BackLink } from "../../../components/BackLink";
import { Icon } from "../../../components/Icon";
import { SaveIndicator } from "../../../components/SaveIndicator";
import { useToast } from "../../../components/Toasts";
import { Button, ErrorNotice, Notice, Working } from "../../../components/ui";
import { api } from "../../../lib/api";
import { type Refinement, refinements } from "../../../lib/coach";
import { firstHeading, isMaterial, materialsOf } from "../../../lib/materials";
import { useNav } from "../../../lib/nav";
import { modShortcut } from "../../../lib/platform";
import {
  invalidateSkills,
  keys,
  useRecentProjects,
  useSkills,
  useSkillsOverview,
} from "../../../lib/queries";
import { type ScreenCommand, useRegisterScreenCommands } from "../../../lib/screenCommands";
import { slugify } from "../../../lib/skills";
import type { NavTarget, StudioLayer } from "../../../lib/studioNav";
import { useRulesPreview } from "../../../lib/useRulesPreview";
import { ShareSkillDialog } from "../ShareSkillDialog";
import { UseSkillDialog } from "../UseSkillDialog";
import "../../../styles/weaving.css";
import "../../../styles/canvas-workbench.css";
import { type Panel, useComposer } from "./compose/useComposer";
import { WhenSummary } from "./compose/WhenSummary";
import { insertCapability, insertionAtSelection } from "./doc/capabilityPieces";
import { markdownForFile } from "./doc/fileRefs";
import { GuidanceActions } from "./doc/GuidanceActions";
import {
  attachGuidanceMaterial,
  attachGuidanceSkill,
  captureGuidanceTarget,
  type GuidanceTarget,
  subscribeGuidance,
} from "./doc/guidanceContext";
import type { DocEditorHandle } from "./doc/lazy";
import type { WeaveKind } from "./doc/WeaveBar";
import { Materials, useDropToAdd } from "./files/Materials";
import { type MaterialTarget, MaterialWorkspace } from "./files/MaterialWorkspace";
import { Instructions, Outline, useOutline } from "./Instructions";
import { isCopy, onward, Provenance, ProvenanceSheet } from "./Provenance";
import { nextStep, Readiness } from "./Readiness";
import { NOT_SAVED, type SkillDraft, useSkillDraft } from "./useSkillDraft";
import { WhenToUse } from "./WhenToUse";

const LAYER_NAME: Record<StudioLayer, string> = {
  skill: "Instructions",
  when: "When to use",
  materials: "Materials",
  source: "Package source",
};

type Sheet = "provenance";

const DESCRIPTION_LIMIT = 1024;

// The side sheet is a dialog too, but the Studio's own keys (Escape included) still reach it.
const otherDialogOpen = () =>
  document.querySelector('[role="dialog"]:not(.sk-pop):not(.sk-sheet), [role="alertdialog"]') !== null;
const isTextEntry = (t: EventTarget | null) =>
  t instanceof Element &&
  t.closest("input, textarea, select, [contenteditable='true'], .cm-editor, .doc-page") !== null;

/** The Studio's own width (not the window's): the sidebar takes its share. */
function useWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(1200);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(el);
    setWidth(el.clientWidth || 1200);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

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

function AutoGrow({
  value,
  onChange,
  ...rest
}: { value: string; onChange: (v: string) => void } & Omit<
  React.TextareaHTMLAttributes<HTMLTextAreaElement>,
  "value" | "onChange"
>) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const grow = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: grows with the text.
  useLayoutEffect(grow, [value, grow]);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth !== width) {
        width = el.clientWidth;
        grow();
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [grow]);
  return <textarea ref={ref} rows={1} value={value} onChange={(e) => onChange(e.target.value)} {...rest} />;
}

/**
 * While a skill is a fresh draft of yours, Habi names it: the title follows
 * the first heading until one is typed, and the identifier follows the title
 * until it is changed, installed or the skill came from elsewhere.
 */
function useInferredNames(draft: SkillDraft, installed: number) {
  const { title, setTitle, document, setDocument, skill, trashed } = draft;
  const skills = useSkills();
  const autoTitle = useRef(title.trim() === "");
  const written = !isCopy(skill.summary.origin);
  const autoName = useRef(written && (document.name === "" || document.name === slugify(title)));
  const lastName = useRef(document.name);

  useEffect(() => {
    if (!autoTitle.current || trashed) return;
    const heading = firstHeading(document.body);
    if (heading && heading !== title) setTitle(heading.slice(0, 120));
  }, [document.body, title, setTitle, trashed]);

  useEffect(() => {
    if (document.name !== lastName.current) autoName.current = false;
  }, [document.name]);

  useEffect(() => {
    if (installed > 0) autoName.current = false;
    if (!autoName.current || trashed) return;
    const base = slugify(title);
    if (!base) return;
    const taken = new Set(
      (skills.data ?? []).filter((s) => s.id !== skill.summary.id && s.deletedAt === null).map((s) => s.name),
    );
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base.slice(0, 36)}-${n}`;
    if (name !== document.name) {
      lastName.current = name;
      setDocument((d) => ({ ...d, name }));
    }
  }, [title, installed, skills.data, skill.summary.id, document.name, setDocument, trashed]);

  return { stopTitle: () => (autoTitle.current = false) };
}

function Studio({ initial }: { initial: LocalSkill }) {
  const draft = useSkillDraft(initial);
  const { id, skill, trashed, broken, title, setTitle, document, setDocument } = draft;
  const { navigate } = useNav();
  const client = useQueryClient();
  const toast = useToast();
  const projects = useRecentProjects();
  const [trayHost, setTrayHost] = useState<HTMLDivElement | null>(null);
  const overview = useSkillsOverview();
  const standing = overview.data?.find((s) => s.skillId === id);
  const available = (projects.data ?? []).filter((p) => p.exists);
  const names = useInferredNames(draft, standing?.installedIn.length ?? 0);

  const root = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const width = useWidth(root);
  const wide = width >= 960;
  const [layer, setLayer] = useState<StudioLayer>(broken ? "source" : "skill");
  const [visited, setVisited] = useState<Set<StudioLayer>>(
    () => new Set(["skill", broken ? "source" : "skill"]),
  );
  const [file, setFile] = useState<{ path: string | null; line?: number }>({
    path: broken ? "SKILL.md" : null,
  });
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [outlinePinned, setOutlinePinned] = useState(false);
  const [cursorLine, setCursorLine] = useState(1);
  const [identEditing, setIdentEditing] = useState(false);
  const [dialog, setDialog] = useState<"use" | "share" | null>(null);
  const [titleInView, setTitleInView] = useState(true);
  const [sourceMode, setSourceMode] = useState(false);
  const [agentView, setAgentView] = useState(false);
  const guidanceTarget = useRef<GuidanceTarget | null>(null);
  const [supportContext, setSupportContext] = useState<string | undefined>();
  const [expertiseCondition, setExpertiseCondition] = useState("");
  const [materialTarget, setMaterialTarget] = useState<MaterialTarget | null>(null);
  const evalProjectRef = useRef<string | null>(null);
  const openFileRef = useRef<(path: string) => void>(() => undefined);
  const goRef = useRef<(next: StudioLayer) => void>(() => undefined);
  const addFileRef = useRef<() => void>(() => undefined);
  const setPanelRef = useRef<(panel: Panel | null) => void>(() => undefined);
  const editor = useRef<DocEditorHandle>(null);
  const { outline, current } = useOutline(document.body, cursorLine);
  const composer = useComposer({
    draft,
    editor,
    projectId: evalProjectRef.current,
    onOpenFile: (path) => openFileRef.current(path),
    onAddFile: () => addFileRef.current(),
    onWhen: () => goRef.current("when"),
    onReadiness: () =>
      window.document.querySelector<HTMLElement>(".studio-toolbar-status [aria-haspopup]")?.click(),
    onSource: () => {
      setAgentView(false);
      setSourceMode(true);
    },
    ready: !skill.diagnostics.some((d) => d.level === "error"),
    problems: skill.diagnostics.filter((d) => d.level === "error").length,
    skillDragCondition: expertiseCondition,
    onAttachSkill: (view, pick) => {
      const target = guidanceTarget.current;
      if (!target) return false;
      if (!attachGuidanceSkill(view, target, pick, expertiseCondition)) {
        draft.setActionError(
          new Error("That instruction changed. Select it again before connecting expertise."),
        );
        return true;
      }
      target.release(view);
      guidanceTarget.current = null;
      setSupportContext(undefined);
      return true;
    },
    onCloseSupport: () => finishSupport(),
  });
  const materials = useMemo(() => materialsOf(skill.files, document.body), [skill.files, document.body]);
  const previousPanel = useRef(composer.panel?.kind);
  useEffect(() => {
    if (previousPanel.current === "shelf" && composer.panel?.kind !== "shelf") {
      const view = editor.current?.view();
      if (view) guidanceTarget.current?.release(view);
      guidanceTarget.current = null;
      setSupportContext(undefined);
    }
    previousPanel.current = composer.panel?.kind;
  }, [composer.panel?.kind]);
  useEffect(() => {
    const view = composer.view;
    if (!view) return;
    return subscribeGuidance(view, () => {
      const target = guidanceTarget.current;
      if (!target) return;
      const current = target.resolve(view);
      setSupportContext(
        current
          ? current.label
          : "This instruction was removed. Select another instruction to connect support.",
      );
    });
  }, [composer.view]);
  // Use only when there is something ready to use; until then, the next step.
  const ready = !skill.diagnostics.some((d) => d.level === "error");

  // The project a test runs against: the one it was written for or copied from, else the most recent.
  const origin = skill.summary.origin;
  const originProject =
    origin.type === "createdForProject" || origin.type === "instructions" || origin.type === "project"
      ? available.find((p) => p.name === origin.projectName)?.id
      : undefined;
  const evalProject = originProject ?? available[0]?.id ?? null;
  const evaluation = useRulesPreview(
    draft.previewRequest(evalProject),
    `${draft.rulesKey}|${evalProject ?? ""}`,
    composer.panel?.kind === "when" && draft.yamlMode,
  );

  evalProjectRef.current = evalProject;
  setPanelRef.current = composer.setPanel;
  const go = useCallback((next: StudioLayer) => {
    // When it's used is said at the head of the page, so it's changed beside the page.
    if (next === "when") {
      setLayer("skill");
      setPanelRef.current({ kind: "when" });
      return;
    }
    setLayer(next);
    setVisited((v) => (v.has(next) ? v : new Set([...v, next])));
    if (next !== "source") setFile((f) => (f.path ? { path: null } : f));
    stage.current?.scrollTo?.({ top: 0 });
  }, []);

  const openSheet = (next: Sheet) => {
    opener.current = window.document.activeElement as HTMLElement | null;
    setSheet(next);
  };
  const opener = useRef<HTMLElement | null>(null);
  const sheetRef = useRef<HTMLElement>(null);
  const closeSheet = () => {
    setSheet(null);
    const back = opener.current;
    opener.current = null;
    requestAnimationFrame(() => back?.isConnected && back.focus());
  };
  useEffect(() => {
    if (sheet)
      requestAnimationFrame(() => sheetRef.current?.querySelector<HTMLElement>(".sk-sheet-close")?.focus());
  }, [sheet]);

  // The title in the bar appears once the document's own title has scrolled away.
  useEffect(() => {
    const el = titleRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setTitleInView(Boolean(entry?.isIntersecting)), {
      root: stage.current,
      threshold: 0,
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // A fresh skill opens ready to write: the caret waits in the instructions.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, on opening.
  useEffect(() => {
    if (trashed || broken || title.trim() || document.body.trim()) return;
    let tries = 0;
    const timer = window.setInterval(() => {
      tries += 1;
      if (editor.current || tries > 30) {
        window.clearInterval(timer);
        editor.current?.focus();
      }
    }, 50);
    return () => window.clearInterval(timer);
  }, []);

  const reveal = (line: number, atEnd = false) => {
    go("skill");
    setAgentView(false);
    setSourceMode(false);
    composer.setPanel(null);
    setMaterialTarget(null);
    requestAnimationFrame(() => requestAnimationFrame(() => editor.current?.revealLine(line, atEnd)));
  };

  const retainGuidance = (target: GuidanceTarget) => {
    const view = editor.current?.view();
    if (view) guidanceTarget.current?.release(view);
    guidanceTarget.current = target;
    setSupportContext(target.label);
  };
  const finishSupport = () => {
    const view = editor.current?.view();
    const target = guidanceTarget.current;
    if (view && target) {
      const current = target.resolve(view);
      target.release(view);
      if (current)
        view.dispatch(
          view.state.tr
            .setSelection(TextSelection.near(view.state.doc.resolve(current.from + 1)))
            .scrollIntoView(),
        );
      view.focus();
    }
    guidanceTarget.current = null;
    setSupportContext(undefined);
  };
  const showMaterial = async (target: MaterialTarget) => {
    if (!(await draft.flushAll())) {
      draft.setActionError(new Error("Save or resolve the open material before switching."));
      return;
    }
    setAgentView(false);
    setSourceMode(false);
    composer.setPanel(null);
    setFile({ path: null });
    setMaterialTarget(target);
  };

  const weaveSupport = (kind: WeaveKind, captured?: GuidanceTarget) => {
    const view = editor.current?.view();
    if (!view || trashed) return;
    const target = captured ?? captureGuidanceTarget(view);
    if (!target) return;
    retainGuidance(target);
    if (kind === "skill") {
      setExpertiseCondition("");
      composer.setPanel({ kind: "shelf" });
    } else {
      void showMaterial({
        path: null,
        ...(kind === "script"
          ? { create: "python" as const }
          : kind === "reference"
            ? { create: "reference" as const }
            : {}),
      });
    }
  };

  const openFile = (path: string, line?: number) => {
    if (path === "SKILL.md" && !broken) return line ? reveal(line) : go("skill");
    if (/^habi\.ya?ml$/.test(path)) return go("when");
    if (isMaterial(path) && layer === "skill") {
      void showMaterial({ path });
      return;
    }
    go(isMaterial(path) && layer !== "source" ? "materials" : "source");
    setFile({ path, line });
  };

  const addFile = () => {
    const view = editor.current?.view();
    const target = view && captureGuidanceTarget(view);
    if (target) retainGuidance(target);
    void showMaterial({ path: null });
  };
  const attachMaterial = (path: string, purpose?: string) => {
    const view = editor.current?.view();
    if (!view || trashed || sourceMode || agentView) return;
    if (guidanceTarget.current) {
      if (!attachGuidanceMaterial(view, guidanceTarget.current, path, purpose))
        draft.setActionError(
          new Error(
            "The file is available, but that instruction changed. Select an instruction to connect it.",
          ),
        );
      return;
    }
    const material = materialsOf(skill.files, document.body).find((file) => file.path === path);
    const verb = material?.kind === "script" || /^scripts\//.test(path) ? "Use" : "Consult";
    insertCapability(view, insertionAtSelection(view), `${verb} ${markdownForFile(path)} to ….`);
  };
  addFileRef.current = addFile;
  openFileRef.current = openFile;
  goRef.current = go;

  const viewSource = (path: string | null) => {
    void draft.flushAll().then((saved) => {
      if (!saved) {
        draft.setActionError(new Error(NOT_SAVED));
        return;
      }
      setMaterialTarget(null);
      go("source");
      setFile({ path: path ?? "SKILL.md" });
    });
  };

  /** A material the instructions never mention: a line for it at the end, ready to be described. */
  const reference = (path: string) => {
    const name = path.slice(path.lastIndexOf("/") + 1);
    // A path with a space is only a Markdown link inside angle brackets.
    const target = /\s/.test(path) ? `<${path}>` : path;
    go("skill");
    requestAnimationFrame(() => editor.current?.appendMarkdown(`- [${name}](${target}) — `));
  };

  const spotlight = (selector: string) => {
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const target = window.document.querySelector<HTMLElement>(selector);
        if (!target) return;
        const focus = target.matches("input, textarea, button, [contenteditable]")
          ? target
          : target.querySelector<HTMLElement>("input, textarea, button");
        focus?.focus({ preventScroll: true });
        target.scrollIntoView?.({
          block: "center",
          behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
        });
        target.classList.add("studio-fix-highlight");
        window.setTimeout(() => target.classList.remove("studio-fix-highlight"), 2400);
      }),
    );
  };
  const revealWhen = () => {
    setSourceMode(false);
    setAgentView(false);
    go("when");
    spotlight('.sk-when-panel section[aria-labelledby="wu-when"]');
  };

  /** From a problem, a dialog or the palette to the place that fixes it. */
  const focusTarget = (t: NavTarget) => {
    setDialog(null);
    setSheet(null);
    if (t.field === "identifier") return setIdentEditing(true);
    if (t.field) {
      go("skill");
      setSourceMode(false);
      setAgentView(false);
      composer.setPanel(null);
      setMaterialTarget(null);
      spotlight(t.field === "title" ? "#studio-title" : "#studio-purpose");
      return;
    }
    if (t.path) return openFile(t.path, t.line);
    if (t.layer === "skill" && t.line) return reveal(t.line);
    if (t.layer === "when") return revealWhen();
    if (t.layer === "skill") return reveal(1);
    if (t.layer) go(t.layer);
  };

  /** Up one level: from a file to its layer, from a layer to the skill. */
  const up = () => {
    if (file.path && layer !== "skill") return setFile({ path: null });
    if (layer === "source") return go("materials");
    go("skill");
  };

  // Keys that belong to the Studio.
  const keyState = useRef({ go, up, layer, sheet, closeSheet, outline: outline.length });
  keyState.current = { go, up, layer, sheet, closeSheet, outline: outline.length };
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || otherDialogOpen()) return;
      const k = keyState.current;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.shiftKey && !e.altKey && ["1", "2", "3"].includes(e.key)) {
        e.preventDefault();
        k.go((["skill", "when", "materials"] as const)[Number(e.key) - 1] ?? "skill");
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        if (k.layer !== "skill") k.go("skill");
        setOutlinePinned((p) => !p);
      } else if (e.key === "Escape" && !mod && k.sheet) {
        // The rest of the Studio is inert while a sheet is open, so wherever focus is, Escape is the sheet's.
        e.preventDefault();
        k.closeSheet();
      } else if (e.key === "Escape" && !mod && !isTextEntry(e.target) && k.layer !== "skill") {
        e.preventDefault();
        k.up();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ----- actions on what is saved

  const openDialog = async (which: "use" | "share") => {
    draft.setActionError(null);
    if (!(await draft.saveFirst())) return;
    try {
      // Dialogs act on what is saved, so they read it back first.
      draft.adopt(await api.getSkill(id), { document: false, metadata: false });
      setSheet(null);
      setDialog(which);
    } catch (e) {
      draft.setActionError(e);
    }
  };

  // Export and restore run once at a time: a second click while one is under way does nothing.
  const [busy, setBusy] = useState<"export" | "restore" | null>(null);
  const working = useRef(false);
  const once = async (which: "export" | "restore", work: () => Promise<void>) => {
    if (working.current) return;
    working.current = true;
    setBusy(which);
    try {
      await work();
    } finally {
      working.current = false;
      setBusy(null);
    }
  };

  const exportZip = () =>
    once("export", async () => {
      draft.setActionError(null);
      if (!(await draft.saveFirst())) return;
      try {
        const path = await api.exportSkill(id);
        if (path) toast.show(`Saved ${path}.`);
      } catch (e) {
        draft.setActionError(e);
      }
    });

  const trash = async () => {
    draft.setActionError(null);
    if (!(await draft.saveFirst())) return;
    try {
      await api.trashSkill(id);
      invalidateSkills(client);
      toast.show(`“${title || "Untitled skill"}” moved to the trash. Restore it from My skills.`);
      navigate({ name: "skills" });
    } catch (e) {
      draft.setActionError(e);
    }
  };

  const restore = () =>
    once("restore", async () => {
      try {
        draft.adopt(await api.restoreSkill(id), { document: true, metadata: true });
        invalidateSkills(client);
      } catch (e) {
        draft.setActionError(e);
      }
    });

  /** Each refinement's one action: the place, or the change, it asks for. */
  const refine = (r: Refinement) => {
    switch (r.kind) {
      case "opening":
        setDocument((d) => ({ ...d, description: r.sentence }));
        return focusTarget({ field: "description" });
      case "unfinished":
        return reveal(r.line, true);
    }
  };

  const beforeChange = useCallback(async () => {
    if (!(await draft.flushAll())) throw new Error(NOT_SAVED);
  }, [draft.flushAll]);
  const onSkill = useCallback(
    (fresh: LocalSkill, path?: string) =>
      draft.adopt(fresh, {
        document: path === "SKILL.md",
        metadata: path === undefined || /^habi\.ya?ml$/.test(path ?? ""),
      }),
    [draft.adopt],
  );
  const dropping = useDropToAdd({
    enabled: !trashed,
    skill,
    beforeChange,
    onSkill: (fresh) => onSkill(fresh),
    onError: draft.setActionError,
    // Dropped on the page, a file also gets a line of its own there: a picture shows, the rest link.
    onAdded: (paths, at) => {
      if (layer !== "skill" || sourceMode || paths.length === 0) return;
      const markdown = paths.map(markdownForFile).join("\n\n");
      requestAnimationFrame(() =>
        at ? editor.current?.insertBlocksNear(markdown, at) : editor.current?.insertAt(markdown, null),
      );
    },
  });

  const shareLabel =
    origin.type === "library"
      ? `Contribute to ${origin.sourceName}…`
      : isCopy(origin)
        ? "Share your version…"
        : "Share…";

  // The palette offers the Studio's layers and actions while it is open.
  const switchYaml = draft.switchYaml;
  const commandsRef = useRef({ go, openSheet, openDialog, viewSource, exportZip, switchYaml });
  commandsRef.current = { go, openSheet, openDialog, viewSource, exportZip, switchYaml };
  const commands = useMemo<ScreenCommand[]>(
    () => [
      {
        id: "layer-skill",
        label: "Go to the instructions",
        keys: modShortcut("1"),
        icon: "pencil",
        run: () => commandsRef.current.go("skill"),
      },
      {
        id: "layer-when",
        label: "When to use",
        keywords: "rules signals suggest applies",
        keys: modShortcut("2"),
        icon: "thread",
        run: () => commandsRef.current.go("when"),
      },
      {
        id: "layer-materials",
        label: "Materials",
        keywords: "files scripts examples references assets add script",
        keys: modShortcut("3"),
        icon: "file",
        run: () => commandsRef.current.go("materials"),
      },
      {
        id: "outline",
        label: "Open the outline",
        keywords: "headings toc sections jump",
        keys: modShortcut("⇧O"),
        icon: "outline",
        run: () => {
          commandsRef.current.go("skill");
          setOutlinePinned(true);
        },
      },
      ...(ready
        ? [
            {
              id: "use",
              label: "Add to a project…",
              keywords: "install apply",
              icon: "download" as const,
              run: () => void commandsRef.current.openDialog("use"),
            },
          ]
        : []),
      {
        id: "share",
        label: shareLabel.replace(/…$/, "…"),
        keywords: "share contribute publish propose library",
        icon: "share",
        run: () => void commandsRef.current.openDialog("share"),
      },
      {
        id: "provenance",
        label: "Where it came from and what changed",
        keywords: "provenance history origin upstream diff changes lineage",
        icon: "branch",
        run: () => commandsRef.current.openSheet("provenance"),
      },
      {
        id: "yaml",
        label: "Edit When to use as YAML",
        keywords: "habi.yaml rules raw signals",
        icon: "thread",
        run: () => {
          commandsRef.current.go("when");
          void commandsRef.current.switchYaml(true);
        },
      },
      {
        id: "source",
        label: "View source (SKILL.md)",
        keywords: "raw markdown frontmatter",
        icon: "file",
        run: () => commandsRef.current.viewSource("SKILL.md"),
      },
      {
        id: "package",
        label: "View package source",
        keywords: "files tree habi.yaml developer",
        icon: "layers",
        run: () => commandsRef.current.viewSource(null),
      },
      {
        id: "export",
        label: "Export as zip…",
        keywords: "download archive save folder",
        icon: "download",
        run: () => void commandsRef.current.exportZip(),
      },
    ],
    [shareLabel, ready],
  );
  useRegisterScreenCommands(title ? `In ${title}` : "In this skill", commands);

  const filePath = layer === "materials" || layer === "source" ? file.path : null;
  const purposeLength = document.description.length;
  const cameFrom = isCopy(origin) || origin.type === "instructions" || standing?.upstream != null;
  // Nothing written yet: nothing else asks for attention.
  const fresh =
    !title.trim() && !document.description.trim() && !document.body.trim() && materials.length === 0;
  const better = useMemo(
    () =>
      trashed || broken
        ? []
        : refinements({
            description: document.description,
            body: document.body,
          }),
    [trashed, broken, document.description, document.body],
  );

  // The next step mixes what is typed with what the last save reported, so
  // it is worked out only once both agree: while a save is on its way, the
  // bar keeps the step it last showed rather than one from half the picture.
  const shownNext = useRef<ReturnType<typeof nextStep>>(null);
  if (draft.settled) shownNext.current = ready ? null : nextStep(draft);
  const next = shownNext.current;
  const passOn = onward(skill.summary);

  const sheetTitle = "Where it came from";

  return (
    <div
      ref={root}
      className={`sk is-${layer}${filePath ? " has-file" : ""}${wide ? " is-wide" : ""}${dropping ? " is-dropping" : ""}`}
      data-save={draft.saveState}
    >
      <header className="sk-bar" inert={sheet !== null}>
        <div className="sk-where">
          {layer === "skill" ? (
            <BackLink fallback={{ name: "skills" }} fallbackLabel="My skills" compact />
          ) : (
            <button
              type="button"
              className="editor-back is-icon"
              aria-label={filePath ? `Back to ${LAYER_NAME[layer]}` : "Back to the instructions"}
              title={filePath ? LAYER_NAME[layer] : "Instructions (Esc)"}
              onClick={up}
            >
              <Icon name="arrowLeft" size={14} />
            </button>
          )}
          <nav className="sk-crumbs" aria-label="Where you are">
            <button
              type="button"
              className={`sk-crumb is-title${layer === "skill" && titleInView ? " is-tucked" : ""}`}
              tabIndex={layer === "skill" && titleInView ? -1 : undefined}
              onClick={() =>
                layer === "skill" ? stage.current?.scrollTo?.({ top: 0, behavior: "smooth" }) : go("skill")
              }
            >
              {title || "Untitled skill"}
            </button>
            {layer !== "skill" ? (
              <>
                <span className="sk-crumb-sep" aria-hidden="true">
                  /
                </span>
                {filePath ? (
                  <button type="button" className="sk-crumb" onClick={() => setFile({ path: null })}>
                    {LAYER_NAME[layer]}
                  </button>
                ) : (
                  <span className="sk-crumb is-here" aria-current="page">
                    {LAYER_NAME[layer]}
                  </span>
                )}
              </>
            ) : null}
            {filePath ? (
              <>
                <span className="sk-crumb-sep" aria-hidden="true">
                  /
                </span>
                <span className="sk-crumb is-here is-file" aria-current="page" title={filePath}>
                  {filePath.slice(filePath.lastIndexOf("/") + 1)}
                </span>
              </>
            ) : null}
          </nav>
        </div>
        <div className="sk-acts">
          {layer === "skill" ? (
            <>
              <div className="studio-toolbar-status">
                <Readiness
                  draft={draft}
                  standing={standing}
                  identEditing={identEditing}
                  setIdentEditing={setIdentEditing}
                  onFix={focusTarget}
                  better={better}
                  onRefine={refine}
                  others={composer.others}
                  onOpenOther={composer.showUse}
                />
              </div>
              <span className="studio-view-separator" aria-hidden="true" />
            </>
          ) : null}
          {layer === "skill" ? (
            <div className="studio-view-controls">
              <span className="studio-view-label">View as</span>
              <nav className="studio-view-toggle" aria-label="Skill perspectives">
                <button
                  type="button"
                  aria-label="Canvas"
                  title="Canvas"
                  aria-pressed={!sourceMode && !agentView}
                  onClick={() => {
                    editor.current?.text();
                    setSourceMode(false);
                    setAgentView(false);
                    composer.setPanel(null);
                  }}
                >
                  <Icon name="panel" size={15} />
                </button>
                <button
                  type="button"
                  aria-label="Agent view"
                  title="Agent view"
                  aria-pressed={agentView}
                  onClick={() => {
                    editor.current?.text();
                    setSourceMode(false);
                    setAgentView(true);
                    composer.setPanel(null);
                  }}
                >
                  <Icon name="eye" size={15} />
                </button>
                <button
                  type="button"
                  aria-label="Markdown"
                  title="Markdown"
                  aria-pressed={sourceMode}
                  onClick={() => {
                    editor.current?.text();
                    setSourceMode(true);
                    setAgentView(false);
                    composer.setPanel(null);
                  }}
                >
                  <Icon name="file" size={15} />
                </button>
              </nav>
            </div>
          ) : null}
          {layer === "skill" && !trashed ? (
            <span className="studio-view-separator" aria-hidden="true" />
          ) : null}
          {!trashed ? (
            <button
              type="button"
              className="studio-trash"
              aria-label="Move to trash"
              title="Move to trash · restore from My skills"
              onClick={() => void trash()}
            >
              <Icon name="trash" size={15} />
            </button>
          ) : null}
          {!trashed ? (
            <SaveIndicator state={draft.saveState} ambient onRetry={() => void draft.flushAll()} />
          ) : null}
          {trashed ? (
            <Button variant="primary" disabled={busy === "restore"} onClick={() => void restore()}>
              {busy === "restore" ? "Restoring…" : "Restore"}
            </Button>
          ) : !next && ready ? (
            <div className="studio-publish-actions">
              {passOn ? (
                <button
                  type="button"
                  onClick={() => void openDialog("share")}
                  title={origin.type === "library" ? `Offer your changes to ${origin.sourceName}` : undefined}
                >
                  <Icon name="share" size={14} />
                  {passOn}
                </button>
              ) : null}
              <button type="button" onClick={() => void openDialog("use")}>
                <Icon name="plus" size={14} />
                Add to a project…
              </button>
            </div>
          ) : null}
        </div>
      </header>
      <StudioNotices draft={draft} onRepair={() => viewSource("SKILL.md")} inert={sheet !== null} />

      <div className="sk-with-panel">
        <div className="sk-stage-col" inert={sheet !== null}>
          <div className="sk-stage" ref={stage}>
            <section className="sk-layer is-skill" hidden={layer !== "skill"} aria-label="The skill">
              <div className="sk-page">
                {!broken ? (
                  <aside className={`sk-margin${wide ? "" : " is-narrow"}`}>
                    <Outline
                      outline={outline}
                      current={current}
                      pinned={outlinePinned}
                      onPinned={setOutlinePinned}
                      onGo={(line) => reveal(line)}
                    />
                  </aside>
                ) : null}
                <article className="sk-doc">
                  <header className="sk-head studio-title-layout">
                    <div className="studio-title-copy">
                      <label className="studio-field-label" htmlFor="studio-title">
                        Skill title
                      </label>
                      <input
                        ref={titleRef}
                        id="studio-title"
                        className="sk-title"
                        value={title}
                        placeholder="Name your skill"
                        disabled={trashed || broken}
                        spellCheck
                        autoComplete="off"
                        onChange={(e) => {
                          names.stopTitle();
                          setTitle(e.target.value);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            if (document.body.trim())
                              window.document.getElementById("studio-purpose")?.focus();
                            else window.document.querySelector<HTMLElement>(".canvas-piece")?.focus();
                          }
                        }}
                      />
                      <label className="studio-field-label" htmlFor="studio-purpose">
                        Description
                      </label>
                      <AutoGrow
                        id="studio-purpose"
                        aria-label="What it is for"
                        className="sk-purpose"
                        value={document.description}
                        disabled={trashed || broken}
                        placeholder="What should this skill help the agent accomplish?"
                        aria-describedby={
                          purposeLength > DESCRIPTION_LIMIT - 150 ? "studio-purpose-hint" : undefined
                        }
                        aria-invalid={purposeLength > DESCRIPTION_LIMIT ? true : undefined}
                        // SKILL.md keeps its description on one line: Enter goes on to the
                        // instructions, and line breaks pasted in become spaces.
                        onChange={(text) =>
                          setDocument((d) => ({ ...d, description: text.replace(/[ \t]*\r?\n[ \t]*/g, " ") }))
                        }
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                            e.preventDefault();
                            editor.current?.focus();
                          }
                        }}
                      />
                      {purposeLength > DESCRIPTION_LIMIT - 150 ? (
                        <p
                          id="studio-purpose-hint"
                          className={`sk-purpose-hint${purposeLength > DESCRIPTION_LIMIT ? " is-over" : ""}`}
                        >
                          {purposeLength > DESCRIPTION_LIMIT
                            ? `${purposeLength} characters — the format allows ${DESCRIPTION_LIMIT}.`
                            : `${DESCRIPTION_LIMIT - purposeLength} characters left.`}
                        </p>
                      ) : null}
                      {/* Provenance is said when the knowledge came from somewhere; your own needs no line. */}
                      {fresh || !cameFrom ? null : (
                        <Provenance
                          summary={skill.summary}
                          standing={standing}
                          onOpen={() => openSheet("provenance")}
                        />
                      )}
                    </div>
                    {!broken && composer.panel?.kind !== "when" ? (
                      <div className="studio-title-when">
                        <WhenSummary draft={draft} onOpen={() => go("when")} />
                      </div>
                    ) : null}
                  </header>
                  {!broken && (sourceMode || agentView) ? (
                    <div className="weave-workspace-head">
                      <h2>{sourceMode ? "Instruction source" : "What the agent receives"}</h2>
                    </div>
                  ) : null}
                  {broken ? (
                    <p className="sk-broken">
                      SKILL.md can’t be read as a skill.{" "}
                      <button type="button" className="link-btn" onClick={() => viewSource("SKILL.md")}>
                        Repair it as text
                      </button>
                    </p>
                  ) : (
                    <div>
                      <GuidanceActions
                        view={composer.view}
                        onSupport={() =>
                          composer.view?.dom.dispatchEvent(
                            new CustomEvent("habi-palette", { detail: "support" }),
                          )
                        }
                      />
                      <Instructions
                        draft={draft}
                        editor={editor}
                        sourceMode={sourceMode}
                        agentView={agentView}
                        composer={composer}
                        trayHost={trayHost}
                        onCursorLine={setCursorLine}
                        onOpenFile={openFile}
                        onWeave={weaveSupport}
                      />
                    </div>
                  )}
                </article>
              </div>
            </section>

            {visited.has("materials") || visited.has("source") ? (
              <section
                className="sk-layer is-materials"
                hidden={layer !== "materials" && layer !== "source"}
                aria-label={layer === "source" ? "Package source" : "Materials"}
              >
                <div className={filePath || layer === "source" ? "sk-work-page" : "sk-sheet-page"}>
                  <Materials
                    skill={skill}
                    readOnly={trashed}
                    active={layer === "materials"}
                    source={layer === "source"}
                    path={filePath}
                    line={file.line}
                    instructions={document.body}
                    beforeChange={beforeChange}
                    onSkill={onSkill}
                    onPath={(path, line) => {
                      void draft.flushAll().then((saved) => {
                        if (saved) {
                          setMaterialTarget(null);
                          setFile({ path, line });
                        }
                      });
                    }}
                    onSource={(on) => (on ? viewSource(null) : go("materials"))}
                    onReference={reference}
                    onWhen={() => go("when")}
                  />
                </div>
              </section>
            ) : null}
          </div>
          <div className="sk-tray-dock" ref={setTrayHost} hidden={layer !== "skill"} />
        </div>
        {materialTarget ? (
          <div
            className="sk-panel is-material-workspace"
            hidden={layer !== "skill" || composer.panel !== null || sourceMode || agentView}
          >
            <MaterialWorkspace
              draft={draft}
              active={layer === "skill" && composer.panel === null && !sourceMode && !agentView}
              target={materialTarget}
              editor={editor}
              onTarget={(target) => void showMaterial(target)}
              onAttach={attachMaterial}
              onClose={() => {
                setMaterialTarget(null);
                finishSupport();
              }}
              onSource={() => {
                void draft.flushAll().then((saved) => {
                  if (saved) {
                    setMaterialTarget(null);
                    viewSource(materialTarget.path);
                  }
                });
              }}
            />
          </div>
        ) : null}
        {composer.panel?.kind === "when" && layer === "skill" ? (
          <section className="sk-panel is-wide sk-when-panel" aria-label="When to use">
            <button
              type="button"
              className="shelf-close sk-when-close"
              aria-label="Close"
              onClick={() => composer.setPanel(null)}
            >
              <Icon name="close" size={14} />
            </button>
            <WhenToUse
              draft={draft}
              projects={available}
              projectId={evalProject}
              preview={evaluation.preview}
            />
          </section>
        ) : null}
        {composer.panelNode && layer === "skill" ? (
          <div className="sk-panel">
            {composer.panel?.kind === "shelf" && supportContext ? (
              <div className="weave-support-destination">
                <span className="weave-eyebrow">Connecting expertise to</span>
                <blockquote>{supportContext}</blockquote>
                <label htmlFor="expertise-condition">When should this expertise help?</label>
                <input
                  id="expertise-condition"
                  value={expertiseCondition}
                  onChange={(event) => setExpertiseCondition(event.target.value)}
                  placeholder="e.g. authentication or permissions change"
                />
              </div>
            ) : null}
            {composer.panelNode}
          </div>
        ) : null}
      </div>
      {composer.inspectorNode}

      {sheet ? (
        <>
          <button type="button" className="sk-scrim" aria-label="Close" tabIndex={-1} onClick={closeSheet} />
          <aside
            ref={sheetRef}
            className={`sk-sheet is-${sheet}`}
            role="dialog"
            aria-modal="true"
            aria-label={sheetTitle}
          >
            <header className="sk-sheet-head">
              <h2 className="sk-sheet-title">{sheetTitle}</h2>
              <button type="button" className="sk-sheet-close" aria-label="Close" onClick={closeSheet}>
                <Icon name="close" size={14} />
              </button>
            </header>
            <div className="sk-sheet-body">
              <ProvenanceSheet
                summary={skill.summary}
                standing={standing}
                title={title}
                beforeReview={draft.saveFirst}
                onReloaded={() => void draft.reloadFromDisk()}
                onShare={() => void openDialog("share")}
                onExport={() => void exportZip()}
              />
            </div>
          </aside>
        </>
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

function StudioNotices({
  draft,
  onRepair,
  inert,
}: {
  draft: SkillDraft;
  onRepair: () => void;
  inert: boolean;
}) {
  const { conflict, actionError, broken, skill } = draft;
  if (!conflict && !actionError && !broken) return null;
  return (
    <div className="sk-notices" inert={inert}>
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
      {actionError ? <ErrorNotice error={actionError} /> : null}
      {broken ? (
        <Notice
          tone="warn"
          title="SKILL.md cannot be read as frontmatter and instructions"
          action={
            <Button size="sm" onClick={onRepair}>
              Repair it as text
            </Button>
          }
        >
          {skill.documentError}. Nothing was overwritten.
        </Notice>
      ) : null}
    </div>
  );
}
