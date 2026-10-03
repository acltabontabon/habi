/**
 * Share with team, as a continuation of writing the skill: choose the
 * library (or connect one right here), then review exactly what would leave
 * this machine. Without a library, the skill can be exported as a zip
 * instead. The draft stays in My skills whatever happens.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { LocalSkill } from "../../bindings/LocalSkill";
import { Dialog } from "../../components/Dialog";
import { Icon } from "../../components/Icon";
import { useToast } from "../../components/Toasts";
import { Button, ErrorNotice, Notice, Status } from "../../components/ui";
import { api } from "../../lib/api";
import { relativeTime } from "../../lib/format";
import { useNav } from "../../lib/nav";
import { keys, useContributions, useSources } from "../../lib/queries";
import { requestWord } from "../../lib/sharing";
import type { NavTarget } from "../../lib/studioNav";
import { StateChip } from "../contributions/StateChip";
import { ConnectLibrary } from "../sources/ConnectLibrary";
import { Unfinished } from "./Unfinished";

export function ShareSkillDialog({
  skill,
  onClose,
  onFix,
}: {
  skill: LocalSkill;
  onClose: () => void;
  /** Opens the editor where an unfinished part is fixed. */
  onFix?: (target: NavTarget) => void;
}) {
  const sources = useSources();
  const contributions = useContributions();
  const client = useQueryClient();
  const toast = useToast();
  const { navigate } = useNav();
  const [sourceId, setSourceId] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [exported, setExported] = useState<string | null>(null);

  const libraries = (sources.data ?? []).filter((s) => s.kind === "git" && s.snapshot);
  const folders = (sources.data ?? []).filter((s) => s.kind !== "git");
  const origin = skill.summary.origin;
  const home = origin.type === "library" ? libraries.find((s) => s.name === origin.sourceName) : undefined;
  const chosen = sourceId || home?.id || libraries[0]?.id || "";
  const errors = skill.diagnostics.filter((d) => d.level === "error");
  const earlier = (contributions.data ?? []).filter(
    (c) => c.origin.type === "localSkill" && c.origin.skillId === skill.summary.id,
  );
  // A contribution of this skill to the chosen library that is still going:
  // sharing again should continue it (and revise its open request), not open
  // a second one.
  const ongoing = earlier
    .filter(
      (c) =>
        c.sourceId === chosen &&
        c.state !== "discarded" &&
        !c.inLibrary &&
        c.review?.state !== "merged" &&
        c.review?.state !== "closed",
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];

  const openContribution = (id: string) => {
    onClose();
    navigate({ name: "contributions", contributionId: id });
  };

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const draft = await api.startContribution(chosen, { type: "localSkill", skillId: skill.summary.id });
      void client.invalidateQueries({ queryKey: keys.contributions });
      onClose();
      navigate({ name: "contributions", contributionId: draft.id });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const exportZip = async () => {
    setError(null);
    try {
      const path = await api.exportSkill(skill.summary.id);
      if (path) {
        setExported(path);
        toast.show(`Saved ${path}.`);
      }
    } catch (e) {
      setError(e);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Share “${skill.summary.title}” with your team`}
      description="Nothing is sent from here. The next step shows every file before anything leaves this machine."
      footer={
        errors.length > 0 || connecting ? undefined : (
          <>
            <Button variant="quiet" onClick={onClose}>
              Close
            </Button>
            {libraries.length > 0 && ongoing ? (
              <>
                <Button busy={busy} onClick={() => void start()}>
                  Start a new contribution
                </Button>
                <Button variant="primary" icon="share" onClick={() => openContribution(ongoing.id)}>
                  Continue sharing
                </Button>
              </>
            ) : libraries.length > 0 ? (
              <Button variant="primary" busy={busy} onClick={() => void start()}>
                Review what will be shared…
              </Button>
            ) : null}
          </>
        )
      }
    >
      {error ? <ErrorNotice error={error} /> : null}
      {errors.length > 0 ? (
        <Unfinished diagnostics={errors} action="shared" onFix={onFix} />
      ) : connecting ? (
        <ConnectLibrary
          compact
          onCancel={() => setConnecting(false)}
          onConnected={(source) => {
            setConnecting(false);
            setSourceId(source.id);
            toast.show(`${source.name} connected. Your draft is unchanged.`);
          }}
        />
      ) : (
        <>
          {libraries.length > 0 ? (
            <label className="field">
              <span className="field-label">Team library</span>
              <select className="input" value={chosen} onChange={(e) => setSourceId(e.target.value)}>
                {libraries.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} — {s.location}
                  </option>
                ))}
              </select>
              <span className="field-hint">
                Habi prepares a separate branch for review. It never pushes to the branch your team tracks and
                never merges.
              </span>
            </label>
          ) : (
            <div className="dialog-empty">
              <p>
                <strong>No Git library is connected yet.</strong> Your draft stays in My skills and keeps
                working locally either way.
              </p>
              {folders.length > 0 ? (
                <p className="muted">
                  {folders.map((f) => f.name).join(", ")} is a plain folder, which cannot receive
                  contributions for review.
                </p>
              ) : null}
            </div>
          )}

          <div className="share-options">
            <button type="button" className="share-option" onClick={() => setConnecting(true)}>
              <Icon name="library" />
              <span>
                <span className="choice-title">
                  {libraries.length > 0 ? "Connect another library…" : "Connect your team's library…"}
                </span>
                <span className="choice-detail">A Git repository of skills your team reviews together.</span>
              </span>
            </button>
            <button type="button" className="share-option" onClick={() => void exportZip()}>
              <Icon name="download" />
              <span>
                <span className="choice-title">Export as zip…</span>
                <span className="choice-detail">
                  A standard skill package to send, commit or unpack anywhere.
                </span>
              </span>
            </button>
          </div>
          {ongoing ? (
            <Notice tone="unknown" title={`Already being shared with ${ongoing.sourceName}`}>
              <p>
                <StateChip contribution={ongoing} />{" "}
                <span className="muted">updated {relativeTime(ongoing.updatedAt)}.</span>
              </p>
              <p className="muted">
                {ongoing.state === "published" || ongoing.pushedCommit !== null
                  ? `Continue sharing to send your latest edits as a revision of the same ${requestWord(ongoing)}. A new contribution would open a second one.`
                  : "Continue sharing to pick up where you left off. A new contribution would start over beside it."}
              </p>
            </Notice>
          ) : null}
          {exported ? (
            <p className="muted">
              <Status tone="ok">Saved</Status> <span className="mono">{exported}</span>. Exporting is not
              sharing: nobody has received it yet.
            </p>
          ) : null}

          {earlier.length > 0 ? (
            <div className="share-earlier">
              <p className="field-label">Shared before</p>
              <ul>
                {earlier.map((c) => (
                  <li key={c.id}>
                    <button type="button" className="link-btn" onClick={() => openContribution(c.id)}>
                      {c.sourceName}
                    </button>{" "}
                    <StateChip contribution={c} /> <span className="muted">{relativeTime(c.updatedAt)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
    </Dialog>
  );
}
