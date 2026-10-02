/**
 * "Why this fits": the evaluation tree rendered as readable reasons, each
 * tied by a thread to the exact fact, file or declaration behind it.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import type { EvalNode } from "../../bindings/EvalNode";
import type { Fact } from "../../bindings/Fact";
import type { ModuleMatch } from "../../bindings/ModuleMatch";
import type { ProjectOverview } from "../../bindings/ProjectOverview";
import type { Tri } from "../../bindings/Tri";
import { Icon } from "../../components/Icon";
import { useToast } from "../../components/Toasts";
import { Button, ErrorNotice } from "../../components/ui";
import { api } from "../../lib/api";
import { invalidateProjectData } from "../../lib/queries";
import { TAG_LABELS } from "../../lib/tags";

const triWord: Record<Tri, string> = { true: "holds", false: "does not hold", unknown: "not established" };
const triIcon = { true: "check", false: "cross", unknown: "question" } as const;

function factLocation(fact: Fact): { file: string; line: number | null; text: string } | null {
  const e = fact.evidence[0];
  if (!e) return null;
  const where = e.line ? `${e.file}:${e.line}` : e.file;
  return { file: e.file, line: e.line, text: e.excerpt ? `${where} — ${e.excerpt}` : where };
}

/** Shows a few lines of a project file around the evidence line. */
export function EvidenceExcerpt({
  projectId,
  file,
  line,
}: {
  projectId: string;
  file: string;
  line: number | null;
}) {
  const excerpt = useQuery({
    queryKey: ["excerpt", projectId, file, line],
    queryFn: () => api.readProjectExcerpt(projectId, file, line),
  });
  if (excerpt.isPending) return <p className="muted excerpt-loading">Reading {file}…</p>;
  if (excerpt.isError) return <ErrorNotice error={excerpt.error} title={`Could not show ${file}`} />;
  const data = excerpt.data;
  return (
    <figure className="excerpt">
      <figcaption className="excerpt-head">
        <span className="mono">{data.path}</span>
        <span className="muted">
          lines {data.startLine}–{data.startLine + data.lines.length - 1} of {data.totalLines}
        </span>
        <button
          type="button"
          className="link-btn"
          onClick={() => void api.revealProjectPath(projectId, data.path)}
        >
          Reveal in folder
        </button>
      </figcaption>
      <pre className="excerpt-body">
        {data.lines.map((text, i) => {
          const n = data.startLine + i;
          const hit = data.highlight === n;
          return (
            <span
              key={n}
              className={`excerpt-line${hit ? " is-hit" : ""}`}
              aria-current={hit ? "true" : undefined}
            >
              <span className="excerpt-num" aria-hidden="true">
                {n}
              </span>
              {text || " "}
              {"\n"}
            </span>
          );
        })}
      </pre>
    </figure>
  );
}

function Chip({ label, open, onToggle }: { label: string; open: boolean; onToggle: () => void }) {
  return (
    <button type="button" className={`chip${open ? " is-open" : ""}`} aria-expanded={open} onClick={onToggle}>
      <Icon name="file" size={13} />
      <span className="mono">{label}</span>
    </button>
  );
}

