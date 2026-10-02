/** What Habi installed here, local edits, and the operation history with restore. */
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { Installation } from "../../bindings/Installation";
import type { ProjectOverview } from "../../bindings/ProjectOverview";
import { useToast } from "../../components/Toasts";
import { Button, Empty, ErrorNotice, Notice, Section, Status, Working } from "../../components/ui";
import { api } from "../../lib/api";
import { clientsPhrase, installLabel, installTone, plural, relativeTime, shortId } from "../../lib/format";
import { invalidateProjectData, useHistory } from "../../lib/queries";
import { ReviewDialog, type ReviewRequest } from "../review/ReviewDialog";

function InstallationRow({ i, onReview }: { i: Installation; onReview: (r: ReviewRequest) => void }) {
  const edited = i.files.filter((f) => f.state !== "unchanged");
  return (
    <li className="installation">
      <div className="installation-head">
        <strong>{i.title}</strong>
        <Status tone={installTone[i.state]}>{installLabel[i.state]}</Status>
      </div>
      <p className="muted">
        {i.sourceName} · <span className="mono">{shortId(i.snapshot)}</span> · for {clientsPhrase(i.clients)}{" "}
        · installed {relativeTime(i.installedAt)}
      </p>
      {edited.length > 0 ? (
        <ul className="installation-files">
          {edited.map((f) => (
            <li key={f.path}>
              <span className="mono">{f.path}</span>{" "}
              <span className="muted">{f.state === "missing" ? "deleted locally" : "edited locally"}</span>
              {f.upstreamChanged ? <span className="muted"> · also changed in the library</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="installation-actions">
        {i.state === "updateAvailable" || i.state === "conflict" ? (
          <Button
            size="sm"
            variant="primary"
            onClick={() => onReview({ kind: "update", keys: [i.key], title: i.title })}
          >
            Review update…
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="quiet"
          onClick={() => onReview({ kind: "remove", keys: [i.key], title: i.title })}
        >
          Remove…
        </Button>
      </div>
    </li>
  );
}

export function InstalledView({ overview }: { overview: ProjectOverview }) {
  const projectId = overview.project.id;
  const history = useHistory(projectId);
  const [review, setReview] = useState<ReviewRequest | null>(null);
  const client = useQueryClient();
  const toast = useToast();
  const installed = [
    ...overview.recommendations.flatMap((r) => (r.installation ? [r.installation] : [])),
    ...overview.orphaned,
  ];
  const updatable = installed.filter((i) => i.state === "updateAvailable");

  const recover = async () => {
    try {
      const ops = await api.recover(projectId);
      invalidateProjectData(client, projectId);
      const attention = ops.filter((op) => op.state === "needsAttention").length;
      toast.show(
        ops.length === 0
          ? "No interrupted operations."
          : attention > 0
            ? `Found ${plural(ops.length, "interrupted operation")}; ${attention} need${attention === 1 ? "s" : ""} attention. See History.`
            : `Recovered ${plural(ops.length, "interrupted operation")}.`,
      );
    } catch (e) {
      toast.show(e instanceof Error ? e.message : String(e), "danger");
    }
  };

  return (
    <div className="page">
      <Section
        title="Installed by Habi"
        id="installed"
        aside={
          updatable.length > 1 ? (
            <Button
              size="sm"
              onClick={() =>
                setReview({
                  kind: "update",
                  keys: updatable.map((i) => i.key),
                  title: `${updatable.length} items`,
                })
              }
            >
              Review all updates…
            </Button>
          ) : null
        }
      >
        {installed.length === 0 ? (
          <Empty title="Nothing installed yet">
            Installed skills are ordinary files in this project. They keep working without Habi.
          </Empty>
        ) : (
          <ul className="installations">
            {installed.map((i) => (
              <InstallationRow key={i.key} i={i} onReview={setReview} />
            ))}
          </ul>
        )}
        {overview.orphaned.length > 0 ? (
          <Notice tone="warn" title="Some installed items come from a library that is not connected">
            Connect the library they came from to check for updates. They keep working as they are.
          </Notice>
        ) : null}
      </Section>

      <Section
        title="History"
        id="history"
        aside={
          <Button size="sm" variant="quiet" onClick={() => void recover()}>
            Check for interrupted operations
          </Button>
        }
      >
        {history.isPending ? <Working>Loading history…</Working> : null}
        {history.isError ? <ErrorNotice error={history.error} /> : null}
        {history.data && history.data.length === 0 ? <p className="muted">No operations yet.</p> : null}
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
      </Section>
      {review ? (
        <ReviewDialog projectId={projectId} request={review} onClose={() => setReview(null)} />
      ) : null}
    </div>
  );
}
