/**
 * For a skill copied from a library: whether the library item changed since
 * the copy was made, and a review that takes the library's changes without
 * touching your edits. Files changed on both sides need an explicit choice;
 * the final button names exactly what will happen.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { LocalSkill } from "../../bindings/LocalSkill";
import type { SideChange } from "../../bindings/SideChange";
import type { UpstreamChoice } from "../../bindings/UpstreamChoice";
import type { UpstreamFile } from "../../bindings/UpstreamFile";
import type { UpstreamPlan } from "../../bindings/UpstreamPlan";
import { Dialog } from "../../components/Dialog";
import { DiffStat, DiffView } from "../../components/DiffView";
import { Icon } from "../../components/Icon";
import { useToast } from "../../components/Toasts";
import { Button, ErrorNotice, Label, Notice, Working } from "../../components/ui";
import { api, HabiError } from "../../lib/api";
import { plural } from "../../lib/format";
import { invalidateSkills } from "../../lib/queries";
import { useOpenExternal } from "../../lib/safeInvoke";
import { provenanceText, upstreamUrl } from "../../lib/skills";

const changeLabel: Record<SideChange, string> = { added: "Added", modified: "Changed", removed: "Removed" };

export function UpstreamPanel({
  skill,
  beforeReview,
  onApplied,
}: {
  skill: LocalSkill;
  /** Saves pending edits, so the comparison sees what is on disk. False when they could not be saved. */
  beforeReview: () => Promise<boolean>;
  /** Reloads the editor from disk after files were replaced. */
  onApplied: () => Promise<void> | void;
}) {
  const origin = skill.summary.origin;
  const id = skill.summary.id;
  const fromLibrary = origin.type === "library" && skill.summary.deletedAt === null;
  const [reviewing, setReviewing] = useState(false);
  const status = useQuery({
    queryKey: ["skill-upstream", id, origin.type === "library" ? origin.snapshot : null],
    queryFn: () => api.skillUpstream(id),
    enabled: fromLibrary,
    staleTime: 0,
  });
  const s = status.data;
  const openExternal = useOpenExternal();
  // Where the copy came from stays in view, whether or not the original has moved.
  const provenance = fromLibrary ? provenanceText(origin) : null;
  const original = upstreamUrl(origin);
  const trail = provenance ? (
    <p className="provenance muted">
      <Icon name="branch" size={12} />
      <span>{provenance}</span>
      {original ? (
        <button type="button" className="link-quiet" onClick={() => openExternal(original)}>
          View the original
        </button>
      ) : null}
    </p>
  ) : null;
  if (!fromLibrary || !s || s.state === "unchanged") return trail;

  if (s.state !== "changed") {
    return (
      <>
        <Notice tone="unknown" title={s.detail ?? `${s.sourceName} cannot be checked for updates.`} />
        {trail}
      </>
    );
  }
  return (
    <>
      {trail}
      <Notice
        tone="unknown"
        title={`Updated in ${s.sourceName} since you copied it`}
        action={
          <Button size="sm" onClick={() => void beforeReview().then((saved) => saved && setReviewing(true))}>
            Review update…
          </Button>
        }
      />
      {reviewing ? (
        <UpstreamReview
          skillId={id}
          sourceName={s.sourceName}
          onClose={() => setReviewing(false)}
          onApplied={onApplied}
        />
      ) : null}
    </>
  );
}

function actionLabel(take: number, keep: number): string {
  const yours = keep === 1 ? "your edit" : `your ${keep} edits`;
  if (take === 0) return keep === 0 ? "Mark as up to date" : `Keep ${yours} and mark as up to date`;
  const taking = `Take ${plural(take, "library change")}`;
  return keep === 0 ? taking : `${taking}, keep ${yours}`;
}

function FileRow({ file }: { file: UpstreamFile }) {
  const [open, setOpen] = useState(false);
  const ours = file.status === "yours";
  const change = ours ? file.yourChange : file.libraryChange;
  const diff = ours ? file.yourDiff : file.libraryDiff;
  return (
    <li className="change">
      <button type="button" className="change-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name={open ? "chevronDown" : "chevronRight"} />
        <span className={`change-op op-${change ?? "unchanged"}`}>
          {change ? changeLabel[change] : "Mode"}
        </span>
        <span className="change-path mono">{file.path}</span>
        {ours ? (
          <Label tone="ok">Your edit — kept</Label>
        ) : (
          <Label tone="thread">Library change — taken</Label>
        )}
        {diff ? <DiffStat diff={diff} /> : null}
      </button>
      {file.note ? <p className="change-why">{file.note}</p> : null}
      {open && diff ? (
        <DiffView
          diff={diff}
          label={ours ? `Your changes to ${file.path}` : `Library changes to ${file.path}`}
        />
      ) : null}
    </li>
  );
}