function NodeEvidence({ node, overview }: { node: EvalNode; overview: ProjectOverview }) {
  const [open, setOpen] = useState<string | null>(null);
  const client = useQueryClient();
  const toast = useToast();
  const facts = node.facts
    .map((id) => overview.inspection.facts.find((f) => f.id === id))
    .filter((f): f is Fact => Boolean(f));
  // Show the most direct evidence first (dependency/file facts before derived tags).
  const located = facts
    .map((f) => ({ fact: f, loc: factLocation(f) }))
    .filter((x): x is { fact: Fact; loc: NonNullable<ReturnType<typeof factLocation>> } => x.loc !== null);
  const unique = located
    .filter((x, i) => located.findIndex((y) => y.loc.text === x.loc.text) === i)
    .slice(0, 4);
  const files = node.files.slice(0, 4);
  const declarations = node.declarations
    .map((id) => overview.declarations.find((d) => d.id === id))
    .filter((d) => d !== undefined);

  if (unique.length === 0 && files.length === 0 && declarations.length === 0) return null;
  const undo = async (id: string) => {
    try {
      await api.retract(overview.project.id, id);
      invalidateProjectData(client, overview.project.id);
      toast.show("Declaration removed. Recommendations updated.");
    } catch (e) {
      toast.show(e instanceof Error ? e.message : String(e), "danger");
    }
  };
  const openItem = unique.find((x) => x.loc.text === open) ?? null;
  const openFile = files.find((f) => f === open) ?? null;
  return (
    <div className="node-evidence">
      <div className="chips">
        {unique.map(({ loc }) => (
          <Chip
            key={loc.text}
            label={loc.text}
            open={open === loc.text}
            onToggle={() => setOpen(open === loc.text ? null : loc.text)}
          />
        ))}
        {files.map((f) => (
          <Chip key={f} label={f} open={open === f} onToggle={() => setOpen(open === f ? null : f)} />
        ))}
        {declarations.map((d) => (
          <span key={d.id} className="chip chip-declared">
            <Icon name="pencil" size={13} />
            You declared this {d.present ? "present" : "absent"}
            {d.note ? ` — “${d.note}”` : ""}
            <button type="button" className="link-btn" onClick={() => void undo(d.id)}>
              Undo
            </button>
          </span>
        ))}
      </div>
      {openItem ? (
        <EvidenceExcerpt projectId={overview.project.id} file={openItem.loc.file} line={openItem.loc.line} />
      ) : null}
      {openFile ? <EvidenceExcerpt projectId={overview.project.id} file={openFile} line={null} /> : null}
    </div>
  );
}

