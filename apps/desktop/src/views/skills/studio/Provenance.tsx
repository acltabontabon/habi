/**
 * Where a skill's knowledge came from, and where it has been since — Habi's
 * thread. Inline it is one line: the source in its library's dye, a knot
 * where it became yours, and a saffron run when it was changed here. Opened,
 * it is the same thread drawn top to bottom: the original, your version and
 * what you changed, the library now, and the ways to pass it on.
 */
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { LocalChange } from "../../../bindings/LocalChange";
import type { LocalSkillSummary } from "../../../bindings/LocalSkillSummary";
import type { SkillStanding } from "../../../bindings/SkillStanding";
import { DiffStat, DiffView } from "../../../components/DiffView";
import { Icon } from "../../../components/Icon";
import { Button } from "../../../components/ui";
import { api } from "../../../lib/api";
import { type Dye, dyeMap } from "../../../lib/dye";
import { relativeTime } from "../../../lib/format";
import { useNav } from "../../../lib/nav";
import { useSources } from "../../../lib/queries";
import { useOpenExternal } from "../../../lib/safeInvoke";
import { provenanceText, repoName, upstreamUrl } from "../../../lib/skills";
import { UpstreamReview } from "../UpstreamPanel";

type Origin = LocalSkillSummary["origin"];

export const isCopy = (o: Origin) => o.type === "library" || o.type === "folder" || o.type === "project";

/** Where it came from, in a name: the library, the folder, the project. */
export function sourceName(o: Origin): string | null {
  switch (o.type) {
    case "library":
      return o.sourceName;
    case "folder":
      return o.path.split("/").filter(Boolean).pop() ?? "a folder";
    case "project":
      return o.projectName;
    case "instructions":
      return `${o.path.split("/").pop()} in ${o.projectName}`;
    default:
      return null;
  }
}

/** What happened here, in two words. */
export function localWords(summary: LocalSkillSummary): { text: string; changed: boolean } {
  const o = summary.origin;
  if (!isCopy(o))
    return { text: o.type === "instructions" ? "written here" : "written here", changed: false };
  if (summary.modifiedLocally === true) return { text: "changed here", changed: true };
  return { text: o.type === "library" ? "as imported" : "as copied", changed: false };
}

export function useDye(o: Origin): Dye | undefined {
  const sources = useSources();
  if (o.type !== "library") return undefined;
  const source = (sources.data ?? []).find((s) => s.name === o.sourceName);
  return source ? dyeMap(sources.data ?? []).get(source.id) : undefined;
}

/** The thread itself: an incoming run in the source's dye, the knot, and what was added here. */
export function Thread({ origin, changed, dye }: { origin: Origin; changed: boolean; dye?: Dye }) {
  const copied = isCopy(origin) || origin.type === "instructions";
  const width = copied ? (changed ? 40 : 28) : 10;
  return (
    <svg className="pv-thread" width={width} height="10" viewBox={`0 0 ${width} 10`} aria-hidden="true">
      {copied ? (
        <line
          x1="1"
          y1="5"
          x2="20"
          y2="5"
          stroke={dye?.color ?? "var(--ink-faint)"}
          strokeWidth="1.6"
          strokeDasharray={dye?.community ? "2.5 2" : undefined}
          strokeLinecap="round"
        />
      ) : null}
      <circle
        cx={copied ? 24 : 5}
        cy="5"
        r="3.2"
        fill={changed ? "var(--thread)" : copied ? "var(--paper)" : "var(--ink-soft)"}
        stroke={changed ? "var(--thread)" : "var(--ink-soft)"}
        strokeWidth="1.4"
      />
      {changed ? (
        <line x1="28" y1="5" x2="39" y2="5" stroke="var(--thread)" strokeWidth="1.6" strokeLinecap="round" />
      ) : null}
    </svg>
  );
}