export function UpstreamReview({
  skillId,
  sourceName,
  onClose,
  onApplied,
}: {
  skillId: string;
  sourceName: string;
  onClose: () => void;
  onApplied: () => Promise<void> | void;
}) {
  const client = useQueryClient();
  const toast = useToast();
  const [decisions, setDecisions] = useState<Record<string, UpstreamChoice>>({});
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<unknown>(null);
  const plan = useQuery<UpstreamPlan>({
    queryKey: ["skill-upstream-plan", skillId],
    queryFn: () => api.planUpstreamSync(skillId),
    staleTime: 0,
    gcTime: 0,
  });
  const p = plan.data;
  const conflicts = p?.files.filter((f) => f.status === "conflict") ?? [];
  const taken = p?.files.filter((f) => f.status === "library") ?? [];
  const kept = p?.files.filter((f) => f.status === "yours") ?? [];
  const undecided = conflicts.filter((f) => !decisions[f.path]).length;
  const take = taken.length + conflicts.filter((f) => decisions[f.path] === "takeLibrary").length;
  const keep = kept.length + conflicts.filter((f) => decisions[f.path] === "keepMine").length;
  const ready = p?.status.state === "changed" && !p.blocked && undecided === 0 && !plan.isFetching;

  const apply = async (current: UpstreamPlan) => {
    setApplying(true);
    setApplyError(null);
    try {
      await api.applyUpstreamSync(skillId, current.token, decisions);
      invalidateSkills(client);
      void client.invalidateQueries({ queryKey: ["skill-upstream", skillId] });
      await onApplied();
      toast.show(
        `Updated from ${sourceName}: ${plural(take, "library change")} taken${keep > 0 ? `, ${plural(keep, "edit")} of yours kept` : ""}.`,
      );
      onClose();
    } catch (e) {
      setApplyError(e);
      if (e instanceof HabiError && e.code === "conflict") {
        // Something changed since the review: show the new comparison.
        setDecisions({});
        void plan.refetch();
      }
    } finally {
      setApplying(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={`Update from ${sourceName}`}
      description="Nothing changes until you confirm below. Files you edited are never replaced without your choice."
      wide
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          {p && p.status.state === "changed" ? (
            <Button variant="primary" busy={applying} disabled={!ready} onClick={() => void apply(p)}>
              {actionLabel(take, keep)}
            </Button>
          ) : null}
        </>
      }
    >
      {plan.isPending ? <Working>Comparing your copy with {sourceName}…</Working> : null}
      {plan.isError ? <ErrorNotice error={plan.error} title="The update could not be compared" /> : null}
      {applyError ? <ErrorNotice error={applyError} title="The update was not applied" /> : null}
      {p && p.status.state !== "changed" ? (
        <Notice tone="unknown" title={p.status.detail ?? "There is nothing to take from the library now."} />
      ) : null}
      {p && p.status.state === "changed" ? (
        <div className="review">
          {p.blocked ? (
            <Notice tone="warn" title="This update cannot be applied yet">
              {p.blocked}
            </Notice>
          ) : null}

          {conflicts.length > 0 ? (
            <section className="review-conflicts" aria-labelledby="upstream-conflicts-title">
              <h3 id="upstream-conflicts-title" className="review-heading">
                {plural(conflicts.length, "decision")} needed
              </h3>
              {conflicts.map((f) => (
                <div key={f.path} className="conflict">
                  <p>
                    <span className="mono">{f.path}</span> — changed in {sourceName} and by you.
                    {f.note ? ` ${f.note}` : ""}
                  </p>
                  <div className="conflict-options" role="radiogroup" aria-label={`Decision for ${f.path}`}>
                    <label className="radio">
                      <input
                        type="radio"
                        name={`upstream-${f.path}`}
                        checked={decisions[f.path] === "keepMine"}
                        onChange={() => setDecisions((d) => ({ ...d, [f.path]: "keepMine" }))}
                      />
                      Keep mine
                    </label>
                    <label className="radio">
                      <input
                        type="radio"
                        name={`upstream-${f.path}`}
                        checked={decisions[f.path] === "takeLibrary"}
                        onChange={() => setDecisions((d) => ({ ...d, [f.path]: "takeLibrary" }))}
                      />
                      {f.libraryChange === "removed" ? "Remove it, as the library did" : "Take the library's"}
                    </label>
                  </div>
                  {f.libraryDiff ? (
                    <details>
                      <summary>What {sourceName} changed</summary>
                      <DiffView diff={f.libraryDiff} label={`Library changes to ${f.path}`} />
                    </details>
                  ) : null}
                  {f.yourDiff ? (
                    <details>
                      <summary>What you changed</summary>
                      <DiffView diff={f.yourDiff} label={`Your changes to ${f.path}`} />
                    </details>
                  ) : null}
                </div>
              ))}
            </section>
          ) : null}

          {taken.length > 0 ? (
            <section aria-labelledby="upstream-taken-title">
              <h3 id="upstream-taken-title" className="review-heading">
                {plural(taken.length, "library change")} to take
              </h3>
              <ul className="changes">
                {taken.map((f) => (
                  <FileRow key={f.path} file={f} />
                ))}
              </ul>
            </section>
          ) : null}

          {kept.length > 0 ? (
            <section aria-labelledby="upstream-kept-title">
              <h3 id="upstream-kept-title" className="review-heading">
                {kept.length === 1 ? "Your edit, kept" : `Your ${kept.length} edits, kept`}
              </h3>
              <ul className="changes">
                {kept.map((f) => (
                  <FileRow key={f.path} file={f} />
                ))}
              </ul>
            </section>
          ) : null}

          <p className="recovery">
            <Icon name="history" size={14} />
            {p.unchanged > 0 ? `${plural(p.unchanged, "other file")} unchanged. ` : ""}
            Replaced files are not kept elsewhere; export the skill first if you want a copy of this version.
            Later comparisons start from {sourceName}'s current version.
          </p>
        </div>
      ) : null}
    </Dialog>
  );
}