/** The condition tree as a readable, nested list of reasons. */
export function EvalTree({
  node,
  overview,
  depth = 0,
}: {
  node: EvalNode;
  overview: ProjectOverview;
  depth?: number;
}) {
  const isGroup = node.condition.op === "all" || node.condition.op === "any" || node.condition.op === "not";
  const label =
    node.condition.op === "all"
      ? "All of these"
      : node.condition.op === "any"
        ? "Any of these"
        : node.condition.op === "not"
          ? "Not the following"
          : node.summary;
  return (
    <li className={`reason tri-${node.outcome}${isGroup ? " reason-group" : ""}`}>
      <div className="reason-line">
        <span className="reason-knot" aria-hidden="true">
          <Icon name={triIcon[node.outcome]} size={13} />
        </span>
        <span className="reason-text">
          <span className="reason-summary">{label}</span>
          <span className="visually-hidden"> — {triWord[node.outcome]}. </span>
          {!isGroup ? <span className="reason-why"> — {node.reason}</span> : null}
        </span>
      </div>
      {!isGroup ? <NodeEvidence node={node} overview={overview} /> : null}
      {isGroup && node.children.length > 0 ? (
        <ul className="reasons">
          {node.children.map((child, i) => (
            <EvalTree key={i} node={child} overview={overview} depth={depth + 1} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** Collects leaves that are `unknown` and can be answered with a declaration. */
export function answerable(
  node: EvalNode | null,
): { kind: "tag" | "dependency"; name: string; reason: string }[] {
  if (!node) return [];
  if (node.outcome !== "unknown") return [];
  if (node.condition.op === "tag") return [{ kind: "tag", name: node.condition.tag, reason: node.reason }];
  if (node.condition.op === "dependency" && !node.condition.name.includes("*"))
    return [{ kind: "dependency", name: node.condition.name, reason: node.reason }];
  return node.children.flatMap(answerable);
}

/** The conditions that held, outside any negation: what made the rule match. */
function matchedLeaves(node: EvalNode): EvalNode[] {
  if (node.condition.op === "not") return [];
  if (node.condition.op === "all" || node.condition.op === "any") return node.children.flatMap(matchedLeaves);
  return node.outcome === "true" ? [node] : [];
}

/**
 * Only what matched, each with its evidence. The full evaluation (including
 * what did not hold) is one click away in `ModuleExplanation`.
 */
export function MatchedReasons({ match, overview }: { match: ModuleMatch; overview: ProjectOverview }) {
  const leaves = match.applies ? matchedLeaves(match.applies) : [];
  if (leaves.length === 0) return null;
  return (
    <ul className="reasons reasons-root reasons-matched">
      {leaves.map((leaf, i) => (
        <EvalTree key={i} node={leaf} overview={overview} />
      ))}
    </ul>
  );
}

export function ModuleExplanation({ match, overview }: { match: ModuleMatch; overview: ProjectOverview }) {
  return (
    <div className="module-explain">
      {match.applies ? (
        <div className="explain-block">
          <h4 className="explain-heading">Applies when</h4>
          <ul className="reasons reasons-root">
            <EvalTree node={match.applies} overview={overview} />
          </ul>
        </div>
      ) : null}
      {match.excludes ? (
        <div className="explain-block">
          <h4 className="explain-heading">Ruled out when</h4>
          <ul className="reasons reasons-root">
            <EvalTree node={match.excludes} overview={overview} />
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** "Does api use jOOQ?" — a question the user can answer, in plain words. */
export function questionText(
  question: { kind: "tag" | "dependency"; name: string },
  where: ReactNode,
): ReactNode {
  if (question.kind === "dependency") {
    return (
      <>
        Does {where} depend on <span className="mono">{question.name}</span>?
      </>
    );
  }
  const label = TAG_LABELS[question.name];
  if (!label) {
    return (
      <>
        Does {where} have the tag <span className="mono">{question.name}</span>?
      </>
    );
  }
  if (question.name.startsWith("lang:"))
    return (
      <>
        Does {where} contain {label} code?
      </>
    );
  if (question.name === "api:openapi") return <>Does {where} have an OpenAPI specification?</>;
  return (
    <>
      Does {where} use <strong>{label}</strong>?
    </>
  );
}

/** Lets the user state what Habi could not establish (reversible). */
export function DeclareQuestion({
  overview,
  module,
  moduleName,
  question,
  showReason = true,
}: {
  overview: ProjectOverview;
  module: string;
  moduleName: string;
  question: { kind: "tag" | "dependency"; name: string; reason: string };
  /** False when the reason is shown once for all questions. */
  showReason?: boolean;
}) {
  const client = useQueryClient();
  const toast = useToast();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const whole = module === "*" || module === ".";
  const where = whole ? "this project" : <strong>{moduleName}</strong>;
  const inputId = `note-${module}-${question.name}`;
  const answer = async (present: boolean) => {
    setBusy(true);
    try {
      await api.declare(
        overview.project.id,
        whole ? "*" : module,
        question.kind === "tag"
          ? { type: "tag", tag: question.name }
          : { type: "dependency", name: question.name },
        present,
        note.trim() || null,
      );
      invalidateProjectData(client, overview.project.id);
      toast.show("Answer saved. It is shown as yours and can be undone.");
    } catch (e) {
      toast.show(e instanceof Error ? e.message : String(e), "danger");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="declare">
      <p className="declare-question">{questionText(question, where)}</p>
      {showReason ? <p className="muted">{sentence(question.reason)}</p> : null}
      <div className="declare-row">
        <label className="visually-hidden" htmlFor={inputId}>
          Note (optional)
        </label>
        <input
          id={inputId}
          className="input"
          placeholder="Note to yourself (optional, stays on this machine)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <Button size="sm" onClick={() => void answer(true)} busy={busy}>
          Yes
        </Button>
        <Button size="sm" onClick={() => void answer(false)} busy={busy}>
          No
        </Button>
      </div>
    </div>
  );
}

/** "not detected, but …" → "Not detected, but …." */
export function sentence(text: string): string {
  const t = text.trim();
  if (!t) return t;
  const first = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(first) ? first : `${first}.`;
}
