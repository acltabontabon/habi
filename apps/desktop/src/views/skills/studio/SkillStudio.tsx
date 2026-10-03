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
 * whether it is ready, and the one thing to do next: Use when it is ready,
 * and while it is a draft, the step that gets it there.
 *
 * Habi handles the machinery. While the skill is a fresh draft, its title
 * follows the first heading and its identifier follows the title; saving is
 * silent unless it fails. Edits save to the draft on this machine as they are
 * typed; nothing here installs, runs or publishes.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { LocalSkill } from "../../../bindings/LocalSkill";
import { BackLink } from "../../../components/BackLink";
import { Icon } from "../../../components/Icon";
import { Menu } from "../../../components/Menu";
import { SaveIndicator } from "../../../components/SaveIndicator";
import type { SourceEditorHandle } from "../../../components/SourceEditor";
import { useToast } from "../../../components/Toasts";
import { Button, ErrorNotice, Notice, Working } from "../../../components/ui";
import { useActions } from "../../../lib/actions";
import { api } from "../../../lib/api";
import { type Refinement, refinements } from "../../../lib/coach";
import {
  firstHeading,
  isMaterial,
  materialsLine,
  materialsOf,
  type Signal,
  signalClause,
} from "../../../lib/materials";
import { useNav } from "../../../lib/nav";
import {
  invalidateSkills,
  keys,
  useRecentProjects,
  useSkills,
  useSkillsOverview,
} from "../../../lib/queries";
import { useSafeInvoke } from "../../../lib/safeInvoke";
import { type ScreenCommand, useRegisterScreenCommands } from "../../../lib/screenCommands";
import { slugify } from "../../../lib/skills";
import type { NavTarget, StudioLayer } from "../../../lib/studioNav";
import { tagLabel } from "../../../lib/tags";
import { useRulesPreview } from "../../../lib/useRulesPreview";
import { ShareSkillDialog } from "../ShareSkillDialog";
import { UseSkillDialog } from "../UseSkillDialog";
import { Materials, useDropToAdd } from "./files/Materials";
import { Instructions, Outline, useOutline } from "./Instructions";
import { ProjectEvaluation } from "./ProjectEvaluation";
import { isCopy, Provenance, ProvenanceSheet } from "./Provenance";
import { nextStep, Readiness } from "./Readiness";
import { NOT_SAVED, type SkillDraft, useSkillDraft } from "./useSkillDraft";
import { addSignal, WhenToUse, whenLine } from "./WhenToUse";

const LAYER_NAME: Record<StudioLayer, string> = {
  skill: "Instructions",
  when: "When to use",
  materials: "Materials",
  source: "Package source",
};

type Sheet = "provenance" | "test";

const DESCRIPTION_LIMIT = 1024;

const otherDialogOpen = () =>
  document.querySelector('[role="dialog"]:not(.sk-pop), [role="alertdialog"]') !== null;
