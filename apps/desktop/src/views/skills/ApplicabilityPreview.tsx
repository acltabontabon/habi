/**
 * Where the rules being edited apply, across the registered projects.
 *
 * This is the matcher's verdict on the *rules* — it says nothing about the
 * skill's quality or what an agent will do with it. Recalculation is
 * debounced; a newer request cancels the older job and stale results are
 * discarded.
 */
import { useState } from "react";
import type { EvalNode } from "../../bindings/EvalNode";
import type { ModuleMatch } from "../../bindings/ModuleMatch";
import type { PreviewRequest } from "../../bindings/PreviewRequest";
import type { ProjectPreview } from "../../bindings/ProjectPreview";
import { Icon } from "../../components/Icon";
import { Button, Status } from "../../components/ui";
import { applicabilityTone, NO_RULES_PHRASE, relativeTime } from "../../lib/format";
import { useRulesPreview } from "../../lib/useRulesPreview";
import { EvidenceExcerpt } from "../project/Explain";

export const verdict = {
  applies: "Applies",
  doesNotApply: "Does not apply",
  needsInformation: "Needs information",
  undeclared: "No rules for when it applies",
} as const;

const triIcon = { true: "check", false: "cross", unknown: "question" } as const;
const triWord = { true: "holds", false: "does not hold", unknown: "not established" } as const;

const ORDER = ["applies", "needsInformation", "undeclared", "doesNotApply"];
/** Matches first, then open questions, then the rest. */
export function rank(p: ProjectPreview): number {
  return p.result ? ORDER.indexOf(p.result.applicability) : 1;
}

function parseLocation(location: string): { file: string; line: number | null } {
  const match = /^(.*):(\d+)$/.exec(location);
  return match?.[1] ? { file: match[1], line: Number(match[2]) } : { file: location, line: null };
}

