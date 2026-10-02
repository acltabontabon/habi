/**
 * Contributions: what was prepared for the team and what actually
 * happened to it. A contribution is reviewed file by file before anything
 * leaves the machine; a prepared branch, a pushed branch and an opened
 * review request are reported as the three different things they are.
 * Nothing is merged by Habi.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { Contribution } from "../../bindings/Contribution";
import type { DraftFile } from "../../bindings/DraftFile";
import type { DraftFileStatus } from "../../bindings/DraftFileStatus";
import type { ShareForm } from "../../bindings/ShareForm";
import { BackLink } from "../../components/BackLink";
import { Dialog } from "../../components/Dialog";
import { DiffStat, DiffView } from "../../components/DiffView";
import { Icon } from "../../components/Icon";
import { SaveIndicator } from "../../components/SaveIndicator";
import { useToast } from "../../components/Toasts";
import { Button, Empty, ErrorNotice, Notice, Section, Status, Working } from "../../components/ui";
import { api, newJobId } from "../../lib/api";
import { levelLabel, plural, relativeTime, shortId } from "../../lib/format";
import { useNav } from "../../lib/nav";
import {
  keys,
  useAppInfo,
  useContribution,
  useContributions,
  useLibrary,
  useRecentProjects,
  useSources,
} from "../../lib/queries";
import {
  type FinalAction,
  finalAction,
  hostName,
  nextAction,
  openRequestUrl,
  requestWord,
  sharingChip,
  targetBranch,
  visibilityText,
} from "../../lib/sharing";
import { tagLabel } from "../../lib/tags";
import { useAutosave } from "../../lib/useAutosave";
import { FileComments, ReviewPanel } from "./ReviewPanel";
import { StateChip } from "./StateChip";

/**
 * The three steps and how far this contribution really got. A branch that
 * was pushed without a review request is not shown as a finished review step.
 */
function steps(c: Contribution, send: FinalAction): { label: string; state: "done" | "current" | "todo" }[] {
  const prepared = c.state !== "draft";
  const pushed = c.state === "published";
  const requested = pushed && (c.publishedUrl !== null || c.review !== null || c.inLibrary);
  const chip = sharingChip(c);
  const sendLabel = requested
    ? chip.state === "attention"
      ? "Sent"
      : chip.label
    : pushed
      ? c.remote?.onThisMachine
        ? "Branch in the library"
        : "Branch pushed — no request"
      : send.label;
  return [
    {
      label: c.revising && !prepared ? "Review the revision" : "Review",
      state: prepared ? "done" : "current",
    },
    { label: prepared ? "Branch prepared" : "Prepare branch", state: prepared ? "done" : "todo" },
    {
      label: sendLabel,
      state: requested && c.review?.state !== "changesRequested" ? "done" : prepared ? "current" : "todo",
    },
  ];
}

const statusWord: Record<DraftFileStatus, string> = {
  added: "added",
  modified: "modified",
  renamed: "renamed",
  removed: "removed",
  unchanged: "unchanged",
};

/** What leaving a changed file out means for the library. */
const leftOut: Record<DraftFileStatus, string> = {
  added: "Left out: it is not added to the library.",
  modified: "Left out: the library keeps its version.",
  renamed: "Left out: the file stays at its old path.",
  removed: "Left out: the file stays in the library.",
  unchanged: "",
};

/**
 * Every file of the package beside the selected file's diff. Changed files
 * come first, each with a checkbox to leave it out; unchanged files are one
 * collapsed group.
 */
