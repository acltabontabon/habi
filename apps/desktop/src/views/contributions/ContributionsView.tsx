/**
 * Sharing activity: what was prepared for the team and what actually
 * happened to it. A contribution is reviewed file by file before anything
 * leaves the machine; a prepared branch, a pushed branch and an opened
 * review request are reported as the three different things they are.
 * Nothing is merged by Habi.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { Contribution } from "../../bindings/Contribution";
import type { ShareForm } from "../../bindings/ShareForm";
import { BackLink } from "../../components/BackLink";
import { Dialog } from "../../components/Dialog";
import { DiffStat, DiffView } from "../../components/DiffView";
import { Icon } from "../../components/Icon";
import { SaveIndicator } from "../../components/SaveIndicator";
import { useToast } from "../../components/Toasts";
import { Button, Empty, ErrorNotice, Notice, Section, Status, Working } from "../../components/ui";
import { api, HabiError, newJobId } from "../../lib/api";
import { levelLabel, relativeTime, shortId } from "../../lib/format";
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
import { hostName, requestWord, sharingStatus } from "../../lib/skills";
import { tagLabel } from "../../lib/tags";
import { useAutosave } from "../../lib/useAutosave";
import { FileComments, ReviewPanel } from "./ReviewPanel";

/**
 * The three steps and how far this contribution really got. A branch that
 * was pushed without a review request is not shown as a finished review step.
 */
