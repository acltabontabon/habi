/**
 * The checks a skill declares, and what earlier versions of Habi recorded for them. Habi lists
 * checks and does not run them: running one executes repository code with no sandbox.
 */
import type { ProjectOverview } from "../../bindings/ProjectOverview";
import type { Recommendation } from "../../bindings/Recommendation";
import { ErrorNotice, Status, Working } from "../../components/ui";
import { checkStatusLabel, checkStatusTone, relativeTime } from "../../lib/format";
import { useCheckRuns, useItemDetail } from "../../lib/queries";

export function ChecksPanel({
  overview,
  recommendation,
}: {
  overview: ProjectOverview;
  recommendation: Recommendation;
}) {
  const detail = useItemDetail(recommendation.item.sourceId, recommendation.item.id);
  const runs = useCheckRuns(overview.project.id, recommendation.item.key);
  if (detail.isPending) return <Working>Loading checks…</Working>;
  if (detail.isError) return <ErrorNotice error={detail.error} />;
  return (
    <div className="checks">
      <p className="muted">
        Checks are commands declared by the author. Habi lists them and does not run them. A passing check
        validates only its own success condition.
      </p>
      {detail.data.item.checks.map((c) => (
        <div key={c.id} className="check-card">
          <h4 className="check-title">{c.title}</h4>
          {c.description ? <p className="muted">{c.description}</p> : null}
        </div>
      ))}
      {runs.data && runs.data.length > 0 ? (
        <div className="check-history">
          <h4 className="explain-heading">Earlier runs</h4>
          <ul>
            {runs.data.map((run) => (
              <li key={run.id}>
                <Status tone={checkStatusTone[run.status]}>{checkStatusLabel[run.status]}</Status>{" "}
                <span className="mono">{run.argv.join(" ")}</span>{" "}
                <span className="muted">
                  in {run.cwd} · {relativeTime(run.startedAt)}
                  {run.itemDigest !== detail.data.item.contentDigest
                    ? " · on an earlier version of this item"
                    : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