/** "Anthropic ──● changed here" — a line, or a button that opens the whole thread. */
export function Provenance({
  summary,
  standing,
  onOpen,
}: {
  summary: LocalSkillSummary;
  standing?: SkillStanding;
  onOpen?: () => void;
}) {
  const dye = useDye(summary.origin);
  const from = sourceName(summary.origin);
  const here = localWords(summary);
  const newer = standing?.upstream === "changed";
  const body = (
    <>
      {from ? <span className="pv-from">{from}</span> : null}
      <Thread origin={summary.origin} changed={here.changed} dye={dye} />
      <span className={here.changed ? "pv-here is-changed" : "pv-here"}>{here.text}</span>
      {newer ? <span className="pv-news">· newer version</span> : null}
    </>
  );
  if (!onOpen) return <span className="pv">{body}</span>;
  return (
    <button
      type="button"
      className="pv is-button"
      onClick={onOpen}
      aria-label={`${from ? `From ${from}, ` : ""}${here.text}${newer ? ", newer version available" : ""}. Where it came from`}
    >
      {body}
    </button>
  );
}

const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: undefined });

/** SKILL.md is the instructions; habi.yaml is when to use it; anything else is its own name. */
function changeName(path: string): string {
  if (path === "SKILL.md") return "Instructions";
  if (/^habi\.ya?ml$/.test(path)) return "When to use";
  return path.slice(path.lastIndexOf("/") + 1);
}

const SIGN = { added: "+", modified: "~", removed: "−" } as const;

function Change({ change }: { change: LocalChange }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="pv-change">
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className={`pv-sign is-${change.change}`} aria-hidden="true">
          {SIGN[change.change]}
        </span>
        <span className="pv-change-name" title={change.path}>
          {changeName(change.path)}
        </span>
        <DiffStat diff={change.diff} />
      </button>
      {open ? <DiffView diff={change.diff} label={`Changes to ${change.path}`} /> : null}
    </li>
  );
}

