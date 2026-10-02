/** A workflow as a readable sequence: guidance, not enforced transitions. */
import { useState } from "react";
import type { Recommendation } from "../../bindings/Recommendation";
import { Icon } from "../../components/Icon";
import { Button, ErrorNotice, Notice, Working } from "../../components/ui";
import { useItemDetail } from "../../lib/queries";
import { FileViewer } from "./ContentPanel";

export function WorkflowPanel({
  recommendation: r,
  onRunCheck,
  onInstall,
}: {
  recommendation: Recommendation;
  onRunCheck: () => void;
  /** Opens the install review; absent when the item is already installed. */
  onInstall?: () => void;
}) {
  const detail = useItemDetail(r.item.sourceId, r.item.id);
  const [reference, setReference] = useState<string | null>(null);
  if (detail.isPending) return <Working>Loading the workflow…</Working>;
  if (detail.isError) return <ErrorNotice error={detail.error} />;
  const wf = detail.data.item.workflow;
  if (!wf) return <p className="muted">This item does not describe a procedure.</p>;
  const missing = r.readiness.prerequisites.filter(
    (p) => p.status === "missing" || p.status === "notConfigured",
  );

  return (
    <div className="workflow">
      <p className="muted">
        A procedure your agent and you can follow. Habi presents the steps in order; it does not enforce them.
      </p>
      {missing.length > 0 ? (
        <Notice tone="warn" title="Before you start">
          {missing.map((p) => (
            <p key={p.name}>
              {p.kind === "mcp" ? "MCP server " : ""}
              <strong>{p.name}</strong>: {p.detail}
            </p>
          ))}
        </Notice>
      ) : null}
      <ol className="steps">
        {wf.steps.map((step, i) => (
          <li key={i} className="step">
            <span className="step-num" aria-hidden="true">
              {i + 1}
            </span>
            <div className="step-body">
              <h4 className="step-title">{step.title}</h4>
              {step.detail ? <p>{step.detail}</p> : null}
              {step.references.length > 0 ? (
                <p className="step-refs">
                  {step.references.map((ref) => (
                    <button
                      key={ref}
                      type="button"
                      className="chip"
                      onClick={() => setReference(reference === ref ? null : ref)}
                      aria-expanded={reference === ref}
                    >
                      <Icon name="file" size={13} />
                      <span className="mono">{ref}</span>
                    </button>
                  ))}
                </p>
              ) : null}
              {step.expected ? (
                <p className="step-expected">
                  <span className="muted">Expected:</span> {step.expected}
                </p>
              ) : null}
              {step.references.includes(reference ?? "") && reference ? (
                <FileViewer sourceId={r.item.sourceId} itemId={r.item.id} path={reference} />
              ) : null}
            </div>
          </li>
        ))}
      </ol>
      {wf.artifacts.length > 0 ? (
        <div className="artifacts">
          <h4 className="explain-heading">Produces</h4>
          <ul>
            {wf.artifacts.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="workflow-actions">
        <div className="workflow-action">
          <h4>Prepare for my agent</h4>
          {onInstall ? (
            <>
              <p className="muted">
                Installs the workflow as a standard skill your agent can discover. You see every file before
                anything changes.
              </p>
              <Button size="sm" variant="primary" icon="download" onClick={onInstall}>
                Review and install…
              </Button>
            </>
          ) : (
            <p className="muted">
              Installed in this project as a standard skill. Ask your agent to follow “{r.item.title}”.
            </p>
          )}
        </div>
        {r.item.hasChecks ? (
          <div className="workflow-action">
            <h4>Run a check</h4>
            <p className="muted">
              Runs a declared command against this project after you review it. It executes repository code.
            </p>
            <Button size="sm" icon="terminal" onClick={onRunCheck}>
              Go to checks
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