function FilesReview({
  c,
  editable,
  saving,
  onInclude,
}: {
  c: Contribution;
  editable: boolean;
  saving: boolean;
  onInclude: (path: string, included: boolean) => void;
}) {
  const changed = c.files.filter((f) => f.status !== "unchanged");
  const unchanged = c.files.filter((f) => f.status === "unchanged");
  const included = changed.filter((f) => f.included).length;
  const [selected, setSelected] = useState<string | null>(null);
  const current = c.files.find((f) => f.path === selected) ?? changed[0] ?? unchanged[0];
  const inFolder = (path: string) =>
    path.startsWith(`${c.itemPath}/`) ? path.slice(c.itemPath.length + 1) : path;
  const commentsFor = (path: string) =>
    (c.review?.comments ?? []).filter((x) => x.kind === "inline" && x.path === path);

  const row = (f: DraftFile) => {
    const name = inFolder(f.path);
    const comments = commentsFor(f.path).length;
    const isCurrent = current?.path === f.path;
    return (
      <li
        key={f.path}
        className={`rf-row${isCurrent ? " is-selected" : ""}${f.included ? "" : " is-excluded"}`}
      >
        {f.status !== "unchanged" ? (
          <input
            type="checkbox"
            className="rf-include"
            checked={f.included}
            disabled={!editable || f.required !== null || saving}
            title={f.required ?? (editable ? undefined : "Prepared. Choose Revise to change the files.")}
            aria-label={`Include ${name}`}
            onChange={(e) => onInclude(f.path, e.target.checked)}
          />
        ) : (
          <span className="rf-include" aria-hidden="true" />
        )}
        <button
          type="button"
          className="rf-pick"
          aria-current={isCurrent ? "true" : undefined}
          aria-label={`${name}, ${statusWord[f.status]}${f.included ? "" : ", left out"}${
            comments > 0 ? `, ${plural(comments, "review comment")}` : ""
          }`}
          onClick={() => setSelected(f.path)}
        >
          <span className={`change-op op-${f.status}`}>{statusWord[f.status]}</span>
          <span className="rf-name mono" title={f.path}>
            {name}
          </span>
          {f.status !== "unchanged" && f.status !== "renamed" ? <DiffStat diff={f.diff} /> : null}
          {comments > 0 ? (
            <span className="rf-comments" title={plural(comments, "review comment")}>
              <Icon name="info" size={12} />
              {comments}
            </span>
          ) : null}
        </button>
      </li>
    );
  };

  return (
    <div className="files-review">
      <div className="rf-list">
        <p className="kicker">
          {plural(changed.length, "changed file")} · {included} included
        </p>
        {changed.length > 0 ? (
          <ul className="rf-rows" aria-label="Changed files">
            {changed.map(row)}
          </ul>
        ) : (
          <p className="muted">Nothing differs from the library yet.</p>
        )}
        {unchanged.length > 0 ? (
          <details className="rf-group">
            <summary>{plural(unchanged.length, "unchanged file")}</summary>
            <ul className="rf-rows" aria-label="Unchanged files">
              {unchanged.map(row)}
            </ul>
          </details>
        ) : null}
      </div>
      <div className="rf-diff" aria-live="polite">
        {current ? (
          <>
            <div className="rf-diff-head">
              <span className="mono">{inFolder(current.path)}</span>
              {current.previousPath ? (
                <span className="muted">
                  from <span className="mono">{inFolder(current.previousPath)}</span>
                </span>
              ) : null}
              {!current.included ? <Status tone="muted">left out</Status> : null}
            </div>
            {!current.included ? <p className="muted">{leftOut[current.status]}</p> : null}
            {current.status === "renamed" ? (
              <p className="muted">Moved; the content is identical.</p>
            ) : current.status === "unchanged" ? (
              <p className="muted">Same as in the library.</p>
            ) : (
              <DiffView diff={current.diff} label={`Changes to ${current.path}`} />
            )}
            <FileComments comments={commentsFor(current.path)} />
          </>
        ) : (
          <p className="muted">No files.</p>
        )}
      </div>
    </div>
  );
}