export function ProvenanceSheet({
  summary,
  standing,
  title,
  beforeReview,
  onReloaded,
  onShare,
  onExport,
}: {
  summary: LocalSkillSummary;
  standing: SkillStanding | undefined;
  title: string;
  beforeReview: () => Promise<boolean>;
  onReloaded: () => void;
  onShare: () => void;
  onExport: () => void;
}) {
  const { navigate } = useNav();
  const openExternal = useOpenExternal();
  const id = summary.id;
  const origin = summary.origin;
  const dye = useDye(origin);
  const copied = isCopy(origin);
  const [reviewing, setReviewing] = useState(false);
  const changes = useQuery({
    queryKey: ["skill-local-changes", id, summary.contentDigest],
    queryFn: () => api.skillLocalChanges(id),
    enabled: copied,
  });
  const upstream = useQuery({
    queryKey: ["skill-upstream", id, origin.type === "library" ? origin.snapshot : null],
    queryFn: () => api.skillUpstream(id),
    enabled: origin.type === "library",
  });
  const original = upstreamUrl(origin);
  const from = sourceName(origin);
  const c = changes.data;
  const u = upstream.data;
  const installed = standing?.installedIn ?? [];
  const where =
    origin.type === "library" && origin.upstream
      ? `${origin.upstream.path}${origin.upstream.url ? ` · ${repoName(origin.upstream.url)}` : ""}`
      : origin.type === "folder" || origin.type === "instructions"
        ? origin.path
        : null;

  return (
    <div className="pv-sheet">
      <p className="pv-sheet-title">{title || "Untitled skill"}</p>
      <ol className="pv-line" style={dye ? ({ "--dye": dye.color } as React.CSSProperties) : undefined}>
        {from ? (
          <li className="pv-step is-source">
            <span className="pv-knot" aria-hidden="true" />
            <div>
              <p className="pv-step-title">
                {origin.type === "library" ? `Originally from ${from}` : `From ${from}`}
              </p>
              {where ? <p className="pv-step-text mono">{where}</p> : null}
              {provenanceText(origin) ? <p className="pv-step-text">{provenanceText(origin)}</p> : null}
              {original ? (
                <button type="button" className="link-quiet" onClick={() => openExternal(original)}>
                  View the original <Icon name="external" size={12} />
                </button>
              ) : null}
            </div>
          </li>
        ) : null}
        {from ? (
          <li className="pv-step is-edge" aria-hidden="true">
            <span className="pv-edge-label">
              {origin.type === "library" ? "imported" : "copied"} {shortDate(summary.createdAt)}
            </span>
          </li>
        ) : null}
        <li className={`pv-step is-mine${summary.modifiedLocally ? " is-changed" : ""}`}>
          <span className="pv-knot" aria-hidden="true" />
          <div>
            <p className="pv-step-title">{copied ? "Your version" : "Written here"}</p>
            {!copied ? (
              <p className="pv-step-text">
                Started {shortDate(summary.createdAt)} · edited {relativeTime(summary.updatedAt)}
              </p>
            ) : changes.isPending ? (
              <p className="pv-step-text muted">Comparing with the original…</p>
            ) : !c?.known ? (
              <p className="pv-step-text muted">{c?.detail ?? "It cannot be compared with the original."}</p>
            ) : c.files.length === 0 ? (
              <p className="pv-step-text muted">
                Unchanged since it was {origin.type === "library" ? "imported" : "copied"}.
              </p>
            ) : (
              <>
                <p className="pv-step-text">Changed here</p>
                <ul className="pv-changes">
                  {c.files.map((f) => (
                    <Change key={f.path} change={f} />
                  ))}
                </ul>
              </>
            )}
          </div>
        </li>
        {origin.type === "library" && u?.state === "changed" ? (
          <li className="pv-step is-news">
            <span className="pv-knot" aria-hidden="true" />
            <div>
              <p className="pv-step-title">Newer in {u.sourceName}</p>
              <p className="pv-step-text">The original changed since you imported it.</p>
              <Button size="sm" onClick={() => void beforeReview().then((ok) => ok && setReviewing(true))}>
                Review the update…
              </Button>
            </div>
          </li>
        ) : null}
        {installed.length > 0 ? (
          <li className="pv-step is-used">
            <span className="pv-knot" aria-hidden="true" />
            <div>
              <p className="pv-step-title">In use</p>
              <ul className="pv-projects">
                {installed.map((p) => (
                  <li key={p.projectId}>
                    <button
                      type="button"
                      className="link-quiet"
                      onClick={() => navigate({ name: "project", projectId: p.projectId, tab: "installed" })}
                    >
                      {p.projectName}
                    </button>
                    {p.current ? null : <span className="pv-step-note"> · an earlier version</span>}
                  </li>
                ))}
              </ul>
            </div>
          </li>
        ) : null}
        <li className="pv-step is-onward">
          <span className="pv-knot" aria-hidden="true" />
          <div className="pv-onward">
            {origin.type === "library" ? (
              <>
                <button type="button" className="pv-onward-link" onClick={onShare}>
                  Contribute improvement <span aria-hidden="true">→</span>
                </button>
                <button type="button" className="pv-onward-link is-quiet" onClick={onShare}>
                  Share your version <span aria-hidden="true">→</span>
                </button>
              </>
            ) : (
              <button type="button" className="pv-onward-link" onClick={onShare}>
                Share to a library <span aria-hidden="true">→</span>
              </button>
            )}
            <button type="button" className="pv-onward-link is-quiet" onClick={onExport}>
              Export as a folder <span aria-hidden="true">→</span>
            </button>
          </div>
        </li>
      </ol>
      {reviewing && u ? (
        <UpstreamReview
          skillId={id}
          sourceName={u.sourceName}
          onClose={() => setReviewing(false)}
          onApplied={onReloaded}
        />
      ) : null}
    </div>
  );
}