function steps(c: Contribution): { label: string; state: "done" | "current" | "todo" }[] {
  const prepared = c.state !== "draft";
  const pushed = c.state === "published";
  const requested = pushed && (c.publishedUrl !== null || c.review !== null || c.inLibrary);
  const reviewState = pushed ? c.review?.state : undefined;
  const sendLabel =
    reviewState === "merged"
      ? "Merged"
      : reviewState === "closed"
        ? "Closed without merging"
        : reviewState === "changesRequested"
          ? "Changes requested"
          : reviewState === "approved"
            ? "Approved"
            : requested
              ? c.inLibrary
                ? "In the library"
                : "Review requested"
              : pushed
                ? c.remote?.onThisMachine
                  ? "Branch in the library"
                  : "Branch pushed — request not opened"
                : c.revising
                  ? "Send the revision"
                  : "Send for review";
  return [
    {
      label: c.revising && !prepared ? "Review the revision" : "Review",
      state: prepared ? "done" : "current",
    },
    { label: prepared ? "Branch prepared" : "Prepare branch", state: prepared ? "done" : "todo" },
    {
      label: sendLabel,
      state:
        requested && reviewState !== "changesRequested" ? "done" : prepared || requested ? "current" : "todo",
    },
  ];
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
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishError, setPublishError] = useState<unknown>(null);
  const [openRequest, setOpenRequest] = useState(true);
  const [result, setResult] = useState<string | null>(null);
  const [remoteMoved, setRemoteMoved] = useState<string | null>(null);
  const [rehearsalNote, setRehearsalNote] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const f = form;
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
  const status = sharingStatus(c);
  const local = c.origin.type === "localSkill" ? c.origin.skillId : null;
  const sent = c.pushedCommit !== null || c.state === "published" || c.revising;
  const word = requestWord(c);
  const host = hostName(c);
  const openRequestUrl =
    c.review && c.review.state !== "merged" && c.review.state !== "closed"
      ? (c.review.url ?? c.publishedUrl)
      : c.review
        ? null
        : c.publishedUrl;
  const commentsFor = (path: string) =>
    (c.review?.comments ?? []).filter((x) => x.kind === "inline" && x.path === path);
  const tool = c.remote?.host === "gitlab" ? "glab" : c.remote?.host === "github" ? "gh" : null;
  const toolFound =
    tool === "gh" ? info.data?.ghAvailable : tool === "glab" ? info.data?.glabAvailable : undefined;

  const act = async (name: string, fn: () => Promise<unknown>) => {
    setBusy(name);
    setError(null);
    try {
      await fn();
      void client.invalidateQueries({ queryKey: keys.contribution(id) });
      void client.invalidateQueries({ queryKey: keys.contributions });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  const prepare = (buildOnRemote: boolean) =>
    act("commit", async () => {
      setRemoteMoved(null);
      // Write any edits still waiting to be saved before committing.
      if (!(await autosave.flush())) {
        throw new Error(
          "The branch was not prepared: your latest edits for the reviewer could not be saved. See the problem under “For the reviewer”, then try again.",
        );
      }
      try {
        await api.commitContribution(id, newJobId(), buildOnRemote);
      } catch (e) {
        if (e instanceof HabiError && e.code === "conflict") {
          setRemoteMoved(e.message);
          return;
        }
        throw e;
      }
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
        `Added from ${r.projects} project${r.projects === 1 ? "" : "s"}${
          r.samplesSkipped > 0 ? ` (${r.samplesSkipped} sample projects not counted)` : ""
        }. It is saved with the message; edit or remove it before preparing the branch.`,
      );
    });

  const check = () =>
    act("check", async () => {
      const updated = await api.refreshContributionReview(id, newJobId());
      client.setQueryData(keys.contribution(id), updated);
    });

  const revise = () =>
    act("revise", async () => {
      const updated = await api.reviseContribution(id, newJobId());
      adopt(updated);
      toast.show("Revision started. Make your changes, then prepare and send it.");
    });

  const cancelRevision = () =>
    act("cancelRevision", async () => {
      const updated = await api.cancelContributionRevision(id);
      adopt(updated);
      toast.show("Back to the version you sent. Nothing was pushed.");
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

  const publish = async () => {
    setBusy("publish");
    setPublishError(null);
    try {
      const out = await api.publishContribution(id, openRequest && !c.remote?.requestUnavailable, newJobId());
      setPublishOpen(false);
      setResult(
        out.updatedExisting
          ? `Pushed ${out.branch}. The open ${word} now shows this revision.`
          : out.pullRequestUrl
            ? `Pushed ${out.branch} and opened a ${word}: ${out.pullRequestUrl}`
            : `Pushed ${out.branch} to ${out.remote}. No review request was opened. ${out.pullRequestNote ?? ""}`,
      );
    } catch (e) {
      // Shown inside the dialog, where the person is looking.
      setPublishError(e);
    } finally {
      setBusy(null);
      void client.invalidateQueries({ queryKey: keys.contribution(id) });
      void client.invalidateQueries({ queryKey: keys.contributions });
    }
  };

  const discard = () =>
    act("discard", async () => {
      await api.discardContribution(id);
      navigate({ name: "contributions" });
    });

  const pushed = c.state === "published" || c.pushedCommit !== null;
  const discardText = `Habi forgets this contribution and deletes its prepared branch here.${
    openRequestUrl
      ? ` An open ${word} on ${host} stays open; close it there if you no longer want it.`
      : pushed
        ? ` The branch already pushed to ${c.remote?.onThisMachine ? "the library" : host} stays there.`
        : ""
  }${local ? " Your skill in My skills is kept." : ""}`;

  const set = (patch: Partial<ShareForm>) => setForm({ ...f, ...patch });

  return (
    <div className="page contribution">
      <header className="contribution-head">
        <BackLink fallback={{ name: "contributions" }} fallbackLabel="Sharing activity" />
        <p className="detail-kicker">
          To {c.sourceName} · <span className="mono">{c.itemPath}</span>
        </p>
        <h1 className="page-title">{c.title}</h1>
        <p className="contribution-status">
          <Status tone={status.tone}>{status.text}</Status>
          <span className="muted"> — {status.detail}</span>
        </p>
        <ol className="steps" aria-label="Progress">
          {steps(c).map((s, i) => (
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
        <details className="advanced">
          <summary>Branch and base</summary>
          <p className="advanced-body muted">
            Branch <span className="mono">{c.branch}</span>, based on{" "}
            <span className="mono">{shortId(c.baseCommit)}</span> of {c.sourceName}. Updated{" "}
            {relativeTime(c.updatedAt)}.
          </p>
        </details>
        {local ? (
          <p className="muted">
            A copy of your skill as it was when you started sharing.{" "}
            {sent
              ? "Edits you make there go out when you choose Revise and prepare again."
              : "Later edits there are not included; start again to share a newer version."}{" "}
            <button
              type="button"
              className="link-btn"
              onClick={() => navigate({ name: "skills", skillId: local })}
            >
              Open the skill
            </button>
          </p>
        ) : null}
      </header>
      {error ? <ErrorNotice error={error} /> : null}
      {result ? <Notice tone="ok">{result}</Notice> : null}
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
                Change the form below, or edit the files in <span className="mono">{c.stagingPath}</span>.{" "}
              </>
            ) : (
              <>
                Edit the skill {c.origin.type === "localSkill" ? "in My skills" : "in its project"}; preparing
                the revision copies it again.{" "}
              </>
            )}
            Changes go to the same branch, <span className="mono">{c.branch}</span>
            {openRequestUrl ? `, and the open ${word} on ${host} updates when you send them` : ""}. Files
            below are compared with the library, as reviewers see them.
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
        title={c.state === "published" ? "What was pushed" : "What would leave this machine"}
        id="files"
      >
        <p className="muted">
          {c.state === "published"
            ? "Exactly these files, on the contribution branch."
            : "Only these files, and only when you export a patch or send the branch for review. Nothing else is collected."}
        </p>
        <ul className="changes">
          {c.files.map((file) => (
            <li key={file.path} className={`change change-${file.status}`}>
              <details>
                <summary className="change-head">
                  <span className={`change-op op-${file.status}`}>{file.status}</span>
                  <span className="change-path mono">{file.path}</span>
                  {file.status !== "unchanged" ? <DiffStat diff={file.diff} /> : null}
                  {commentsFor(file.path).length > 0 ? (
                    <Status tone="warn">
                      {commentsFor(file.path).length} comment{commentsFor(file.path).length === 1 ? "" : "s"}
                    </Status>
                  ) : null}
                </summary>
                {file.status !== "unchanged" ? (
                  <DiffView diff={file.diff} label={`Changes to ${file.path}`} />
                ) : (
                  <p className="muted">Unchanged from the library.</p>
                )}
                <FileComments comments={commentsFor(file.path)} />
              </details>
            </li>
          ))}
        </ul>
        {changed.length === 0 ? <p className="muted">Nothing differs from the library yet.</p> : null}
      </Section>

      <Section title="Validation" id="validation">
        {c.validation.length === 0 ? (
          <Status tone="ok">No problems found</Status>
        ) : (
          <ul className="validation">
            {c.validation.map((d, i) => (
              <li key={i}>
                <Status tone={d.level === "error" ? "danger" : d.level === "warning" ? "warn" : "muted"}>
                  {levelLabel(d.level)}
                </Status>{" "}
                {d.path ? <span className="mono">{d.path}: </span> : null}
                {d.message}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="For the reviewer" id="describe">
        {!editable ? (
          <div className="reviewer-summary">
            <p>
              <strong>{c.title}</strong>
            </p>
            {c.message ? (
              <p className="review-comment-body">{c.message}</p>
            ) : (
              <p className="muted">No message.</p>
            )}
            <p className="muted">
              {c.state === "published"
                ? "Sent with the branch. To change it, choose Revise."
                : sent
                  ? "Prepared with this revision; it goes out when you send it."
                  : "Prepared with the branch. To change it, discard and start again."}
            </p>
          </div>
        ) : null}
        <fieldset disabled={!editable} hidden={!editable} className="form contribution-form">
          <label className="field">
            <span className="field-label">Contribution title</span>
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">Why this change (for the reviewer)</span>
            <textarea
              className="input"
              rows={Math.min(10, Math.max(3, message.split("\n").length + 1))}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
          </label>
          <div className="rehearsal">
            <Button size="sm" icon="layers" busy={busy === "rehearse"} onClick={() => void rehearse()}>
              Add where it applies…
            </Button>
            <span className="field-hint">
              Checks the rules against the projects you opened in Habi and adds a summary to the message —
              project names only, never paths. Edit or remove it before saving; it is sent with the branch.
            </span>
            {rehearsalNote ? <p className="muted">{rehearsalNote}</p> : null}
          </div>
          {local ? (
            <p className="muted">
              Title and applicability come from the skill itself. Change them in My skills, then share again.
            </p>
          ) : (
            <details className="advanced">
              <summary>Where it applies, prerequisites and examples</summary>
              <div className="advanced-body form">
                <div className="field-row">
                  <label className="field">
                    <span className="field-label">Display title</span>
                    <input
                      className="input"
                      value={f.title}
                      onChange={(e) => set({ title: e.target.value })}
                    />
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
                      suggestions={c.suggestedTags.filter((t) => !t.startsWith("agents:"))}
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
                    This skill's conditions are more detailed than this form can express. They are preserved
                    unchanged; edit
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
                    set({
                      tools:
                        v.length === 0 ? [] : [{ name: f.tools[0]?.name || "Required tool", commands: v }],
                    })
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
                          set({
                            examples: f.examples.map((x, j) =>
                              j === i ? { ...x, title: e.target.value } : x,
                            ),
                          })
                        }
                      />
                      <input
                        className="input"
                        value={ex.description}
                        aria-label="Example description"
                        onChange={(e) =>
                          set({
                            examples: f.examples.map((x, j) =>
                              j === i ? { ...x, description: e.target.value } : x,
                            ),
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
            </details>
          )}
          <div className="form-actions">
            <SaveIndicator state={autosave.state} />
            <span className="field-hint">
              Saved as you type. The files above show what reviewers will see.
            </span>
          </div>
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
      </Section>

      <Section title="Next" id="next">
        <div className="next-steps">
          {c.state === "draft" ? (
            <div>
              <p>
                Prepare a branch with exactly the files above, in Habi's own copy of the library. Nothing is
                sent yet, and your checkouts are not touched.
              </p>
              <Button
                variant="primary"
                icon="branch"
                busy={busy === "commit"}
                disabled={errors.length > 0 || changed.length === 0}
                onClick={() => void prepare(false)}
              >
                {c.revising ? "Prepare the revision" : "Prepare branch"}
              </Button>
              {errors.length > 0 ? <p className="muted">Fix the validation errors first.</p> : null}
              {remoteMoved ? (
                <Notice tone="warn" title="Someone else pushed to this branch">
                  <p>{remoteMoved}</p>
                  <p className="muted">
                    Building on their commits keeps them in the history; the skill folder then contains
                    exactly the files listed above, so their changes to those files are replaced by yours.
                    Nothing is sent until you choose Send.
                  </p>
                  <Button busy={busy === "commit"} onClick={() => void prepare(true)}>
                    Build on their commits
                  </Button>
                </Notice>
              ) : null}
            </div>
          ) : null}
          {c.commitId ? (
            <>
              <div>
                <p>
                  No write access, or prefer another route? Export a patch file to send any way your team
                  likes.
                </p>
                <Button
                  icon="download"
                  busy={busy === "export"}
                  onClick={() =>
                    void act("export", async () => {
                      const path = await api.exportContribution(id);
                      if (path) setResult(`Patch written to ${path}`);
                    })
                  }
                >
                  Export patch…
                </Button>
              </div>
              <div>
                <p>
                  {openRequestUrl && c.state !== "published"
                    ? `Push this revision to the same branch; the open ${word} on ${host} shows it.`
                    : "Push the branch to the library's remote and ask for a review. Nothing is merged; your Git host decides who may push."}
                </p>
                <Button
                  variant={c.state === "published" ? "secondary" : "primary"}
                  icon="share"
                  onClick={() => setPublishOpen(true)}
                  disabled={c.state === "published"}
                >
                  {c.state === "published"
                    ? "Branch pushed"
                    : openRequestUrl
                      ? "Send the revision…"
                      : "Send for review…"}
                </Button>
                {c.state === "published" && !c.publishedUrl && !c.review ? (
                  <p className="muted">{c.publishedNote ?? "No review request was opened."}</p>
                ) : null}
              </div>
            </>
          ) : null}
          <div>
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
              <Button variant="quiet" icon="trash" onClick={() => setConfirmDiscard(true)}>
                {local ? "Discard this contribution (keeps the skill)…" : "Discard…"}
              </Button>
            )}
          </div>
        </div>
      </Section>

      <Dialog
        open={publishOpen}
        onOpenChange={(open) => {
          setPublishOpen(open);
          if (!open) setPublishError(null);
        }}
        title="Send for review"
        description={
          c.remote?.onThisMachine
            ? "This writes the branch into the library repository on this machine."
            : "This sends files to your Git host."
        }
        footer={
          <>
            <Button variant="quiet" onClick={() => setPublishOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" busy={busy === "publish"} onClick={() => void publish()}>
              {openRequestUrl ? "Push the revision" : `Push branch ${c.branch}`}
            </Button>
          </>
        }
      >
        {publishError ? <ErrorNotice error={publishError} title="Nothing was pushed" /> : null}
        <dl className="meta-grid publish-target">
          <dt>Branch</dt>
          <dd className="mono">{c.branch}</dd>
          <dt>To</dt>
          <dd className="mono">{c.remote?.display ?? c.sourceName}</dd>
          {c.remote && !c.remote.onThisMachine ? (
            <>
              <dt>Host</dt>
              <dd>{c.remote.host ? hostName(c) : "Not recognized from the address"}</dd>
            </>
          ) : null}
        </dl>
        <p>
          Habi pushes with your Git credentials. It never pushes to the tracked branch, never overwrites
          commits on the branch, and never merges.
        </p>
        <ul className="publish-files">
          {changed.map((x) => (
            <li key={x.path} className="mono">
              {x.status} {x.path}
            </li>
          ))}
        </ul>
        {openRequestUrl ? (
          <p className="muted">
            The open {word} on {host} updates to show this revision; no new request is opened.
          </p>
        ) : c.remote?.requestUnavailable ? (
          <p className="muted">{c.remote.requestUnavailable}</p>
        ) : (
          <label className="check">
            <input type="checkbox" checked={openRequest} onChange={(e) => setOpenRequest(e.target.checked)} />
            <span>
              Also open a {word} on {host}{" "}
              <span className="muted">
                {tool
                  ? toolFound
                    ? `(with \`${tool}\`, signed in as you)`
                    : `(\`${tool}\` is not installed; Habi pushes the branch and tells you where to open the request)`
                  : "(Habi asks gh or glab which host this is; without either, it pushes the branch and tells you where to open the request)"}
              </span>
            </span>
          </label>
        )}
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
        Habi copies only the chosen skill into a private staging area. Nothing is sent anywhere yet.
      </p>
    </div>
  );
}

export function ContributionsView({ contributionId }: { contributionId?: string }) {
  const list = useContributions();
  const { navigate } = useNav();
  if (contributionId) return <Editor key={contributionId} id={contributionId} />;
  const items = list.data ?? [];
  return (
    <div className="page narrow">
      <h1 className="page-title">Sharing activity</h1>
      <p className="lead-sm">
        What you prepared for your team, and what actually happened to it. A contribution joins a library only
        when a maintainer merges it on your Git host.
      </p>
      {list.isPending ? <Working>Loading…</Working> : null}
      {list.data && items.length === 0 ? (
        <Empty
          title="Nothing shared yet"
          action={
            <Button variant="primary" icon="pencil" onClick={() => navigate({ name: "skills" })}>
              Go to My skills
            </Button>
          }
        >
          Open a skill and choose “Share with team” when it is ready. Until then it stays on this machine.
        </Empty>
      ) : (
        <ul className="source-list">
          {items.map((c) => {
            const status = sharingStatus(c);
            return (
              <li key={c.id}>
                <button
                  type="button"
                  className="recent-row share-row"
                  onClick={() => navigate({ name: "contributions", contributionId: c.id })}
                >
                  <span className="recent-name">{c.title}</span>
                  <span className="recent-path">
                    <Status tone={status.tone}>{status.text}</Status> · {c.sourceName}
                  </span>
                  <span className="recent-when muted">{relativeTime(c.updatedAt)}</span>
                </button>
              </li>
            );
          })}
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
