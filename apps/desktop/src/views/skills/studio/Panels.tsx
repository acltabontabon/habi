/**
 * What sits beside the document, following what the author is doing:
 * the outline and the package while writing; checks, projects and the ways
 * to use or share it; where it came from and what changed since.
 */
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { Diagnostic } from "../../../bindings/Diagnostic";
import type { LocalChange } from "../../../bindings/LocalChange";
import type { SkillStanding } from "../../../bindings/SkillStanding";
import { DiffStat, DiffView } from "../../../components/DiffView";
import { Icon } from "../../../components/Icon";
import { Button } from "../../../components/ui";
import { api } from "../../../lib/api";
import { plural, relativeTime } from "../../../lib/format";
import { markdownOutline, sectionAt } from "../../../lib/markdownOutline";
import { useNav } from "../../../lib/nav";
import { fileLink, scriptDoc } from "../../../lib/packageLinks";
import { useOpenExternal } from "../../../lib/safeInvoke";
import { originText, provenanceText, upstreamUrl } from "../../../lib/skills";
import { type NavTarget, plainProblem, targetLabel } from "../../../lib/studioNav";
import { UpstreamReview } from "../UpstreamPanel";
import type { SkillDraft } from "./useSkillDraft";

export function PanelSection({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="panel-section">
      <header className="panel-section-head">
        <h3 className="kicker">{title}</h3>
        {aside}
      </header>
      {children}
    </section>
  );
}

// ----- while writing ----------------------------------------------------------------------

