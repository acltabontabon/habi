/**
 * Every change Habi made to this project, with restore, and a check for
 * operations a crash interrupted. Installs from a library that is no longer
 * connected live here too: they are not in the recommendations to manage.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ProjectOverview } from "../../bindings/ProjectOverview";
import { Dialog } from "../../components/Dialog";
import { Icon } from "../../components/Icon";
import { Button, ErrorNotice, Status, Working } from "../../components/ui";
import { api } from "../../lib/api";
import { clientsPhrase, plural, relativeTime } from "../../lib/format";
import { invalidateProjectData, invalidateSkills, keys } from "../../lib/queries";
import { ReviewDialog, type ReviewRequest } from "../review/ReviewDialog";

export function History({ overview, onClose }: { overview: ProjectOverview | null; onClose: () => void }) {
  const projectId = overview?.project.id ?? null;
  const history = useQuery({
    queryKey: projectId ? keys.history(projectId) : keys.machineHistory,
    queryFn: () => (projectId ? api.history(projectId) : api.machineHistory()),
  });
  const [review, setReview] = useState<ReviewRequest | null>(null);
  const [checking, setChecking] = useState(false);
  // A toast would sit behind this dialog, out of reach: a failure shows here instead.
  const [failure, setFailure] = useState<unknown>(null);
  const client = useQueryClient();
  const [checked, setChecked] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "restorable" | "attention">("all");
  const operations = [...(history.data ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const restorable = operations.filter((op) => op.state === "committed");
  const attention = operations.filter((op) => op.state === "needsAttention" || op.state === "applying");
  const shown = filter === "restorable" ? restorable : filter === "attention" ? attention : operations;

  const recover = async () => {
    setChecking(true);
    setFailure(null);
    setChecked(null);
    try {
      const ops = await (projectId ? api.recover(projectId) : api.machineRecover());
      invalidateProjectData(client, projectId ?? undefined);
      if (!projectId) invalidateSkills(client);
      void history.refetch();
      const attention = ops.filter((op) => op.state === "needsAttention").length;
      setChecked(
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
      wide
      title={projectId ? "History" : "History on this machine"}
      description="Review installs, updates and removals. Restore previews the files that would change before you confirm."
      footer={
        <>
          <Button variant="quiet" busy={checking} onClick={() => void recover()}>
            Check for interrupted operations
          </Button>
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      {overview && overview.orphaned.length > 0 ? (
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
      {checked ? (
        <p className="history-checked" role="status">
          <Icon name="check" />
          {checked}
        </p>
      ) : null}
      {history.data && operations.length > 0 ? (
        <fieldset className="history-tools" aria-label="Filter history">
          <button type="button" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
            All changes <span>{operations.length}</span>
          </button>
          <button
            type="button"
            aria-pressed={filter === "restorable"}
            onClick={() => setFilter("restorable")}
          >
            Can restore <span>{restorable.length}</span>
          </button>
          <button type="button" aria-pressed={filter === "attention"} onClick={() => setFilter("attention")}>
            Needs attention <span>{attention.length}</span>
          </button>
        </fieldset>
      ) : null}
      {history.data && shown.length === 0 ? (
        <div className="history-empty">
          <Icon name="history" size={28} />
          <h3>{operations.length === 0 ? "No changes yet." : "No changes in this view."}</h3>
          <p>
            {operations.length === 0
              ? "Skills Habi installs, updates or removes will appear here. You can still check for interrupted operations below."
              : "Choose All changes to see the rest of your history."}
          </p>
        </div>
      ) : null}
      <ul className="history" aria-label="Changes made by Habi">
        {shown.map((op) => (
          <li key={op.id} className="history-row">
            <div className="history-main">
              <div className="history-title">
                <strong>{op.title}</strong>
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
              </div>
              <p className="history-meta">
                {/* An unreadable record knows neither its time nor its files. */}
                <span>
                  {(
                    {
                      install: "Installation",
                      update: "Update",
                      remove: "Removal",
                      restore: "Restore",
                      unreadable: "Unreadable record",
                    } as Record<string, string>
                  )[op.action] ?? "Change"}
                </span>
                <span>
                  {op.createdAt ? (
                    <time dateTime={op.createdAt} title={new Date(op.createdAt).toLocaleString()}>
                      {relativeTime(op.createdAt)}
                    </time>
                  ) : (
                    "Time unknown"
                  )}
                </span>
                {op.action === "unreadable" ? <span>files not known</span> : null}
              </p>
              {op.files.length > 0 ? (
                <details className="history-files">
                  <summary>{plural(op.files.length, "file")} changed</summary>
                  <ul>
                    {op.files.map((file) => (
                      <li key={file} className="mono">
                        {file}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
              {op.problems.map((p) => (
                <p key={p} className="history-problem">
                  {p}
                </p>
              ))}
            </div>
            {op.state === "committed" ? (
              <Button
                size="sm"
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
