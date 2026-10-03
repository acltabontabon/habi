/**
 * Every change Habi made to this project, with restore, and a check for
 * operations a crash interrupted. Installs from a library that is no longer
 * connected live here too: they are not in the recommendations to manage.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ProjectOverview } from "../../bindings/ProjectOverview";
import { Dialog } from "../../components/Dialog";
import { useToast } from "../../components/Toasts";
import { Button, ErrorNotice, Status, Working } from "../../components/ui";
import { api } from "../../lib/api";
import { clientsPhrase, plural, relativeTime } from "../../lib/format";
import { invalidateProjectData, useHistory } from "../../lib/queries";
import { ReviewDialog, type ReviewRequest } from "../review/ReviewDialog";

export function History({ overview, onClose }: { overview: ProjectOverview; onClose: () => void }) {
  const projectId = overview.project.id;
  const history = useHistory(projectId);
  const [review, setReview] = useState<ReviewRequest | null>(null);
  const [checking, setChecking] = useState(false);
  // A toast would sit behind this dialog, out of reach: a failure shows here instead.
  const [failure, setFailure] = useState<unknown>(null);
  const client = useQueryClient();
  const toast = useToast();

  const recover = async () => {
    setChecking(true);
    setFailure(null);
    try {
      const ops = await api.recover(projectId);
      invalidateProjectData(client, projectId);
      const attention = ops.filter((op) => op.state === "needsAttention").length;
      toast.show(
        ops.length === 0
          ? "No interrupted operations."
          : attention > 0
            ? `Found ${plural(ops.length, "interrupted operation")}; ${attention} need${attention === 1 ? "s" : ""} attention.`
            : `Recovered ${plural(ops.length, "interrupted operation")}.`,
      );
    } catch (e) {
      setFailure(e);
    } finally {
      setChecking(false);
    }
  };

  // A review opens over this dialog; closing it comes back here.
  if (review) return <ReviewDialog projectId={projectId} request={review} onClose={() => setReview(null)} />;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="History"
      description="Every change Habi made here. Installed skills are ordinary files; they keep working without Habi."
      footer={
        <>
          <Button variant="quiet" busy={checking} onClick={() => void recover()}>
            Check for interrupted operations
          </Button>
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      {overview.orphaned.length > 0 ? (
        <section className="scan-section" aria-labelledby="history-orphaned">
          <h3 id="history-orphaned" className="field-label">
            From a library that is not connected
          </h3>
          <ul className="scan-corrections">
            {overview.orphaned.map((i) => (
              <li key={i.key}>
                <span>
                  {i.title}
                  <span className="muted">
                    {" "}
                    · {i.sourceName} · for {clientsPhrase(i.clients)}
                  </span>
                </span>
                <Button
                  size="sm"
                  variant="quiet"
                  onClick={() => setReview({ kind: "remove", keys: [i.key], title: i.title })}
                >
                  Remove…
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {failure ? <ErrorNotice error={failure} title="The check did not finish" /> : null}
      {history.isPending ? <Working>Loading history…</Working> : null}
      {history.isError ? <ErrorNotice error={history.error} /> : null}
      {history.data && history.data.length === 0 ? <p className="muted">No changes yet.</p> : null}
      <ul className="history">
        {(history.data ?? []).map((op) => (
          <li key={op.id} className="history-row">
            <div>
              <strong>{op.title}</strong>{" "}
              <Status
                tone={op.state === "committed" ? "ok" : op.state === "needsAttention" ? "danger" : "muted"}
              >
                {op.state === "committed"
                  ? "applied"
                  : op.state === "rolledBack"
                    ? "rolled back"
                    : op.state === "needsAttention"
                      ? "needs attention"
                      : "in progress"}
              </Status>
              <p className="muted">
                {/* An unreadable record knows neither its time nor its files. */}
                {[
                  op.createdAt ? relativeTime(op.createdAt) : null,
                  op.action === "unreadable" ? "files not known" : plural(op.files.length, "file"),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
              {op.problems.map((p) => (
                <p key={p} className="history-problem">
                  {p}
                </p>
              ))}
            </div>
            {op.state === "committed" ? (
              <Button
                size="sm"
                variant="quiet"
                onClick={() => setReview({ kind: "restore", operationId: op.id, title: op.title })}
              >
                Restore…
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