export function InstructionsPanel({
  draft,
  cursorLine,
  writing,
  onReveal,
  onInsert,
  onOpenFile,
  onAddFile,
}: {
  draft: SkillDraft;
  cursorLine: number;
  writing: boolean;
  onReveal: (line: number) => void;
  onInsert: (text: string) => void;
  onOpenFile: (path: string) => void;
  onAddFile: () => void;
}) {
  const { document, skill, trashed } = draft;
  const outline = useMemo(() => markdownOutline(document.body), [document.body]);
  const current = sectionAt(outline, cursorLine);
  const top = Math.min(...outline.map((h) => h.level));
  const files = skill.files.filter((f) => f.path !== "SKILL.md" && !/^habi\.ya?ml$/.test(f.path));
  const problems = skill.diagnostics.filter((d) => d.path === "SKILL.md" && d.line != null);
  const canInsert = writing && !trashed;
  return (
    <>
      <PanelSection title="Outline">
        {outline.length === 0 ? (
          <p className="panel-note">Headings appear here as you write them.</p>
        ) : (
          <ol className="panel-outline">
            {outline.map((h) => (
              <li key={`${h.line}:${h.text}`} style={{ paddingLeft: `${(h.level - top) * 12}px` }}>
                <button
                  type="button"
                  className={h === current ? "is-current" : undefined}
                  aria-current={h === current ? "location" : undefined}
                  onClick={() => onReveal(h.line)}
                >
                  {h.text}
                </button>
              </li>
            ))}
          </ol>
        )}
      </PanelSection>

      {problems.length > 0 ? (
        <PanelSection title={`In the text · ${problems.length}`}>
          <ul className="panel-problems">
            {problems.map((d, i) => (
              <li key={i}>
                <button type="button" onClick={() => onReveal(d.line ?? 1)}>
                  <Icon name="warning" size={13} />
                  <span>
                    <span className="mono">line {d.line}</span> {d.message.replace(/^SKILL\.md /, "")}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </PanelSection>
      ) : null}

      <PanelSection
        title={`Package · ${files.length}`}
        aside={
          <button type="button" className="link-quiet" onClick={onAddFile}>
            Add a file
          </button>
        }
      >
        {files.length === 0 ? (
          <p className="panel-note">
            Instructions alone make a complete skill. Scripts, references and assets are optional.
          </p>
        ) : (
          <ul className="panel-files">
            {files.map((f) => {
              const mentioned = document.body.includes(f.path);
              const script = f.path.startsWith("scripts/") || f.executable;
              return (
                <li key={f.path}>
                  <button
                    type="button"
                    className="panel-file"
                    title={`Open ${f.path}`}
                    onClick={() => onOpenFile(f.path)}
                  >
                    <span className="mono">{f.path}</span>
                    {mentioned ? (
                      <span className="panel-file-mark" title="The instructions mention it">
                        <Icon name="check" size={12} />
                        <span className="visually-hidden">mentioned in the instructions</span>
                      </span>
                    ) : null}
                  </button>
                  {canInsert ? (
                    <span className="panel-file-actions">
                      <button
                        type="button"
                        className="link-quiet"
                        aria-label={`Insert a link to ${f.path}`}
                        onClick={() => onInsert(fileLink(f.path))}
                      >
                        Link
                      </button>
                      {script ? (
                        <button
                          type="button"
                          className="link-quiet"
                          aria-label={`Insert documentation for ${f.path}`}
                          onClick={() => onInsert(scriptDoc(f.path))}
                        >
                          Document
                        </button>
                      ) : null}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        <p className="panel-hint">
          Type <span className="mono">](</span> or a backtick in the text to complete a file's path.
        </p>
      </PanelSection>

      <PanelSection title="Keys">
        <dl className="panel-keys">
          <dt>⌘B ⌘I ⌘E</dt>
          <dd>bold, italic, code</dd>
          <dt>⌘⇧8 ⌘⇧7</dt>
          <dd>bulleted, numbered list</dd>
          <dt>⌘⇧L</dt>
          <dd>link</dd>
          <dt>⌘⇧P</dt>
          <dd>preview</dd>
        </dl>
      </PanelSection>
    </>
  );
}

// ----- use & share -------------------------------------------------------------------------

function Finding({ d, onFix }: { d: Diagnostic; onFix: (t: NavTarget) => void }) {
  const problem = plainProblem(d);
  const target = problem.target;
  return (
    <li className={`panel-finding is-${d.level}`}>
      <Icon name={d.level === "error" ? "warning" : "info"} size={13} />
      <span className="panel-finding-text">
        {problem.text}
        {target ? (
          <>
            {" "}
            <button type="button" className="link-btn" onClick={() => onFix(target)}>
              {targetLabel(target)}
            </button>
          </>
        ) : null}
      </span>
    </li>
  );
}

export function SharePanel({
  draft,
  standing,
  onFix,
  onUse,
  onShare,
  onExport,
}: {
  draft: SkillDraft;
  standing: SkillStanding | undefined;
  onFix: (t: NavTarget) => void;
  onUse: () => void;
  onShare: () => void;
  onExport: () => void;
}) {
  const { navigate } = useNav();
  const { skill } = draft;
  const errors = skill.diagnostics.filter((d) => d.level === "error");
  const notes = skill.diagnostics.filter((d) => d.level !== "error");
  const origin = skill.summary.origin;
  const installed = standing?.installedIn ?? [];
  return (
    <>
      <PanelSection title="Check">
        {errors.length === 0 ? (
          <p className="panel-verdict tone-ok">
            <Icon name="check" size={14} /> A valid Agent Skills package. It works without Habi.
          </p>
        ) : (
          <p className="panel-verdict tone-warn">
            <Icon name="warning" size={14} /> {plural(errors.length, "thing")} to finish before it can be
            installed or shared.
          </p>
        )}
        {errors.length + notes.length > 0 ? (
          <ul className="panel-findings">
            {errors.map((d, i) => (
              <Finding key={`e${i}`} d={d} onFix={onFix} />
            ))}
            {notes.map((d, i) => (
              <Finding key={`n${i}`} d={d} onFix={onFix} />
            ))}
          </ul>
        ) : null}
      </PanelSection>

      <PanelSection title="In your projects">
        {installed.length === 0 ? (
          <p className="panel-note">Not installed in any project Habi knows.</p>
        ) : (
          <ul className="panel-installed">
            {installed.map((p) => (
              <li key={p.projectId}>
                <button
                  type="button"
                  className="link-quiet"
                  onClick={() => navigate({ name: "project", projectId: p.projectId, tab: "installed" })}
                >
                  {p.projectName}
                </button>
                <span className={p.current ? "muted" : "tone-thread"}>
                  {p.current ? "this version" : "an earlier version"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </PanelSection>

      <PanelSection title="Ways to use it">
        <ul className="panel-ways">
          <li>
            <Button variant="primary" icon="download" onClick={onUse}>
              Use in a project…
            </Button>
            <p>Installs it for your agents. You see every file before anything is written.</p>
          </li>
          <li>
            <Button icon="share" onClick={onShare}>
              {origin.type === "library" ? `Share back to ${origin.sourceName}…` : "Share to a library…"}
            </Button>
            <p>Prepares a contribution you review; nothing is sent until you say so.</p>
          </li>
          <li>
            <Button variant="quiet" icon="folder" onClick={onExport}>
              Export a folder…
            </Button>
            <p>A plain Agent Skills folder. Never replaces an existing one.</p>
          </li>
        </ul>
      </PanelSection>
    </>
  );
}

// ----- lineage ------------------------------------------------------------------------------

const changeWord = { added: "added", modified: "changed", removed: "removed" } as const;

function ChangeRow({ change }: { change: LocalChange }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="panel-change">
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name={open ? "chevronDown" : "chevronRight"} size={12} />
        <span className="mono panel-change-path">{change.path}</span>
        <span className="muted">{changeWord[change.change]}</span>
        <DiffStat diff={change.diff} />
      </button>
      {change.note ? <p className="panel-note">{change.note}</p> : null}
      {open ? <DiffView diff={change.diff} label={`Changes to ${change.path}`} /> : null}
    </li>
  );
}

export function LineagePanel({
  draft,
  standing,
  beforeReview,
  onShare,
}: {
  draft: SkillDraft;
  standing: SkillStanding | undefined;
  beforeReview: () => Promise<boolean>;
  onShare: () => void;
}) {
  const { skill, reloadFromDisk } = draft;
  const id = skill.summary.id;
  const origin = skill.summary.origin;
  const openExternal = useOpenExternal();
  const [reviewing, setReviewing] = useState(false);
  const copied = origin.type === "library" || origin.type === "folder" || origin.type === "project";
  const changes = useQuery({
    queryKey: ["skill-local-changes", id, skill.summary.contentDigest],
    queryFn: () => api.skillLocalChanges(id),
    enabled: copied,
  });
  const upstream = useQuery({
    queryKey: ["skill-upstream", id, origin.type === "library" ? origin.snapshot : null],
    queryFn: () => api.skillUpstream(id),
    enabled: origin.type === "library",
  });
  const original = upstreamUrl(origin);
  const provenance = provenanceText(origin);
  const u = upstream.data;
  const c = changes.data;

  return (
    <>
      <ol className="lineage">
        <li className="lineage-step">
          <span className="lineage-knot is-origin" aria-hidden="true" />
          <div>
            <p className="lineage-title">{copied ? "The original" : "Where it starts"}</p>
            <p className="lineage-text">{provenance ?? originText(origin)}</p>
            {original ? (
              <button type="button" className="link-quiet" onClick={() => openExternal(original)}>
                View the original <Icon name="external" size={12} />
              </button>
            ) : null}
          </div>
        </li>
        <li className="lineage-step">
          <span className="lineage-knot is-mine" aria-hidden="true" />
          <div>
            <p className="lineage-title">{copied ? "Your copy" : "This skill"}</p>
            <p className="lineage-text">
              {copied ? "Copied" : "Started"} {relativeTime(skill.summary.createdAt)} · yours to edit
            </p>
          </div>
        </li>
        {copied ? (
          <li className={`lineage-step${skill.summary.modifiedLocally ? " is-woven" : ""}`}>
            <span className="lineage-knot is-local" aria-hidden="true" />
            <div>
              <p className="lineage-title">Changed here</p>
              {changes.isPending ? (
                <p className="lineage-text muted">Comparing…</p>
              ) : !c?.known ? (
                <p className="lineage-text muted">{c?.detail ?? "Cannot be compared."}</p>
              ) : c.files.length === 0 ? (
                <p className="lineage-text muted">Nothing yet — it is as it was copied.</p>
              ) : (
                <>
                  <p className="lineage-text">
                    {plural(c.files.length, "file")} changed · {c.unchanged} as copied
                  </p>
                  <ul className="panel-changes">
                    {c.files.map((f) => (
                      <ChangeRow key={f.path} change={f} />
                    ))}
                  </ul>
                </>
              )}
            </div>
          </li>
        ) : null}
        {origin.type === "library" ? (
          <li className={`lineage-step${u?.state === "changed" ? " is-news" : ""}`}>
            <span className="lineage-knot is-upstream" aria-hidden="true" />
            <div>
              <p className="lineage-title">The library now</p>
              {!u ? (
                <p className="lineage-text muted">Checking what Habi has cached…</p>
              ) : u.state === "changed" ? (
                <>
                  <p className="lineage-text">Updated in {u.sourceName} since this copy.</p>
                  <Button
                    size="sm"
                    onClick={() => void beforeReview().then((saved) => saved && setReviewing(true))}
                  >
                    Review the update…
                  </Button>
                </>
              ) : u.state === "unchanged" ? (
                <p className="lineage-text muted">No newer version in what was last fetched.</p>
              ) : (
                <p className="lineage-text muted">{u.detail}</p>
              )}
            </div>
          </li>
        ) : null}
        <li className="lineage-step">
          <span className="lineage-knot is-forward" aria-hidden="true" />
          <div>
            <p className="lineage-title">Pass it on</p>
            <p className="lineage-text">
              {origin.type === "library"
                ? `Offer your changes back to ${origin.sourceName}, or share it with your team's library.`
                : "Share it to a library so others can use it."}
            </p>
            <Button size="sm" variant="quiet" icon="share" onClick={onShare}>
              Prepare a contribution…
            </Button>
          </div>
        </li>
      </ol>
      {standing?.installedIn.length ? (
        <p className="panel-hint">
          Installed in {standing.installedIn.map((p) => p.projectName).join(", ")}.
        </p>
      ) : null}
      {reviewing && u ? (
        <UpstreamReview
          skillId={id}
          sourceName={u.sourceName}
          onClose={() => setReviewing(false)}
          onApplied={reloadFromDisk}
        />
      ) : null}
    </>
  );
}