const isTextEntry = (t: EventTarget | null) =>
  t instanceof Element && t.closest("input, textarea, select, [contenteditable='true'], .cm-editor") !== null;

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
  const { openProject } = useActions();
  const client = useQueryClient();
  const toast = useToast();
  const safely = useSafeInvoke();
  const projects = useRecentProjects();
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
  const editor = useRef<SourceEditorHandle>(null);
  const { outline, current } = useOutline(document.body, cursorLine);
  const materials = useMemo(() => materialsOf(skill.files, document.body), [skill.files, document.body]);
  // Use only when there is something ready to use; until then, the next step.
  const ready = !skill.diagnostics.some((d) => d.level === "error");

  // The project a test runs against: the one it was written for or copied from, else the most recent.
  const origin = skill.summary.origin;
  const originProject =
    origin.type === "createdForProject" || origin.type === "instructions" || origin.type === "project"
      ? available.find((p) => p.name === origin.projectName)?.id
      : undefined;
  const [chosenProject, setChosenProject] = useState<string | null>(null);
  const evalProject =
    (chosenProject && available.some((p) => p.id === chosenProject) ? chosenProject : null) ??
    originProject ??
    available[0]?.id ??
    null;
  const evaluation = useRulesPreview(
    draft.previewRequest(evalProject),
    `${draft.rulesKey}|${evalProject ?? ""}`,
    sheet === "test" || (layer === "when" && draft.yamlMode),
  );

  const go = useCallback((next: StudioLayer) => {
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
    requestAnimationFrame(() => requestAnimationFrame(() => editor.current?.revealLine(line, atEnd)));
  };

  const openFile = (path: string, line?: number) => {
    if (path === "SKILL.md" && !broken) return line ? reveal(line) : go("skill");
    if (/^habi\.ya?ml$/.test(path)) return go("when");
    go(isMaterial(path) && layer !== "source" ? "materials" : "source");
    setFile({ path, line });
  };

  const viewSource = (path: string | null) => {
    go("source");
    setFile({ path: path ?? "SKILL.md" });
  };

  /** A material the instructions never mention: a line for it at the end, ready to be described. */
  const reference = (path: string) => {
    const name = path.slice(path.lastIndexOf("/") + 1);
    const body = document.body.replace(/\s*$/, "");
    const next = `${body}${body ? "\n\n" : ""}- [${name}](${path}) — `;
    setDocument((d) => ({ ...d, body: next }));
    reveal(next.split("\n").length, true);
  };

  /** From a problem, a dialog or the palette to the place that fixes it. */
  const focusTarget = (t: NavTarget) => {
    setDialog(null);
    setSheet(null);
    if (t.field === "identifier") return setIdentEditing(true);
    if (t.field) {
      go("skill");
      requestAnimationFrame(() =>
        window.document.getElementById(t.field === "title" ? "studio-title" : "studio-purpose")?.focus(),
      );
      return;
    }
    if (t.path) return openFile(t.path, t.line);
    if (t.layer === "skill" && t.line) return reveal(t.line);
    if (t.layer) go(t.layer);
  };

  /** Up one level: from a file to its layer, from a layer to the skill. */
  const up = () => {
    if (file.path && layer !== "skill") return setFile({ path: null });
    if (layer === "source") return go("materials");
    go("skill");
  };

  // Keys that belong to the Studio.
  const keyState = useRef({ go, up, layer, sheet, outline: outline.length });
  keyState.current = { go, up, layer, sheet, outline: outline.length };
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
      } else if (e.key === "Escape" && !mod && !isTextEntry(e.target) && !k.sheet && k.layer !== "skill") {
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
      toast.show(`“${title || "Untitled skill"}” moved to the trash. Restore it from My skills.`);
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

  const showFolder = () => safely(() => api.revealSkill(id), "The folder was not shown");

  const suggestSignal = (signal: Signal) => {
    const before = draft.form;
    draft.setForm(addSignal(before, signal));
    toast.show(`Now suggested when ${signalClause(signal)}.`, "ok", {
      label: "Undo",
      run: () => draft.setForm(before),
    });
  };

  /** Each refinement's one action: the place, or the change, it asks for. */
  const refine = (r: Refinement) => {
    switch (r.kind) {
      case "opening":
        return setDocument((d) => ({ ...d, description: r.sentence }));
      case "unfinished":
        return reveal(r.line, true);
      case "purpose":
        return focusTarget({ field: "description" });
      case "instructions":
        return reveal(document.body.split("\n").length, true);
      case "inferred":
        return suggestSignal(r.signal);
      case "signals":
        return go("when");
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
  });

  const shareLabel =
    origin.type === "library"
      ? `Contribute to ${origin.sourceName}…`
      : isCopy(origin)
        ? "Share your version…"
        : "Share…";

  // The palette offers the Studio's layers and actions while it is open.
  const switchYaml = draft.switchYaml;
  const commandsRef = useRef({ go, openSheet, openDialog, viewSource, exportFolder, showFolder, switchYaml });
  commandsRef.current = { go, openSheet, openDialog, viewSource, exportFolder, showFolder, switchYaml };
  const commands = useMemo<ScreenCommand[]>(
    () => [
      {
        id: "layer-skill",
        label: "Go to the instructions",
        keys: "⌘1",
        icon: "pencil",
        run: () => commandsRef.current.go("skill"),
      },
      {
        id: "layer-when",
        label: "When to use",
        keywords: "rules signals suggest applies",
        keys: "⌘2",
        icon: "thread",
        run: () => commandsRef.current.go("when"),
      },
      {
        id: "layer-materials",
        label: "Materials",
        keywords: "files scripts examples references assets add script",
        keys: "⌘3",
        icon: "file",
        run: () => commandsRef.current.go("materials"),
      },
      {
        id: "outline",
        label: "Open the outline",
        keywords: "headings toc sections jump",
        keys: "⌘⇧O",
        icon: "outline",
        run: () => {
          commandsRef.current.go("skill");
          setOutlinePinned(true);
        },
      },
      {
        id: "test",
        label: "Test against a project…",
        keywords: "try check billing applies",
        icon: "play",
        run: () => commandsRef.current.openSheet("test"),
      },
      ...(ready
        ? [
            {
              id: "use",
              label: "Use in a project…",
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
        label: "Export as a folder…",
        icon: "folder",
        run: () => void commandsRef.current.exportFolder(),
      },
      {
        id: "folder",
        label: "Show the package folder",
        icon: "folder",
        run: () => commandsRef.current.showFolder(),
      },
    ],
    [shareLabel, ready],
  );
  useRegisterScreenCommands(title ? `In ${title}` : "In this skill", commands);

  const when = whenLine(draft);
  const brings = materialsLine(materials);
  const filePath = layer === "materials" || layer === "source" ? file.path : null;
  const purposeLength = document.description.length;
  const cameFrom = isCopy(origin) || origin.type === "instructions" || standing?.upstream != null;
  // Nothing written yet: nothing else asks for attention.
  const fresh =
    !title.trim() && !document.description.trim() && !document.body.trim() && materials.length === 0;
  const { form } = draft;
  const signalCount =
    form.conditionsEditable && skill.metadataStatus !== "invalid"
      ? form.appliesTags.length + form.appliesDependencies.length + form.appliesFiles.length
      : null;
  const better = useMemo(
    () =>
      trashed || broken
        ? []
        : refinements({
            title,
            description: document.description,
            body: document.body,
            signals: signalCount,
            tagsLabel: tagLabel,
          }),
    [trashed, broken, title, document.description, document.body, signalCount],
  );

  const next = ready ? null : nextStep(draft);

  const sheetTitle = sheet === "test" ? "Test against a project" : "Where it came from";

  return (
    <div
      ref={root}
      className={`sk is-${layer}${filePath ? " has-file" : ""}${wide ? " is-wide" : ""}${dropping ? " is-dropping" : ""}`}
      data-save={draft.saveState}
    >
      <header className="sk-bar">
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
          {!trashed ? (
            <SaveIndicator state={draft.saveState} ambient onRetry={() => void draft.flushAll()} />
          ) : null}
          <Readiness
            draft={draft}
            standing={standing}
            identEditing={identEditing}
            setIdentEditing={setIdentEditing}
            onFix={focusTarget}
            better={better}
            onRefine={refine}
          />
          {trashed ? (
            <Button variant="primary" onClick={() => void restore()}>
              Restore
            </Button>
          ) : (
            <>
              {next ? (
                <Button variant="primary" onClick={() => focusTarget(next.target)}>
                  {next.label}
                </Button>
              ) : ready ? (
                <Button variant="primary" onClick={() => void openDialog("use")}>
                  Use
                </Button>
              ) : null}
              <Menu
                label="More for this skill"
                items={[
                  [
                    { label: shareLabel, icon: "share", onSelect: () => void openDialog("share") },
                    {
                      label: "Export as a folder…",
                      icon: "folder",
                      hint: "Works without Habi",
                      onSelect: () => void exportFolder(),
                    },
                  ],
                  [
                    { label: "Where it came from", icon: "branch", onSelect: () => openSheet("provenance") },
                    { label: "Test against a project…", icon: "play", onSelect: () => openSheet("test") },
                    {
                      label: "View source",
                      icon: "file",
                      hint: "SKILL.md as written",
                      onSelect: () => viewSource("SKILL.md"),
                    },
                    { label: "View package source", icon: "layers", onSelect: () => viewSource(null) },
                    { label: "Show the package folder", icon: "folder", onSelect: showFolder },
                  ],
                  [
                    {
                      label: "Move to trash",
                      icon: "trash",
                      danger: true,
                      hint: "Restore it from My skills",
                      onSelect: () => void trash(),
                    },
                  ],
                ]}
              />
            </>
          )}
        </div>
      </header>

      <StudioNotices draft={draft} onRepair={() => viewSource("SKILL.md")} />

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
              <header className="sk-head">
                <label className="visually-hidden" htmlFor="studio-title">
                  Skill title
                </label>
                <input
                  ref={titleRef}
                  id="studio-title"
                  className="sk-title"
                  value={title}
                  placeholder="Untitled skill"
                  disabled={trashed}
                  spellCheck
                  autoComplete="off"
                  onChange={(e) => {
                    names.stopTitle();
                    setTitle(e.target.value);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      window.document.getElementById("studio-purpose")?.focus();
                    }
                  }}
                />
                <label className="visually-hidden" htmlFor="studio-purpose">
                  What it is for
                </label>
                <AutoGrow
                  id="studio-purpose"
                  className="sk-purpose"
                  value={document.description}
                  disabled={trashed || broken}
                  placeholder="What it helps with, and when an agent should reach for it."
                  aria-describedby="studio-purpose-hint"
                  aria-invalid={purposeLength > DESCRIPTION_LIMIT ? true : undefined}
                  onChange={(description) => setDocument((d) => ({ ...d, description }))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      editor.current?.focus();
                    }
                  }}
                />
                <p
                  id="studio-purpose-hint"
                  className={`sk-purpose-hint${purposeLength > DESCRIPTION_LIMIT ? " is-over" : ""}`}
                >
                  {purposeLength > DESCRIPTION_LIMIT
                    ? `${purposeLength} characters — the format allows ${DESCRIPTION_LIMIT}.`
                    : `Agents read only this to decide whether to use it.${
                        purposeLength > DESCRIPTION_LIMIT - 150
                          ? ` ${DESCRIPTION_LIMIT - purposeLength} left.`
                          : ""
                      }`}
                </p>
                {/* Provenance is said when the knowledge came from somewhere; your own needs no line. */}
                {fresh || !cameFrom ? null : (
                  <Provenance
                    summary={skill.summary}
                    standing={standing}
                    onOpen={() => openSheet("provenance")}
                  />
                )}
                <nav className="sk-layers" aria-label="More of this skill" hidden={fresh}>
                  <button type="button" className="sk-layer-link" onClick={() => go("when")}>
                    <span className="sk-layer-label">When to use</span>
                    <span className={`sk-layer-value${when ? "" : " is-none"}`}>
                      {when ?? "When you choose it"}
                    </span>
                  </button>
                  <button type="button" className="sk-layer-link" onClick={() => go("materials")}>
                    <span className="sk-layer-label">Comes with</span>
                    <span className={`sk-layer-value${brings ? "" : " is-none"}`}>
                      {brings || "Instructions only"}
                    </span>
                  </button>
                </nav>
              </header>
              {broken ? (
                <p className="sk-broken">
                  SKILL.md can’t be read as a skill.{" "}
                  <button type="button" className="link-btn" onClick={() => viewSource("SKILL.md")}>
                    Repair it as text
                  </button>
                </p>
              ) : (
                <Instructions
                  draft={draft}
                  editor={editor}
                  onCursorLine={setCursorLine}
                  onOpenFile={openFile}
                />
              )}
            </article>
          </div>
        </section>

        {visited.has("when") ? (
          <section className="sk-layer is-when" hidden={layer !== "when"} aria-label="When to use">
            <div className="sk-sheet-page">
              <WhenToUse
                draft={draft}
                projects={available}
                projectId={evalProject}
                preview={evaluation.preview}
              />
            </div>
          </section>
        ) : null}

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
                onPath={(path, line) => setFile({ path, line })}
                onSource={(on) => (on ? viewSource(null) : go("materials"))}
                onReference={reference}
                onWhen={() => go("when")}
              />
            </div>
          </section>
        ) : null}
      </div>

      {sheet ? (
        <>
          <button type="button" className="sk-scrim" aria-label="Close" tabIndex={-1} onClick={closeSheet} />
          <aside
            ref={sheetRef}
            className={`sk-sheet is-${sheet}`}
            aria-label={sheetTitle}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                closeSheet();
              }
            }}
          >
            <header className="sk-sheet-head">
              <h2 className="sk-sheet-title">{sheetTitle}</h2>
              <button type="button" className="sk-sheet-close" aria-label="Close" onClick={closeSheet}>
                <Icon name="close" size={14} />
              </button>
            </header>
            <div className="sk-sheet-body">
              {sheet === "test" ? (
                <ProjectEvaluation
                  projects={available}
                  projectId={evalProject}
                  onProject={setChosenProject}
                  evaluation={evaluation}
                  allRequest={draft.previewRequest(null)}
                  allKey={`${draft.rulesKey}|${available.map((p) => p.id).join(",")}`}
                  onOpenProject={() => void openProject({ stay: true })}
                />
              ) : (
                <ProvenanceSheet
                  summary={skill.summary}
                  standing={standing}
                  title={title}
                  beforeReview={draft.saveFirst}
                  onReloaded={() => void draft.reloadFromDisk()}
                  onShare={() => void openDialog("share")}
                  onExport={() => void exportFolder()}
                />
              )}
            </div>
            {sheet === "test" ? (
              <footer className="sk-sheet-foot">
                <Button onClick={closeSheet}>Done</Button>
              </footer>
            ) : null}
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

function StudioNotices({ draft, onRepair }: { draft: SkillDraft; onRepair: () => void }) {
  const { conflict, actionError, broken, skill } = draft;
  if (!conflict && !actionError && !broken) return null;
  return (
    <div className="sk-notices">
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
