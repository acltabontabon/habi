/**
 * Verification checks: preview first (exact program, arguments, folder,
 * environment), then an explicit run with timeout and cancel.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { CheckPreview } from "../../bindings/CheckPreview";
import type { CheckRun } from "../../bindings/CheckRun";
import type { CheckSpec } from "../../bindings/CheckSpec";
import type { ProjectOverview } from "../../bindings/ProjectOverview";
import type { Recommendation } from "../../bindings/Recommendation";
import { Button, ErrorNotice, Notice, Status, Working } from "../../components/ui";
import { api, newJobId } from "../../lib/api";
import { checkStatusLabel, checkStatusTone, relativeTime } from "../../lib/format";
import { invalidateProjectData, useCheckRuns, useItemDetail } from "../../lib/queries";

function RunResult({ run }: { run: CheckRun }) {
  return (
    <div className="check-result" role="status">
      <p>
        <Status tone={checkStatusTone[run.status]}>{checkStatusLabel[run.status]}</Status>{" "}
        <span className="muted">
          exit {run.exitCode ?? "none"} · {relativeTime(run.finishedAt)} · in {run.cwd}
        </span>
      </p>
      <p className="muted">
        This records the outcome of <span className="mono">{run.argv.join(" ")}</span> in this module. A
        passing result validates only this command's success condition.
      </p>
      {run.outputTail ? <pre className="code output">{run.outputTail}</pre> : null}
    </div>
  );
}

function CheckCard({
  check,
  overview,
  recommendation,
}: {
  check: CheckSpec;
  overview: ProjectOverview;
  recommendation: Recommendation;
}) {
  const client = useQueryClient();
  const applying = recommendation.applicability.modules
    .filter((m) => m.applicability === "applies" && m.module !== "*")
    .map((m) => m.module);
  const modules = applying.length > 0 ? applying : overview.inspection.modules.map((m) => m.id);
  const [module, setModule] = useState(modules[0] ?? ".");
  const [bindings, setBindings] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<CheckPreview | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [job, setJob] = useState<string | null>(null);
  const [result, setResult] = useState<CheckRun | null>(null);
  /** Only the latest preview asked for is shown; an earlier one that answers late is dropped. */
  const asked = useRef(0);
  /** The running command, stopped if this card goes away (another tab) rather than left running unseen. */
  const running = useRef<string | null>(null);
  useEffect(
    () => () => {
      asked.current++;
      const job = running.current;
      running.current = null;
      if (job) void api.cancelJob(job).catch(() => undefined);
    },
    [],
  );

  const prepare = async (nextBindings = bindings, nextModule = module, keepResult = false) => {
    const mine = ++asked.current;
    setError(null);
    if (!keepResult) setResult(null);
    try {
      const next = await api.prepareCheck(
        overview.project.id,
        recommendation.item.key,
        check.id,
        nextModule,
        nextBindings,
      );
      if (mine === asked.current) setPreview(next);
    } catch (e) {
      if (mine !== asked.current) return;
      setPreview(null);
      setError(e);
    }
  };

  const run = async () => {
    if (running.current) return;
    const id = newJobId();
    running.current = id;
    setJob(id);
    setError(null);
    try {
      const r = await api.runCheck(overview.project.id, preview?.previewId ?? "", id);
      setResult(r);
      invalidateProjectData(client, overview.project.id);
      void client.invalidateQueries({ queryKey: ["checkRuns"] });
      // A preview id is single-use; prepare a fresh one for another run, but
      // keep showing the result of the run that just finished.
      if (running.current === id) void prepare(bindings, module, true);
    } catch (e) {
      setError(e);
    } finally {
      if (running.current === id) running.current = null;
      setJob(null);
    }
  };

  return (
    <div className="check-card">
      <h4 className="check-title">{check.title}</h4>
      {check.description ? <p className="muted">{check.description}</p> : null}
      <div className="field-row">
        <label className="field">
          <span className="field-label">Module</span>
          <select
            className="input"
            value={module}
            onChange={(e) => {
              asked.current++;
              setModule(e.target.value);
              setPreview(null);
            }}
          >
            {modules.map((m) => (
              <option key={m} value={m}>
                {overview.inspection.modules.find((x) => x.id === m)?.name ?? m} ({m})
              </option>
            ))}
          </select>
        </label>
        {preview?.bindings.map((b) => (
          <label key={b.name} className="field">
            <span className="field-label">{b.description ?? b.name}</span>
            <select
              className="input"
              value={b.selected ?? ""}
              onChange={(e) => {
                const next = { ...bindings, [b.name]: e.target.value };
                setBindings(next);
                void prepare(next);
              }}
            >
              <option value="" disabled>
                {b.candidates.length === 0 ? "No candidates found" : "Choose…"}
              </option>
              {b.candidates.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      {!preview ? (
        <Button size="sm" icon="eye" onClick={() => void prepare()}>
          Preview the command
        </Button>
      ) : (
        <div className="check-preview">
          <dl className="meta-grid">
            <dt>Program</dt>
            <dd className="mono">
              {preview.program}{" "}
              {preview.resolvedProgram ? (
                <span className="muted">→ {preview.resolvedProgram}</span>
              ) : (
                <Status tone="warn">not found</Status>
              )}
            </dd>
            <dt>Arguments</dt>
            <dd className="mono">{preview.args.join(" ") || "none"}</dd>
            <dt>Folder</dt>
            <dd className="mono">{preview.cwd}</dd>
            <dt>Environment</dt>
            <dd>{preview.environment}</dd>
            <dt>Time limit</dt>
            <dd>{preview.timeoutSeconds} s</dd>
          </dl>
          {preview.warnings.map((w) => (
            <Notice key={w} tone="warn">
              {w}
            </Notice>
          ))}
          {job ? (
            <Working onCancel={() => void api.cancelJob(job)}>Running {preview.program}…</Working>
          ) : (
            <Button
              variant="primary"
              size="sm"
              icon="play"
              disabled={!preview.ready}
              onClick={() => void run()}
            >
              Run this command
            </Button>
          )}
          {!preview.ready ? (
            <p className="muted">Choose every value and make sure the program is installed.</p>
          ) : null}
        </div>
      )}
      {error ? <ErrorNotice error={error} /> : null}
      {result ? <RunResult run={result} /> : null}
    </div>
  );
}

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
        Checks are commands declared by the author. Habi never runs them on its own. A passing check validates
        only its own success condition.
      </p>
      {detail.data.item.checks.map((c) => (
        <CheckCard key={c.id} check={c} overview={overview} recommendation={recommendation} />
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
