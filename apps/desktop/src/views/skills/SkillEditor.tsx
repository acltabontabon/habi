/**
 * The skill editor: three connected concerns — purpose, instructions and
 * applicability — with the applicability preview alongside. Edits are saved
 * to the draft on this machine as you type; nothing here installs or
 * publishes.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LocalSkill } from "../../bindings/LocalSkill";
import type { PreviewRequest } from "../../bindings/PreviewRequest";
import type { ShareForm } from "../../bindings/ShareForm";
import type { SkillDocument } from "../../bindings/SkillDocument";
import { BackLink } from "../../components/BackLink";
import { Icon } from "../../components/Icon";
import { Markdown, SourceEditor } from "../../components/lazy";
import { SaveIndicator } from "../../components/SaveIndicator";
import type { SourceEditorHandle } from "../../components/SourceEditor";
import { useToast } from "../../components/Toasts";
import { Button, ErrorNotice, Notice, Working } from "../../components/ui";
import { useActions } from "../../lib/actions";
import { api } from "../../lib/api";
import { NO_RULES_PHRASE, plural, relativeTime } from "../../lib/format";
import { useNav } from "../../lib/nav";
import { invalidateSkills, keys, useRecentProjects } from "../../lib/queries";
import { useSafeInvoke } from "../../lib/safeInvoke";
import { identifierProblem, originShort, originText, slugify } from "../../lib/skills";
import { type SaveState, useAutosave } from "../../lib/useAutosave";
import { ApplicabilityPreview } from "./ApplicabilityPreview";
import { ConditionBuilder } from "./ConditionBuilder";
import { FilesPane } from "./FilesPane";
import { PackageRefs } from "./PackageRefs";
import { ShareSkillDialog } from "./ShareSkillDialog";
import { UpstreamPanel } from "./UpstreamPanel";
import { UseSkillDialog } from "./UseSkillDialog";

type Tab = "purpose" | "instructions" | "applicability" | "files";
const TABS: { id: Tab; label: string }[] = [
  { id: "instructions", label: "Instructions" },
  { id: "purpose", label: "Purpose" },
  { id: "applicability", label: "Applicability" },
  { id: "files", label: "Files" },
];

const STARTERS: { label: string; body: string }[] = [
  {
    label: "Review procedure",
    body: "## Before you start\n\n- \n\n## Review steps\n\n1. \n\n## Report\n\nSay what you checked, what you found, and what you could not verify.\n",
  },
  {
    label: "Implementation guide",
    body: "## Context\n\n\n\n## Steps\n\n1. \n\n## Done when\n\n- \n",
  },
];

type DocValue = { title: string; document: SkillDocument };

const NOT_SAVED = "Nothing was done: your latest edits are not saved. Resolve that above, then try again.";

const docKey = (v: DocValue) =>
  JSON.stringify([v.title, v.document.name, v.document.description, v.document.body]);
const formKey = (f: ShareForm) => JSON.stringify(f);

const RANK: SaveState[] = ["clean", "saved", "pending", "saving", "error", "conflict"];
function worst(...states: SaveState[]): SaveState {
  return states.reduce((a, b) => (RANK.indexOf(b) > RANK.indexOf(a) ? b : a), "clean");
}

export function SkillEditor({ id }: { id: string }) {
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
  return <Loaded key={id} initial={skill.data} />;
}

function Loaded({ initial }: { initial: LocalSkill }) {
  const id = initial.summary.id;
  const { navigate } = useNav();
  const { openProject } = useActions();
  const client = useQueryClient();
  const toast = useToast();
  const safely = useSafeInvoke();
  const projects = useRecentProjects();
  const [skill, setSkill] = useState(initial);
  const [title, setTitle] = useState(initial.summary.title);
  const [document, setDocument] = useState(initial.document);
  const [form, setForm] = useState<ShareForm>({ ...initial.form, title: initial.summary.title });
  const [yaml, setYaml] = useState(initial.metadataText ?? "");
  const [yamlMode, setYamlMode] = useState(false);
  const [tab, setTab] = useState<Tab>("instructions");
  const bodyEditor = useRef<SourceEditorHandle>(null);
  // Where the rules apply matters while writing the purpose and the rules;
  // instructions and files get the full width.
  const showsPreview = tab === "purpose" || tab === "applicability";
  const [writing, setWriting] = useState(true);
  const [showProblems, setShowProblems] = useState(false);
  const [dialog, setDialog] = useState<"use" | "share" | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const docDigest = useRef(initial.documentDigest);
  const metaDigest = useRef(initial.metadataDigest);
  const tabsRef = useRef<HTMLDivElement>(null);

  const trashed = skill.summary.deletedAt !== null;
  const broken = skill.documentError !== null;
  const available = (projects.data ?? []).filter((p) => p.exists);

  const docValue = useMemo(() => ({ title, document }), [title, document]);
  const formValue = useMemo(() => ({ ...form, title }), [form, title]);

  const docSave = useAutosave<DocValue>({
    value: docValue,
    keyOf: docKey,
    enabled: !trashed && !broken,
    save: async (v) => {
      const saved = await api.saveSkillDocument(id, v.title, v.document, docDigest.current);
      docDigest.current = saved.documentDigest;
      setSkill(saved);
      invalidateSkills(client);
    },
  });
  const formSave = useAutosave<ShareForm>({
    value: formValue,
    keyOf: formKey,
    enabled: !trashed && !yamlMode,
    save: async (v) => {
      const saved = await api.saveSkillApplicability(id, v, metaDigest.current);
      metaDigest.current = saved.metadataDigest;
      setSkill(saved);
      invalidateSkills(client);
    },
  });
  const yamlSave = useAutosave<string>({
    value: yaml,
    keyOf: (v) => v,
    enabled: !trashed && yamlMode,
    save: async (v) => {
      const saved = await api.saveSkillMetadata(id, v, metaDigest.current);
      metaDigest.current = saved.metadataDigest;
      setSkill(saved);
      invalidateSkills(client);
    },
  });
  const saveState = worst(docSave.state, yamlMode ? yamlSave.state : formSave.state);

  const titleRef = useRef(title);
  titleRef.current = title;
  const resetDoc = docSave.reset;
  const resetForm = formSave.reset;
  const resetYaml = yamlSave.reset;

  /** Takes the version on disk as the truth for the named parts of the screen. */
  const adopt = useCallback(
    (fresh: LocalSkill, parts: { document: boolean; metadata: boolean }) => {
      setSkill(fresh);
      if (parts.document) {
        docDigest.current = fresh.documentDigest;
        setTitle(fresh.summary.title);
        setDocument(fresh.document);
        resetDoc(docKey({ title: fresh.summary.title, document: fresh.document }));
      }
      if (parts.metadata) {
        metaDigest.current = fresh.metadataDigest;
        const next = { ...fresh.form, title: parts.document ? fresh.summary.title : titleRef.current };
        setForm(next);
        resetForm(formKey(next));
        setYaml(fresh.metadataText ?? "");
        resetYaml(fresh.metadataText ?? "");
      }
    },
    [resetDoc, resetForm, resetYaml],
  );

  /** Writes pending edits; true when everything on screen is saved. */
  const flushAll = async () => {
    const results = await Promise.all([docSave.flush(), formSave.flush(), yamlSave.flush()]);
    return results.every(Boolean);
  };
  /** Before acting on what is on disk: stops (and says why) when edits are not saved. */
  const saveFirst = async () => {
    const saved = await flushAll();
    if (!saved) setActionError(new Error(NOT_SAVED));
    return saved;
  };

  const reloadFromDisk = async () => {
    try {
      adopt(await api.getSkill(id), { document: true, metadata: true });
    } catch (e) {
      setActionError(e);
    }
  };

  const keepMine = async () => {
    try {
      const fresh = await api.getSkill(id);
      docDigest.current = fresh.documentDigest;
      metaDigest.current = fresh.metadataDigest;
      docSave.retry();
      formSave.retry();
      yamlSave.retry();
    } catch (e) {
      setActionError(e);
    }
  };

  const switchYaml = async (on: boolean) => {
    setActionError(null);
    try {
      await (on ? formSave.flush() : yamlSave.flush());
      const fresh = await api.getSkill(id);
      adopt(fresh, { document: false, metadata: true });
      setYamlMode(on);
    } catch (e) {
      setActionError(e);
    }
  };

  const open = async (which: "use" | "share") => {
    setActionError(null);
    if (!(await saveFirst())) return;
    try {
      // Dialogs act on what is saved, so they read it back first.
      setSkill(await api.getSkill(id));
      setDialog(which);
    } catch (e) {
      setActionError(e);
    }
  };

  const exportFolder = async () => {
    setActionError(null);
    if (!(await saveFirst())) return;
    try {
      const path = await api.exportSkill(id);
      if (path) toast.show(`Exported to ${path}. It works there without Habi.`);
    } catch (e) {
      setActionError(e);
    }
  };

  const trash = async () => {
    setActionError(null);
    if (!(await saveFirst())) return;
    try {
      await api.trashSkill(id);
      invalidateSkills(client);
      toast.show(`“${title || "Untitled skill"}” moved to the trash. Restore it from My skills.`);
      navigate({ name: "skills" });
    } catch (e) {
      setActionError(e);
    }
  };

  const restore = async () => {
    try {
      adopt(await api.restoreSkill(id), { document: true, metadata: true });
      invalidateSkills(client);
    } catch (e) {
      setActionError(e);
    }
  };

  // ⌘S reassures: it writes immediately instead of waiting for the pause.
  const flushDoc = docSave.flush;
  const flushForm = formSave.flush;
  const flushYaml = yamlSave.flush;
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void Promise.all([flushDoc(), flushForm(), flushYaml()]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flushDoc, flushForm, flushYaml]);

  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const index = TABS.findIndex((t) => t.id === tab);
    const next = TABS[(index + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
    if (next) {
      setTab(next.id);
      requestAnimationFrame(() =>
        tabsRef.current?.querySelector<HTMLButtonElement>(`#skill-tab-${next.id}`)?.focus(),
      );
    }
  };

  /** From a blocked install/share dialog straight to the tab that fixes it. */
  const fixFromDialog = (target: Tab) => {
    setDialog(null);
    setTab(target);
    requestAnimationFrame(() =>
      window.document
        .querySelector<HTMLElement>(`#skill-panel-${target} textarea, #skill-panel-${target} input`)
        ?.focus(),
    );
  };

  const errors = skill.diagnostics.filter((d) => d.level === "error");
  const warnings = skill.diagnostics.filter((d) => d.level === "warning");
  const nameProblem = identifierProblem(document.name.trim());
  const suggestedName = slugify(title);
  const origin = skill.summary.origin;
  const originProject =
    origin.type === "createdForProject" || origin.type === "instructions" || origin.type === "project"
      ? available.find((p) => p.name === origin.projectName)?.id
      : undefined;
  const supporting = skill.files.filter((f) => f.path !== "SKILL.md" && !/^habi\.ya?ml$/.test(f.path));

  const previewRequest: PreviewRequest | null = trashed
    ? null
    : yamlMode
      ? { skillId: id, form: null, metadataText: yaml }
      : { skillId: id, form: formValue, metadataText: null };
  const previewKey = yamlMode
    ? `yaml:${yaml}`
    : JSON.stringify([
        form.matchMode,
        form.appliesTags,
        form.appliesDependencies,
        form.appliesFiles,
        form.excludeTags,
        form.excludeDependencies,
        form.repositoryScope,
        form.conditionsEditable ? "" : skill.metadataDigest,
        available.map((p) => p.id),
      ]);

  const conflict =
    docSave.state === "conflict" || formSave.state === "conflict" || yamlSave.state === "conflict";
  const saveError =
    docSave.state === "error"
      ? docSave.error
      : (yamlMode ? yamlSave : formSave).state === "error"
        ? (yamlMode ? yamlSave : formSave).error
        : null;

  return (
    <div className="editor">
      <header className="editor-head">
        <BackLink fallback={{ name: "skills" }} fallbackLabel="My skills" />
        <div className="editor-title-row">
          <label className="visually-hidden" htmlFor="skill-title">
            Skill title
          </label>
          <input
            id="skill-title"
            className="editor-title"
            value={title}
            placeholder="Untitled skill"
            disabled={trashed}
            onChange={(e) => setTitle(e.target.value)}
          />
          {!trashed ? <SaveIndicator state={saveState} savedAt={skill.summary.updatedAt} /> : null}
        </div>
        <p className="editor-meta">
          <span title={originText(origin)}>{originShort(origin)}</span>
          <span aria-hidden="true"> · </span>
          {trashed ? (
            <span>In the trash since {relativeTime(skill.summary.deletedAt)}</span>
          ) : errors.length > 0 ? (
            <button
              type="button"
              className="link-btn"
              aria-expanded={showProblems}
              onClick={() => setShowProblems((s) => !s)}
            >
              Draft — {plural(errors.length, "thing")} to finish before installing or sharing
            </button>
          ) : (
            <span>
              Local draft · a valid skill package
              {warnings.length > 0 ? (
                <>
                  {" · "}
                  <button
                    type="button"
                    className="link-btn"
                    aria-expanded={showProblems}
                    onClick={() => setShowProblems((s) => !s)}
                  >
                    {plural(warnings.length, "note")}
                  </button>
                </>
              ) : null}
            </span>
          )}
        </p>
        {trashed ? (
          <div className="editor-actions">
            <Button variant="primary" onClick={() => void restore()}>
              Restore
            </Button>
          </div>
        ) : (
          <div className="editor-actions">
            <Button variant="primary" icon="download" onClick={() => void open("use")}>
              Use in a project…
            </Button>
            <Button icon="share" onClick={() => void open("share")}>
              {skill.summary.origin.type === "library"
                ? `Share back to ${skill.summary.origin.sourceName}…`
                : "Share…"}
            </Button>
            <Button variant="quiet" onClick={() => void exportFolder()}>
              Export…
            </Button>
            <Button variant="quiet" icon="trash" onClick={() => void trash()}>
              Move to trash
            </Button>
          </div>
        )}
      </header>
      <UpstreamPanel skill={skill} beforeReview={saveFirst} onApplied={reloadFromDisk} />

      {showProblems && errors.length + warnings.length > 0 ? (
        <ul className="editor-problems">
          {[...errors, ...warnings].map((d, i) => (
            <li key={i} className={d.level === "error" ? "is-error" : undefined}>
              <Icon name={d.level === "error" ? "warning" : "info"} size={14} />
              <span>
                {d.path ? <span className="mono">{d.path}: </span> : null}
                {d.message}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {conflict ? (
        <Notice
          tone="warn"
          title="This skill's files changed outside Habi"
          action={
            <>
              <Button size="sm" onClick={() => void reloadFromDisk()}>
                Show the other version
              </Button>
              <Button size="sm" variant="quiet" onClick={() => void keepMine()}>
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
            <Button size="sm" onClick={() => void flushAll()}>
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
            <Button size="sm" onClick={() => setTab("files")}>
              Open under Files
            </Button>
          }
        >
          {skill.documentError}. Repair the file as plain text; nothing was overwritten.
        </Notice>
      ) : null}

      <div className={`editor-body${showsPreview ? "" : " is-full"}`}>
        <div className="editor-main">
          <div className="tabs editor-tabs" role="tablist" aria-label="Skill sections" ref={tabsRef}>
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`skill-tab-${t.id}`}
                aria-selected={tab === t.id}
                aria-controls={`skill-panel-${t.id}`}
                tabIndex={tab === t.id ? 0 : -1}
                className={`tab${tab === t.id ? " is-active" : ""}`}
                onClick={() => setTab(t.id)}
                onKeyDown={onTabKey}
              >
                {t.label}
                {t.id === "files" && supporting.length > 0 ? (
                  <span className="tab-count">{supporting.length}</span>
                ) : null}
              </button>
            ))}
          </div>

          <div
            className={`editor-panel editor-panel-${tab}`}
            role="tabpanel"
            id={`skill-panel-${tab}`}
            aria-labelledby={`skill-tab-${tab}`}
          >
            {tab === "purpose" ? (
              <fieldset className="form editor-form" disabled={trashed || broken}>
                <label className="field">
                  <span className="field-label">What it helps accomplish, and when to use it</span>
                  <textarea
                    className="input"
                    rows={4}
                    value={document.description}
                    placeholder="Reviews Liquibase changesets for locking and rollback risk. Use when a change adds or edits a changelog."
                    onChange={(e) => setDocument({ ...document, description: e.target.value })}
                  />
                  <span className={document.description.length > 1024 ? "field-problem" : "field-hint"}>
                    {document.description.trim() === ""
                      ? "Agents decide whether to load a skill from this text alone. Name the task and the moment to use it."
                      : document.description.length > 1024
                        ? `${document.description.length} characters — the format allows 1024.`
                        : "Agents decide whether to load a skill from this text alone."}
                  </span>
                </label>
                <label className="field field-narrow">
                  <span className="field-label">Identifier</span>
                  <input
                    className="input mono"
                    value={document.name}
                    spellCheck={false}
                    autoComplete="off"
                    aria-invalid={document.name !== "" && nameProblem ? true : undefined}
                    onChange={(e) => setDocument({ ...document, name: e.target.value })}
                  />
                  <span className={document.name !== "" && nameProblem ? "field-problem" : "field-hint"}>
                    {nameProblem ?? "The folder name agents see. Renaming later is fine while it is a draft."}{" "}
                    {suggestedName && suggestedName !== document.name ? (
                      <button
                        type="button"
                        className="link-btn"
                        onClick={() => setDocument({ ...document, name: suggestedName })}
                      >
                        Use <span className="mono">{suggestedName}</span>
                      </button>
                    ) : null}
                  </span>
                </label>
                <dl className="meta-grid editor-facts">
                  <dt>Format</dt>
                  <dd>
                    Agent Skills package — <span className="mono">SKILL.md</span>
                    {supporting.length > 0 ? ` and ${plural(supporting.length, "supporting file")}` : ""}.
                    Works without Habi.
                  </dd>
                  <dt>Applicability</dt>
                  <dd>
                    {skill.summary.hasApplicability ? (
                      "Rules declared — see the preview."
                    ) : (
                      <>
                        {NO_RULES_PHRASE}.{" "}
                        <button type="button" className="link-btn" onClick={() => setTab("applicability")}>
                          Add rules
                        </button>{" "}
                        so Habi can recommend it; without them it is for manual use.
                      </>
                    )}
                  </dd>
                  <dt>Origin</dt>
                  <dd>{originText(origin)}</dd>
                  <dt>Stored in</dt>
                  <dd>
                    <span className="mono">{skill.location}</span>{" "}
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() => safely(() => api.revealSkill(id), "The folder was not shown")}
                    >
                      Show
                    </button>
                  </dd>
                </dl>
              </fieldset>
            ) : null}

            {tab === "instructions" ? (
              broken ? (
                <p className="muted editor-pad">Repair SKILL.md under Files to edit the instructions here.</p>
              ) : (
                <div className="instructions">
                  <div className="instructions-bar">
                    <div className="segmented-control" role="radiogroup" aria-label="Editor mode">
                      <label className={writing ? "is-on" : undefined}>
                        <input type="radio" name="mode" checked={writing} onChange={() => setWriting(true)} />
                        Write
                      </label>
                      <label className={!writing ? "is-on" : undefined}>
                        <input
                          type="radio"
                          name="mode"
                          checked={!writing}
                          onChange={() => setWriting(false)}
                        />
                        Preview
                      </label>
                    </div>
                    {writing && document.body.trim() === "" && !trashed ? (
                      <span className="starters">
                        Start from
                        {STARTERS.map((s) => (
                          <button
                            key={s.label}
                            type="button"
                            className="link-btn"
                            onClick={() => setDocument({ ...document, body: s.body })}
                          >
                            {s.label}
                          </button>
                        ))}
                      </span>
                    ) : (
                      <span className="muted instructions-hint">
                        Markdown · ⌘B bold · ⌘I italic · ⌘E code
                      </span>
                    )}
                  </div>
                  <div className="instructions-body">
                    <div className="instructions-text">
                      {writing ? (
                        <SourceEditor
                          handle={bodyEditor}
                          label="Instructions (Markdown)"
                          value={document.body}
                          readOnly={trashed}
                          placeholder="Write what the agent should do, step by step. Be specific to your codebase: name the files, commands and checks that matter."
                          onChange={(body) => setDocument((d) => ({ ...d, body }))}
                        />
                      ) : document.body.trim() ? (
                        <div className="instructions-preview">
                          <Markdown text={document.body} />
                        </div>
                      ) : (
                        <p className="muted editor-pad">Nothing to preview yet.</p>
                      )}
                    </div>
                    <PackageRefs
                      files={supporting}
                      body={document.body}
                      canInsert={writing && !trashed}
                      onInsert={(text) => bodyEditor.current?.insert(text)}
                      onManage={() => setTab("files")}
                    />
                  </div>
                </div>
              )
            ) : null}

            {tab === "applicability" ? (
              <div className="applicability">
                <div className="applicability-bar">
                  <p className="muted">
                    Rules are optional, and stored next to the skill in{" "}
                    <span className="mono">habi.yaml</span> — other tools ignore it.
                  </p>
                  <div className="segmented-control" role="radiogroup" aria-label="How to edit the rules">
                    <label className={!yamlMode ? "is-on" : undefined}>
                      <input
                        type="radio"
                        name="rules"
                        checked={!yamlMode}
                        onChange={() => void switchYaml(false)}
                      />
                      Builder
                    </label>
                    <label className={yamlMode ? "is-on" : undefined}>
                      <input
                        type="radio"
                        name="rules"
                        checked={yamlMode}
                        onChange={() => void switchYaml(true)}
                      />
                      YAML
                    </label>
                  </div>
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
                    <p className="field-hint editor-pad">
                      Saved exactly as typed, including keys Habi does not know.
                      {skill.metadataStatus === "invalid"
                        ? " It is not valid yet, so it is ignored for matching until fixed."
                        : ""}
                    </p>
                  </>
                ) : form.conditionsEditable ? (
                  <fieldset className="builder-fieldset" disabled={trashed}>
                    <ConditionBuilder
                      form={form}
                      onChange={setForm}
                      projects={available}
                      defaultProjectId={originProject}
                    />
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
            ) : null}

            {tab === "files" ? (
              <FilesPane
                skill={skill}
                readOnly={trashed}
                beforeChange={async () => {
                  if (!(await flushAll())) throw new Error(NOT_SAVED);
                }}
                onSkill={(fresh, path) =>
                  adopt(fresh, {
                    document: path === "SKILL.md",
                    metadata: path === undefined || /^habi\.ya?ml$/.test(path),
                  })
                }
              />
            ) : null}
          </div>
        </div>

        {showsPreview ? (
          <ApplicabilityPreview
            request={previewRequest}
            requestKey={previewKey}
            hasProjects={available.length > 0}
            onOpenProject={() => void openProject({ stay: true })}
          />
        ) : null}
      </div>

      {dialog === "use" ? (
        <UseSkillDialog skill={skill} onClose={() => setDialog(null)} onFix={fixFromDialog} />
      ) : null}
      {dialog === "share" ? (
        <ShareSkillDialog skill={skill} onClose={() => setDialog(null)} onFix={fixFromDialog} />
      ) : null}
    </div>
  );
}