export function Node({ node, projectId }: { node: EvalNode; projectId: string }) {
  const [open, setOpen] = useState<string | null>(null);
  const group = node.condition.op === "all" || node.condition.op === "any" || node.condition.op === "not";
  const label =
    node.condition.op === "all"
      ? "All of these"
      : node.condition.op === "any"
        ? "Any of these"
        : node.condition.op === "not"
          ? "Not the following"
          : node.summary;
  const evidence = [...(node.location ? [node.location] : []), ...node.files.slice(0, 3)].filter(
    (e, i, all) => all.indexOf(e) === i,
  );
  const opened = open ? parseLocation(open) : null;
  return (
    <li className={`reason tri-${node.outcome}${group ? " reason-group" : ""}`}>
      <div className="reason-line">
        <span className="reason-knot" aria-hidden="true">
          <Icon name={triIcon[node.outcome]} size={13} />
        </span>
        <span className="reason-text">
          <span className="reason-summary">{label}</span>
          <span className="visually-hidden"> — {triWord[node.outcome]}. </span>
          {!group ? <span className="reason-why"> — {node.reason}</span> : null}
        </span>
      </div>
      {!group && evidence.length > 0 ? (
        <div className="node-evidence">
          <div className="chips">
            {evidence.map((e) => (
              <button
                key={e}
                type="button"
                className="chip"
                aria-expanded={open === e}
                onClick={() => setOpen(open === e ? null : e)}
              >
                <Icon name="file" size={13} />
                <span className="mono">{e}</span>
              </button>
            ))}
          </div>
          {opened ? <EvidenceExcerpt projectId={projectId} file={opened.file} line={opened.line} /> : null}
        </div>
      ) : null}
      {group && node.children.length > 0 ? (
        <ul className="reasons">
          {node.children.map((child, i) => (
            <Node key={i} node={child} projectId={projectId} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function ModuleDetail({
  match,
  projectId,
  named,
}: {
  match: ModuleMatch;
  projectId: string;
  named: boolean;
}) {
  return (
    <div className="preview-module">
      {named ? (
        <p className="preview-module-name">
          {match.moduleName}
          {match.module !== "." && match.module !== "*" ? (
            <span className="mono muted"> {match.module}</span>
          ) : null}{" "}
          <Status tone={applicabilityTone[match.applicability]}>{verdict[match.applicability]}</Status>
        </p>
      ) : null}
      {match.applies ? (
        <ul className="reasons reasons-root">
          <Node node={match.applies} projectId={projectId} />
        </ul>
      ) : null}
      {match.excludes ? (
        <>
          <p className="explain-heading">Ruled out when</p>
          <ul className="reasons reasons-root">
            <Node node={match.excludes} projectId={projectId} />
          </ul>
        </>
      ) : null}
    </div>
  );
}

export function ProjectRow({ preview }: { preview: ProjectPreview }) {
  const [open, setOpen] = useState(false);
  const { project, result } = preview;
  if (!result) {
    return (
      <li className="preview-row">
        <div className="preview-row-head">
          <Status tone="unknown">Not inspected</Status>
          <span className="preview-project">{project.name}</span>
        </div>
        <p className="preview-reason">{preview.error?.message ?? "The project could not be inspected."}</p>
      </li>
    );
  }
  const multi = result.modules.length > 1;
  // Do not repeat a limitation the reason already spells out.
  const notes = preview.incomplete.filter((n) => !result.reason.includes(n.slice(n.indexOf(": ") + 2)));
  return (
    <li className={`preview-row verdict-${result.applicability}`}>
      <button
        type="button"
        className="preview-row-head"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Status tone={applicabilityTone[result.applicability]}>{verdict[result.applicability]}</Status>
        <span className="preview-project">
          {project.name}
          {project.sample ? <span className="sidebar-tag">sample</span> : null}
        </span>
        <Icon name={open ? "chevronDown" : "chevronRight"} size={14} />
      </button>
      <p className="preview-reason">{result.reason}</p>
      {notes.length > 0 ? (
        <p className="preview-incomplete">
          <Icon name="info" size={13} /> Inspection is incomplete: {notes[0]}
          {notes.length > 1 ? ` (and ${notes.length - 1} more)` : ""}
        </p>
      ) : null}
      {open ? (
        <div className="preview-detail">
          {result.modules.map((m) => (
            <ModuleDetail key={m.module} match={m} projectId={project.id} named={multi} />
          ))}
          <p className="preview-meta">
            Inspected {relativeTime(preview.inspectedAt)} ·{" "}
            {result.scope === "repository" ? "whole repository" : "per module"}
          </p>
        </div>
      ) : null}
    </li>
  );
}

export function ApplicabilityPreview({
  request,
  requestKey,
  hasProjects,
  onOpenProject,
}: {
  /** What to evaluate; `null` pauses the preview. */
  request: PreviewRequest | null;
  /** Changes whenever the rules change. */
  requestKey: string;
  hasProjects: boolean;
  onOpenProject: () => void;
}) {
  const { preview, busy, error } = useRulesPreview(request, requestKey, hasProjects);

  const noRules = preview !== null && !preview.problem && !preview.appliesWhen && !preview.excludes;
  const counts = preview
    ? {
        applies: preview.projects.filter((p) => p.result?.applicability === "applies").length,
        unknown: preview.projects.filter((p) => !p.result || p.result.applicability === "needsInformation")
          .length,
      }
    : null;

  return (
    <aside className="preview" aria-labelledby="preview-title">
      <header className="preview-head">
        <h2 id="preview-title" className="preview-title">
          Where it applies
        </h2>
        <p className="preview-sub" aria-live="polite">
          {busy
            ? "Checking your projects…"
            : preview && !noRules && !preview.problem && counts
              ? `${counts.applies} of ${preview.projects.length} projects${counts.unknown ? ` · ${counts.unknown} unknown` : ""}`
              : "A preview of the rules, not a test of the skill."}
        </p>
      </header>

      {!hasProjects ? (
        <div className="preview-empty">
          <p>Open a project to see how these rules evaluate against it. The draft does not need one.</p>
          <Button size="sm" icon="folder" onClick={onOpenProject}>
            Open a project…
          </Button>
        </div>
      ) : error ? (
        <p className="field-problem" role="alert">
          The preview could not run: {error instanceof Error ? error.message : String(error)}
        </p>
      ) : preview?.problem ? (
        <div className="preview-empty">
          <p className="field-problem" role="alert">
            These rules cannot be evaluated yet: {preview.problem}
          </p>
        </div>
      ) : noRules ? (
        <div className="preview-empty">
          <p>
            <strong>{NO_RULES_PHRASE}.</strong> The skill stays available to use deliberately in any project;
            Habi will not recommend it or guess from its title.
          </p>
        </div>
      ) : preview ? (
        <>
          <ul className={`preview-list${busy ? " is-stale" : ""}`}>
            {[...preview.projects]
              .sort((a, b) => rank(a) - rank(b))
              .map((p) => (
                <ProjectRow key={p.project.id} preview={p} />
              ))}
          </ul>
          <p className="preview-foot">
            Matching reads build files and file names only. “Applies” means the rules hold — not that the
            skill was tried there.
          </p>
        </>
      ) : (
        <p className="muted preview-empty">Checking your projects…</p>
      )}
    </aside>
  );
}