/** Blocking errors apart from warnings, and what was actually checked. */
function Validation({ c }: { c: Contribution }) {
  const errors = c.validation.filter((d) => d.level === "error");
  const others = c.validation.filter((d) => d.level !== "error");
  const checked = "Checked: package format, Habi metadata, file references, secrets";
  return (
    <Section title="Validation" id="validation">
      {errors.length === 0 && others.length === 0 ? (
        <p>
          <Status tone="ok">{checked} — nothing to fix.</Status>{" "}
          <span className="muted">This does not test what the skill does.</span>
        </p>
      ) : (
        <>
          {errors.length > 0 ? (
            <div className="validation-group">
              <p className="kicker tone-danger">Blocking · {errors.length} — fix before preparing a branch</p>
              <ul className="validation">
                {errors.map((d, i) => (
                  <li key={i}>
                    <Status tone="danger">{levelLabel(d.level)}</Status> {d.message}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {others.length > 0 ? (
            <div className="validation-group">
              <p className="kicker">Warnings · {others.length} — do not block</p>
              <ul className="validation">
                {others.map((d, i) => (
                  <li key={i}>
                    <Status tone={d.level === "warning" ? "warn" : "muted"}>{levelLabel(d.level)}</Status>{" "}
                    {d.message}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <p className="muted">{checked}. This does not test what the skill does.</p>
        </>
      )}
    </Section>
  );
}

/** Where the contribution goes, stated only as far as Habi knows it. */
function Destination({ c }: { c: Contribution }) {
  return (
    <dl className="meta-grid destination">
      <dt>Library</dt>
      <dd>{c.sourceName}</dd>
      <dt>Repository</dt>
      <dd className="mono">{c.remote?.display ?? "unknown"}</dd>
      <dt>Host</dt>
      <dd>
        {c.remote?.onThisMachine
          ? "This machine (no Git host)"
          : c.remote?.host
            ? hostName(c)
            : "Not recognized from the address"}
      </dd>
      <dt>Target branch</dt>
      <dd className={c.review?.targetBranch || c.remote?.tracked.kind === "branch" ? "mono" : undefined}>
        {targetBranch(c)}
      </dd>
      <dt>Contribution branch</dt>
      <dd className="mono">{c.branch}</dd>
      <dt>Visibility</dt>
      <dd>{visibilityText(c)}</dd>
    </dl>
  );
}

function ListEditor({
  label,
  hint,
  values,
  onChange,
  suggestions = [],
  placeholder,
}: {
  label: string;
  hint?: string;
  values: string[];
  onChange: (v: string[]) => void;
  suggestions?: string[];
  placeholder?: string;
}) {
  const [draft, setDraft] = useState("");
  const add = (v: string) => {
    const t = v.trim();
    if (t && !values.includes(t)) onChange([...values, t]);
    setDraft("");
  };
  const offer = suggestions.filter((s) => !values.includes(s)).slice(0, 12);
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <div className="token-list">
        {values.map((v) => (
          <span key={v} className="token">
            <span className="mono">{v}</span>
            <button
              type="button"
              className="icon-btn"
              aria-label={`Remove ${v}`}
              onClick={() => onChange(values.filter((x) => x !== v))}
            >
              <Icon name="close" size={12} />
            </button>
          </span>
        ))}
        <input
          className="token-input mono"
          value={draft}
          aria-label={`Add to ${label}`}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add(draft);
            }
          }}
          onBlur={() => draft && add(draft)}
        />
      </div>
      {hint ? <span className="field-hint">{hint}</span> : null}
      {offer.length > 0 ? (
        <div className="suggestions">
          <span className="field-hint">Detected in the project (you decide):</span>
          {offer.map((s) => (
            <button key={s} type="button" className="chip" onClick={() => add(s)}>
              <Icon name="plus" size={12} />
              {tagLabel(s)}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Habi metadata for the library: where it applies, prerequisites, examples. */
function MetadataForm({
  form: f,
  set,
  suggestions,
}: {
  form: ShareForm;
  set: (patch: Partial<ShareForm>) => void;
  suggestions: string[];
}) {
  return (
    <div className="advanced-body form">
      <div className="field-row">
        <label className="field">
          <span className="field-label">Display title</span>
          <input className="input" value={f.title} onChange={(e) => set({ title: e.target.value })} />
        </label>
        <label className="field">
          <span className="field-label">Owner (attribution only)</span>
          <input
            className="input"
            value={f.owner}
            onChange={(e) => set({ owner: e.target.value })}
            placeholder="Team or person"
          />
        </label>
      </div>
      {f.conditionsEditable ? (
        <>
          <ListEditor
            label="Applies to projects that are…"
            values={f.appliesTags}
            onChange={(v) => set({ appliesTags: v })}
            suggestions={suggestions}
            placeholder="e.g. framework:spring-boot"
          />
          <ListEditor
            label="…or that depend on"
            values={f.appliesDependencies}
            onChange={(v) => set({ appliesDependencies: v })}
            placeholder="e.g. org.liquibase:liquibase-core"
          />
          <ListEditor
            label="…or contain files matching"
            values={f.appliesFiles}
            onChange={(v) => set({ appliesFiles: v })}
            placeholder="e.g. **/db/changelog/**"
          />
          <fieldset className="field">
            <legend className="field-label">Combine these as</legend>
            <label className="radio">
              <input
                type="radio"
                checked={f.matchMode === "all"}
                onChange={() => set({ matchMode: "all" })}
              />{" "}
              all must hold
            </label>
            <label className="radio">
              <input
                type="radio"
                checked={f.matchMode === "any"}
                onChange={() => set({ matchMode: "any" })}
              />{" "}
              any one is enough
            </label>
          </fieldset>
          <ListEditor
            label="Not for projects that are…"
            values={f.excludeTags}
            onChange={(v) => set({ excludeTags: v })}
            placeholder="e.g. db:jooq"
          />
          <ListEditor
            label="…or that depend on"
            values={f.excludeDependencies}
            onChange={(v) => set({ excludeDependencies: v })}
          />
        </>
      ) : (
        <Notice tone="unknown" title="Applicability is kept as written">
          This skill's conditions are more detailed than this form can express. They are preserved unchanged;
          edit
          <span className="mono"> habi.yaml</span> in the library to change them.
        </Notice>
      )}
      <label className="check">
        <input
          type="checkbox"
          checked={f.repositoryScope}
          onChange={(e) => set({ repositoryScope: e.target.checked })}
        />
        <span>Evaluate across the whole repository instead of per module</span>
      </label>
      <ListEditor
        label="Prerequisite commands (any one satisfies)"
        hint="Checked on PATH or in the project; never executed during matching."
        values={f.tools.flatMap((t) => t.commands)}
        onChange={(v) =>
          set({ tools: v.length === 0 ? [] : [{ name: f.tools[0]?.name || "Required tool", commands: v }] })
        }
        placeholder="e.g. mvn"
      />
      <div className="field">
        <span className="field-label">Examples</span>
        {f.examples.map((ex, i) => (
          <div key={i} className="field-row">
            <input
              className="input"
              value={ex.title}
              aria-label="Example title"
              onChange={(e) =>
                set({ examples: f.examples.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)) })
              }
            />
            <input
              className="input"
              value={ex.description}
              aria-label="Example description"
              onChange={(e) =>
                set({
                  examples: f.examples.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)),
                })
              }
            />
            <Button
              size="sm"
              variant="quiet"
              icon="trash"
              aria-label="Remove example"
              onClick={() => set({ examples: f.examples.filter((_, j) => j !== i) })}
            >
              Remove
            </Button>
          </div>
        ))}
        <Button
          size="sm"
          icon="plus"
          onClick={() => set({ examples: [...f.examples, { title: "", description: "" }] })}
        >
          Add example
        </Button>
      </div>
    </div>
  );
}

type ReviewerText = { title: string; message: string; form: ShareForm };
const reviewerKey = (v: ReviewerText) => JSON.stringify([v.title, v.message, v.form]);

function Editor({ id }: { id: string }) {
  const contribution = useContribution(id);
  if (contribution.isPending) return <Working>Loading the contribution…</Working>;
  if (contribution.isError || !contribution.data) return <ErrorNotice error={contribution.error} />;
  return <EditorBody id={id} c={contribution.data} />;
}

function EditorBody({ id, c }: { id: string; c: Contribution }) {
  const info = useAppInfo();
  const client = useQueryClient();
  const toast = useToast();
  const { navigate } = useNav();
  const [form, setForm] = useState<ShareForm>(c.form);
  const [title, setTitle] = useState(c.title);
  const [message, setMessage] = useState(c.message);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [sendOpen, setSendOpen] = useState(false);
  const [sendError, setSendError] = useState<unknown>(null);
  const [result, setResult] = useState<string | null>(null);
  const [rehearsalNote, setRehearsalNote] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const editable = c.state === "draft";
  // The reviewer form saves as you type, like the skill editor, so "Prepare
  // branch" can never commit an older title, message or form than shown.
  const autosave = useAutosave<ReviewerText>({
    value: { title, message, form },
    keyOf: reviewerKey,
    save: async (v) => {
      const updated = await api.updateContribution(id, v.title, v.message, v.form);
      client.setQueryData(keys.contribution(id), updated);
      void client.invalidateQueries({ queryKey: keys.contributions });
    },
    enabled: editable,
    delay: 900,
  });
  const errors = c.validation.filter((d) => d.level === "error");
  const changed = c.files.filter((x) => x.status !== "unchanged");
  const outgoing = changed.filter((x) => x.included);
  const local = c.origin.type === "localSkill" ? c.origin.skillId : null;
  const word = requestWord(c);
  const host = hostName(c);
  const requestUrl = openRequestUrl(c);
  const send = finalAction(c, info.data);
  const attention = c.attention;

  const refresh = () => {
    void client.invalidateQueries({ queryKey: keys.contribution(id) });
    void client.invalidateQueries({ queryKey: keys.contributions });
  };

  const act = async (name: string, fn: () => Promise<unknown>) => {
    setBusy(name);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const prepare = (buildOnRemote: boolean) =>
    act("commit", async () => {
      setResult(null);
      // Write any edits still waiting to be saved before committing.
      if (!(await autosave.flush())) {
        throw new Error(
          "The branch was not prepared: your latest edits for the reviewer could not be saved. See the problem under “Send”, then try again.",
        );
      }
      await api.commitContribution(id, newJobId(), buildOnRemote);
    });

  const include = (path: string, included: boolean) =>
    act("select", async () => {
      const excluded = changed
        .filter((f) => !f.included && f.path !== path)
        .map((f) => f.path)
        .concat(included ? [] : [path]);
      const updated = await api.selectContributionFiles(id, excluded);
      client.setQueryData(keys.contribution(id), updated);
    });

  const rehearse = () =>
    act("rehearse", async () => {
      const r = await api.contributionRehearsal(id, newJobId());
      if (!r.text) {
        setRehearsalNote(
          r.samplesSkipped > 0
            ? "Only sample projects are open, and they are not counted. Open your own projects to check against them."
            : "No projects are open in Habi yet, so there is nothing to check against.",
        );
        return;
      }
      const marker = r.text.split("\n")[0] ?? "";
      const without = message.includes(marker)
        ? message.slice(0, message.indexOf(marker)).trimEnd()
        : message.trimEnd();
      setMessage(without ? `${without}\n\n${r.text}` : r.text);
      setRehearsalNote(
        `Added from ${plural(r.projects, "project")}${
          r.samplesSkipped > 0 ? ` (${r.samplesSkipped} sample projects not counted)` : ""
        }. Edit or remove it before preparing the branch.`,
      );
    });

  const check = () =>
    act("check", async () => {
      const updated = await api.refreshContributionReview(id, newJobId());
      client.setQueryData(keys.contribution(id), updated);
    });

  /** Takes a contribution the core returned as the page's new state. */
  const adopt = (updated: Contribution) => {
    client.setQueryData(keys.contribution(id), updated);
    autosave.reset(reviewerKey(updated));
    setForm(updated.form);
    setTitle(updated.title);
    setMessage(updated.message);
    setResult(null);
  };

  const revise = () =>
    act("revise", async () => {
      adopt(await api.reviseContribution(id, newJobId()));
      toast.show("Revision started. Make your changes, then prepare and send it.");
    });

  const cancelRevision = () =>
    act("cancelRevision", async () => {
      adopt(await api.cancelContributionRevision(id));
      toast.show("Back to the version you sent. Nothing was pushed.");
    });

  const publish = async () => {
    setBusy("publish");
    setSendError(null);
    try {
      const out = await api.publishContribution(id, send.openRequest, newJobId());
      setSendOpen(false);
      setResult(
        out.updatedExisting
          ? `Pushed ${out.branch}. The open ${word} on ${host} shows this revision.`
          : out.pullRequestUrl
            ? `Pushed ${out.branch}. ${host} opened the ${word}: ${out.pullRequestUrl}`
            : `Pushed ${out.branch} to ${out.remote}. No ${word} was opened.${
                out.pullRequestNote ? ` ${out.pullRequestNote}` : ""
              }`,
      );
    } catch (e) {
      // Shown inside the dialog, where the person is looking.
      setSendError(e);
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const exportPatch = () =>
    act("export", async () => {
      const path = await api.exportContribution(id);
      if (path) setResult(`Patch written to ${path}. Sending it is up to you.`);
    });

  const discard = () =>
    act("discard", async () => {
      await api.discardContribution(id);
      navigate({ name: "contributions" });
    });

  const pushed = c.state === "published" || c.pushedCommit !== null;
  const discardText = `Habi forgets this contribution and deletes its prepared branch here.${
    requestUrl
      ? ` An open ${word} on ${host} stays open; close it there if you no longer want it.`
      : pushed
        ? ` The branch already pushed to ${c.remote?.onThisMachine ? "the library" : host} stays there.`
        : ""
  }${local ? " Your skill in My skills is kept." : ""}`;

  const set = (patch: Partial<ShareForm>) => setForm({ ...form, ...patch });
  const sent = c.pushedCommit !== null || c.state === "published" || c.revising;

  return (
    <div className="page contribution">
      <header className="contribution-head">
        <BackLink fallback={{ name: "contributions" }} fallbackLabel="Contributions" />
        <p className="kicker">
          Contribution · {c.sourceName} · <span className="mono">{c.itemPath}</span>
        </p>
        <h1 className="page-title">{c.title}</h1>
        <p className="contribution-status">
          <StateChip contribution={c} />
          <span className="muted">
            {c.revision > 0 ? `Revision ${c.revision} · ` : ""}updated {relativeTime(c.updatedAt)}
          </span>
        </p>
        <ol className="steps" aria-label="Progress">
          {steps(c, send).map((s, i) => (
            <li
              key={s.label}
              className={s.state === "done" ? "is-done" : s.state === "current" ? "is-current" : undefined}
              aria-current={s.state === "current" ? "step" : undefined}
            >
              <span className="step-knot" aria-hidden="true">
                {s.state === "done" ? <Icon name="check" size={12} /> : i + 1}
              </span>
              {s.label}
            </li>
          ))}
        </ol>
      </header>

      {error ? <ErrorNotice error={error} /> : null}
      {result ? <Notice tone="ok">{result}</Notice> : null}
      {attention?.kind === "remoteMoved" && editable ? (
        <Notice
          tone="warn"
          title="Someone else pushed to this branch"
          action={
            <Button busy={busy === "commit"} onClick={() => void prepare(true)}>
              Build on their commits
            </Button>
          }
        >
          <p>{attention.message}</p>
          <p className="muted">
            Their commits stay in the history; the skill folder then holds exactly the files included below.
            Nothing is sent until you choose {send.label}.
          </p>
        </Notice>
      ) : attention ? (
        <Notice
          tone="danger"
          title={attention.kind === "send" ? "Sending failed" : "Preparing the branch failed"}
        >
          <p>{attention.message}</p>
          <p className="muted">
            {relativeTime(attention.at)}.{" "}
            {attention.kind !== "send"
              ? "Retry with “Prepare branch” under Send: it reuses the same branch."
              : c.remote?.onThisMachine
                ? `Retry with “${send.label}” under Send: Habi writes the same branch and never overwrites commits.`
                : `Retry with “${send.label}” under Send: Habi pushes to the same branch and opens a ${word} only if ${host} does not already show one.`}
          </p>
        </Notice>
      ) : null}
      {c.revising ? (
        <Notice
          tone="unknown"
          title="Revising"
          action={
            <Button
              size="sm"
              variant="quiet"
              busy={busy === "cancelRevision"}
              onClick={() => void cancelRevision()}
            >
              Cancel revision
            </Button>
          }
        >
          <p>
            {c.origin.type === "libraryItem" ? (
              <>
                Edit the files in <span className="mono">{c.stagingPath}</span> or the metadata below.{" "}
              </>
            ) : (
              <>
                Edit the skill {c.origin.type === "localSkill" ? "in My skills" : "in its project"}; preparing
                copies it again.{" "}
              </>
            )}
            The new commit goes to <span className="mono">{c.branch}</span>
            {requestUrl ? `, and the open ${word} shows it once sent` : ""}.
          </p>
        </Notice>
      ) : null}

      {sent ? (
        <ReviewPanel
          contribution={c}
          busy={busy}
          onCheck={() => void check()}
          onRevise={() => void revise()}
        />
      ) : null}

      <Section
        title={c.state === "published" ? "What was pushed" : "Files"}
        id="files"
        aside={
          local ? (
            <button
              type="button"
              className="link-btn"
              onClick={() => navigate({ name: "skills", skillId: local })}
            >
              Open the skill
            </button>
          ) : null
        }
      >
        <p className="muted">
          {editable
            ? "Only included files leave this machine, and only when you send or export. Compared with the library."
            : "Compared with the library, as reviewers see them."}
        </p>
        <FilesReview
          c={c}
          editable={editable}
          saving={busy === "select"}
          onInclude={(p, v) => void include(p, v)}
        />
      </Section>

      <Validation c={c} />

      {editable ? (
        local ? null : (
          <details className="advanced contribution-metadata">
            <summary>Where it applies, prerequisites and examples</summary>
            <MetadataForm
              form={form}
              set={set}
              suggestions={c.suggestedTags.filter((t) => !t.startsWith("agents:"))}
            />
          </details>
        )
      ) : null}

      <Section title="Send" id="send">
        <div className="send-layout">
          <Destination c={c} />
          <div className="send-main">
            {editable ? (
              <fieldset className="form contribution-form">
                <label className="field">
                  <span className="field-label">Contribution title</span>
                  <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
                </label>
                <label className="field">
                  <span className="field-label">Why this change (for the reviewer)</span>
                  <textarea
                    className="input"
                    rows={Math.min(8, Math.max(3, message.split("\n").length + 1))}
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                  />
                </label>
                <div className="form-actions">
                  <SaveIndicator state={autosave.state} />
                  <Button
                    size="sm"
                    variant="quiet"
                    icon="layers"
                    busy={busy === "rehearse"}
                    onClick={() => void rehearse()}
                  >
                    Add where it applies…
                  </Button>
                </div>
                {rehearsalNote ? <p className="field-hint">{rehearsalNote}</p> : null}
                {local ? (
                  <p className="field-hint">
                    Applicability comes from the skill itself; change it in My skills.
                  </p>
                ) : null}
                {autosave.state === "error" || autosave.state === "conflict" ? (
                  <ErrorNotice
                    error={autosave.error}
                    title="Your latest edits are not saved"
                    action={
                      <Button size="sm" onClick={autosave.retry}>
                        Try again
                      </Button>
                    }
                  />
                ) : null}
              </fieldset>
            ) : (
              <div className="reviewer-summary">
                <p>
                  <strong>{c.title}</strong>
                </p>
                {c.message ? (
                  <p className="review-comment-body">{c.message}</p>
                ) : (
                  <p className="muted">No message.</p>
                )}
              </div>
            )}

            <div className="send-actions">
              {editable ? (
                <>
                  <Button
                    variant="primary"
                    icon="branch"
                    busy={busy === "commit"}
                    disabled={errors.length > 0 || outgoing.length === 0}
                    onClick={() => void prepare(false)}
                  >
                    {c.revising ? "Prepare the revision" : "Prepare branch"}
                  </Button>
                  <span className="field-hint">
                    {errors.length > 0
                      ? "Fix the blocking problems first."
                      : `Commits ${plural(outgoing.length, "file")} to ${c.branch} in Habi's copy of the library. Nothing is sent; next: ${send.label}.`}
                  </span>
                </>
              ) : c.state !== "published" ? (
                <>
                  <Button variant="primary" icon="share" onClick={() => setSendOpen(true)}>
                    {`${send.label}…`}
                  </Button>
                  <Button icon="download" busy={busy === "export"} onClick={() => void exportPatch()}>
                    Export patch…
                  </Button>
                  {send.note ? <span className="field-hint">{send.note}</span> : null}
                </>
              ) : (
                <>
                  <Button icon="download" busy={busy === "export"} onClick={() => void exportPatch()}>
                    Export patch…
                  </Button>
                  {!c.publishedUrl && !c.review ? (
                    <span className="field-hint">{c.publishedNote ?? `No ${word} was opened.`}</span>
                  ) : null}
                </>
              )}
            </div>
            <p className="muted send-base">
              Based on <span className="mono">{shortId(c.baseCommit)}</span> of {c.sourceName}. Habi never
              pushes to the target branch, never overwrites commits and never merges.
            </p>
          </div>
        </div>
        <div className="discard">
          {confirmDiscard ? (
            <Notice
              tone="warn"
              title="Discard this contribution?"
              action={
                <>
                  <Button variant="quiet" size="sm" onClick={() => setConfirmDiscard(false)}>
                    Keep it
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    icon="trash"
                    busy={busy === "discard"}
                    onClick={() => void discard()}
                  >
                    Discard
                  </Button>
                </>
              }
            >
              <p>{discardText}</p>
            </Notice>
          ) : (
            <Button variant="quiet" size="sm" icon="trash" onClick={() => setConfirmDiscard(true)}>
              {local ? "Discard this contribution (keeps the skill)…" : "Discard this contribution…"}
            </Button>
          )}
        </div>
      </Section>

      <Dialog
        open={sendOpen}
        onOpenChange={(open) => {
          setSendOpen(open);
          if (!open) setSendError(null);
        }}
        title={send.label}
        description={
          c.remote?.onThisMachine
            ? "This writes the branch into the library repository on this machine."
            : `This sends the files below to ${host} with your Git credentials.`
        }
        footer={
          <>
            <Button variant="quiet" onClick={() => setSendOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" busy={busy === "publish"} onClick={() => void publish()}>
              {send.label}
            </Button>
          </>
        }
      >
        {sendError ? <ErrorNotice error={sendError} title="Nothing was pushed" /> : null}
        <Destination c={c} />
        <ul className="publish-files">
          {outgoing.map((x) => (
            <li key={x.path} className="mono">
              {x.status} {x.path}
            </li>
          ))}
        </ul>
        {send.note ? <p className="muted">{send.note}</p> : null}
      </Dialog>
    </div>
  );
}

function StartContribution() {
  const sources = useSources();
  const recent = useRecentProjects();
  const { navigate } = useNav();
  const client = useQueryClient();
  const gitSources = (sources.data ?? []).filter((s) => s.kind === "git" && s.snapshot);
  const [sourceId, setSourceId] = useState("");
  const [mode, setMode] = useState<"project" | "library">("project");
  const [projectId, setProjectId] = useState("");
  const [folder, setFolder] = useState("");
  const [itemId, setItemId] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const effectiveSource = sourceId || gitSources[0]?.id || "";
  const library = useLibrary(effectiveSource || undefined);
  const projects = (recent.data ?? []).filter((p) => p.exists);
  const effectiveProject = projectId || projects[0]?.id || "";

  const folders = useQuery({
    queryKey: ["skillFolders", effectiveProject],
    enabled: mode === "project" && Boolean(effectiveProject),
    queryFn: async () => {
      const overview = await api.projectOverview(effectiveProject, false);
      return [
        ...new Set(
          overview.inspection.facts
            .filter((f) => f.subject.type === "file" && f.subject.role.startsWith("agent-skill:"))
            .map((f) => (f.subject.type === "file" ? f.subject.path.replace(/\/SKILL\.md$/, "") : "")),
        ),
      ];
    },
  });

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const origin =
        mode === "project"
          ? ({
              type: "projectSkill",
              projectId: effectiveProject,
              path: folder || folders.data?.[0] || "",
            } as const)
          : ({ type: "libraryItem", itemId } as const);
      const draft = await api.startContribution(effectiveSource, origin);
      void client.invalidateQueries({ queryKey: keys.contributions });
      navigate({ name: "contributions", contributionId: draft.id });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  if (gitSources.length === 0) {
    return (
      <p className="muted">
        Sharing an installed copy or a library item needs a connected Git library. Skills in My skills can
        also be exported as plain folders.
      </p>
    );
  }
  return (
    <div className="start-contribution">
      {error ? <ErrorNotice error={error} /> : null}
      <div className="field-row">
        <label className="field">
          <span className="field-label">Library</span>
          <select
            className="input"
            value={effectiveSource}
            onChange={(e) => {
              setSourceId(e.target.value);
              setItemId("");
            }}
          >
            {gitSources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="field">
          <legend className="field-label">Start from</legend>
          <label className="radio">
            <input type="radio" checked={mode === "project"} onChange={() => setMode("project")} /> a skill in
            one of my projects
          </label>
          <label className="radio">
            <input type="radio" checked={mode === "library"} onChange={() => setMode("library")} /> an
            existing library item (improve its metadata)
          </label>
        </fieldset>
      </div>
      {mode === "project" ? (
        <div className="field-row">
          <label className="field">
            <span className="field-label">Project</span>
            <select
              className="input"
              value={effectiveProject}
              onChange={(e) => {
                setProjectId(e.target.value);
                setFolder("");
              }}
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Skill folder</span>
            <select
              className="input mono"
              value={folder || folders.data?.[0] || ""}
              onChange={(e) => setFolder(e.target.value)}
            >
              {(folders.data ?? []).length === 0 ? <option value="">No skill folders found</option> : null}
              {(folders.data ?? []).map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : (
        <label className="field">
          <span className="field-label">Item</span>
          <select className="input" value={itemId} onChange={(e) => setItemId(e.target.value)}>
            <option value="">Choose…</option>
            {(library.data?.items ?? [])
              .filter((i) => i.kind !== "instructions")
              .map((i) => (
                <option key={i.id} value={i.id}>
                  {i.title}
                </option>
              ))}
          </select>
        </label>
      )}
      <Button
        variant="primary"
        icon="share"
        busy={busy}
        disabled={mode === "project" ? !(folder || folders.data?.[0]) : !itemId}
        onClick={() => void start()}
      >
        Prepare contribution
      </Button>
      <p className="muted">
        Habi copies only the chosen skill into a private staging area. Nothing is sent yet.
      </p>
    </div>
  );
}

/** One contribution: its state, where it goes, and the one thing to do next. */
function ShareRow({ c }: { c: Contribution }) {
  const { navigate } = useNav();
  const action = nextAction(c);
  const details = () => navigate({ name: "contributions", contributionId: c.id });
  const attention = sharingChip(c).state === "attention";
  return (
    <li className="share-row">
      <div className="share-row-main">
        {action.kind === "open" ? (
          <button type="button" className="link-btn share-row-title" onClick={details}>
            {c.title}
          </button>
        ) : (
          <span className="share-row-title">{c.title}</span>
        )}
        <span className="share-row-dest mono">
          {c.sourceName} · {c.branch}
        </span>
      </div>
      <StateChip contribution={c} />
      <span className="share-row-when">{relativeTime(c.updatedAt)}</span>
      <Button
        size="sm"
        variant={attention ? "primary" : "secondary"}
        icon={action.kind === "open" ? "external" : undefined}
        aria-label={`${action.label}: ${c.title}`}
        onClick={() => (action.kind === "open" ? void api.openExternal(action.url) : details())}
      >
        {action.label}
      </Button>
    </li>
  );
}

export function ContributionsView({ contributionId }: { contributionId?: string }) {
  const list = useContributions();
  const { navigate } = useNav();
  if (contributionId) return <Editor key={contributionId} id={contributionId} />;
  const items = list.data ?? [];
  return (
    <div className="page narrow sharing">
      <h1 className="page-title">Contributions</h1>
      <p className="lead-sm">
        What you prepared for your team and what the Git host reported. Nothing joins a library until a
        maintainer merges it.
      </p>
      {list.isPending ? <Working>Loading…</Working> : null}
      {list.isError ? <ErrorNotice error={list.error} /> : null}
      {list.data && items.length === 0 ? (
        <Empty
          title="Nothing shared yet"
          action={
            <Button variant="primary" icon="pencil" onClick={() => navigate({ name: "skills" })}>
              Go to My skills
            </Button>
          }
        >
          Improve a skill, then choose “Share” to send it to a library for review. Until then it stays on this
          machine.
        </Empty>
      ) : (
        <ul className="share-list" aria-label="Contributions">
          {items.map((c) => (
            <ShareRow key={c.id} c={c} />
          ))}
        </ul>
      )}
      <details className="advanced share-other">
        <summary>Share an installed copy you edited, or improve a library item</summary>
        <div className="advanced-body">
          <StartContribution />
        </div>
      </details>
    </div>
  );
}
