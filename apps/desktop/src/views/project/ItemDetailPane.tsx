/** Detail of one recommendation: why it fits, the workflow, its content, checks. */
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ProjectOverview } from "../../bindings/ProjectOverview";
import type { Recommendation } from "../../bindings/Recommendation";
import { Icon } from "../../components/Icon";
import { useToast } from "../../components/Toasts";
import { Button, Facet, Label, Notice, Section, Status } from "../../components/ui";
import { useActions } from "../../lib/actions";
import { api } from "../../lib/api";
import {
  applicabilityLabel,
  applicabilityTone,
  clientsPhrase,
  evidenceLabel,
  evidenceTone,
  freshnessText,
  installLabel,
  installTone,
  kindLabel,
  NO_RULES_PHRASE,
  prerequisiteLabel,
  prerequisiteTone,
  readinessLabel,
  readinessTone,
  relativeTime,
  shortId,
} from "../../lib/format";
import { useNav } from "../../lib/nav";
import { useSkills } from "../../lib/queries";
import { tabKeyHandler } from "../../lib/tabs";
import { SkillReader } from "../reader/SkillReader";
import { ReviewDialog, type ReviewRequest } from "../review/ReviewDialog";
import { ChecksPanel } from "./ChecksPanel";
import { answerable, DeclareQuestion, MatchedReasons, ModuleExplanation, sentence } from "./Explain";
import { WorkflowPanel } from "./WorkflowPanel";

type Panel = "why" | "workflow" | "content" | "checks";

/** After installing: how the agent picks it up, in one sentence. */
function usageHint(r: Recommendation): string {
  const clients = clientsPhrase(r.installation?.clients ?? []);
  if (r.item.kind === "instructions") {
    return `Installed for ${clients}. Agents read it from AGENTS.md (Claude Code through CLAUDE.md) in new sessions.`;
  }
  const skillFile = r.installation?.files.find((f) => f.path.endsWith("/SKILL.md"))?.path;
  const folder = skillFile ? skillFile.replace(/\/SKILL\.md$/, "") : null;
  return `Installed for ${clients}. Start a new agent session in this project; the agent loads it${
    folder ? ` from ${folder}` : ""
  } when a task matches its description.`;
}

export function ItemDetailPane({
  overview,
  recommendation: r,
}: {
  overview: ProjectOverview;
  recommendation: Recommendation;
}) {
  const [panel, setPanel] = useState<Panel>("why");
  const [review, setReview] = useState<ReviewRequest | null>(null);
  const [showOtherModules, setShowOtherModules] = useState(false);
  const { navigate } = useNav();
  const { addSkills } = useActions();
  const [fullRules, setFullRules] = useState(false);
  const [contentFile, setContentFile] = useState<string | null>(null);
  const client = useQueryClient();
  const toast = useToast();
  const source = overview.sources.find((s) => s.id === r.item.sourceId);
  const isLocal = r.item.sourceId === "local";
  const mySkills = useSkills();
  const mine = isLocal
    ? (mySkills.data ?? []).find((s) => s.deletedAt === null && s.name === r.item.name)
    : undefined;
  const a = r.applicability;
  const multiModule = a.scope === "module" && a.modules.length > 1;
  const primaryModules = multiModule
    ? a.modules.filter((m) => m.applicability === a.applicability)
    : a.modules;
  const otherModules = multiModule ? a.modules.filter((m) => m.applicability !== a.applicability) : [];
  const questions = a.modules.flatMap((m) =>
    m.applicability === "needsInformation"
      ? [...answerable(m.applies), ...answerable(m.excludes)].map((q) => ({
          module: m.module,
          moduleName: m.moduleName,
          q,
        }))
      : [],
  );
  // Usually every question has the same cause (for example, an incomplete build); say it once.
  const reasons = [...new Set(questions.map(({ q }) => q.reason))];
  const sharedReason = reasons.length === 1 ? reasons[0] : null;
  const appliedNames = a.modules.filter((m) => m.applicability === "applies").map((m) => m.moduleName);

  const panels = [
    ["why", "Why this fits"],
    ...(r.item.hasWorkflow ? [["workflow", "Workflow"]] : []),
    ["content", "Content"],
    ...(r.item.hasChecks ? [["checks", "Checks"]] : []),
  ] as [Panel, string][];
  const onPanelKey = tabKeyHandler(
    panels.map(([id]) => id),
    panel,
    setPanel,
    (id) => `item-tab-${id}`,
  );

  const installRequest: ReviewRequest = {
    kind: "install",
    items: [{ sourceId: r.item.sourceId, itemId: r.item.id }],
    title: r.item.title,
  };
  const key = r.installation?.key;

  const missing = r.readiness.prerequisites.filter(
    (p) => p.status === "missing" || p.status === "notConfigured",
  );
  const missingMcp = missing.some((p) => p.kind === "mcp");
  const missingText =
    missing.length === 0
      ? "A prerequisite is missing. Installing still works; the agent may not be able to follow every step."
      : `Missing: ${missing.map((p) => (p.kind === "mcp" ? `MCP server ${p.name}` : p.name)).join(", ")}. ${
          missingMcp
            ? "Installing can add the suggested MCP configuration to this project."
            : "Installing still works; the agent may not be able to follow every step."
        }`;

  /** The questions live in "Why this fits"; bring them into view. */
  const showQuestions = () => {
    setPanel("why");
    window.setTimeout(() => {
      const target = document.getElementById("questions");
      if (!target) return;
      // Scroll only the nearest scrolling container, so the project header stays in place.
      let pane = target.parentElement;
      while (
        pane &&
        !(pane.scrollHeight > pane.clientHeight && /auto|scroll/.test(getComputedStyle(pane).overflowY))
      )
        pane = pane.parentElement;
      if (pane) {
        const top = target.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop;
        pane.scrollTo({ top: top - 16, behavior: "smooth" });
      } else {
        target.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      target.closest("section")?.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
    }, 0);
  };

  // The installed skill folder (".claude/skills/<name>"), preferring the copy
  // that holds this project's edits.
  const installedCopy =
    r.installation?.files.find((f) => f.state === "modified")?.path ?? r.installation?.files[0]?.path;
  const installedFolder = installedCopy ? installedCopy.split("/").slice(0, 3).join("/") : null;

  const shareImprovement = async () => {
    const folder = installedFolder;
    if (!folder) return;
    try {
      const draft = await api.startContribution(r.item.sourceId, {
        type: "projectSkill",
        projectId: overview.project.id,
        path: folder,
      });
      void client.invalidateQueries({ queryKey: ["contributions"] });
      navigate({ name: "contributions", contributionId: draft.id });
    } catch (e) {
      toast.show(e instanceof Error ? e.message : String(e), "danger");
    }
  };

  const primary = (() => {
    switch (r.nextAction) {
      case "install":
        return (
          <Button variant="primary" icon="download" onClick={() => setReview(installRequest)}>
            Review and install…
          </Button>
        );
      case "setUpPrerequisites":
        return (
          <>
            <Button
              variant="primary"
              icon="download"
              onClick={() => setReview({ ...installRequest, includeMcp: true })}
            >
              Review and install…
            </Button>
            <span className="action-note">
              <Icon name="warning" size={14} /> {missingText}
            </span>
          </>
        );
      case "update":
      case "resolveConflict":
        return key ? (
          <Button
            variant="primary"
            icon="refresh"
            onClick={() => setReview({ kind: "update", keys: [key], title: r.item.title })}
          >
            {r.nextAction === "update" ? "Review update…" : "Review update and conflicts…"}
          </Button>
        ) : null;
      case "provideInformation":
        return (
          <Button variant="primary" icon="question" onClick={showQuestions}>
            Answer what Habi couldn't establish
          </Button>
        );
      default:
        return null;
    }
  })();

  return (
    <article className="detail" aria-labelledby="detail-title">
      <header className="detail-head">
        <p className="detail-kicker">
          {kindLabel[r.item.kind]} · {r.item.sourceName}
          {r.item.owner ? ` · maintained by ${r.item.owner}` : ""}
          {r.item.requirement === "required" ? <Label tone="thread">Team requirement</Label> : null}
        </p>
        <h2 id="detail-title" className="detail-title">
          {r.item.title}
        </h2>
        <p className="detail-desc">{r.item.description}</p>

        <dl className="facets" aria-label="Status">
          <Facet
            label="Applicability"
            value={applicabilityLabel[a.applicability]}
            tone={applicabilityTone[a.applicability]}
            detail={
              a.applicability === "applies" && multiModule ? `in ${appliedNames.join(", ")}` : undefined
            }
          />
          <Facet
            label="Readiness"
            value={readinessLabel[r.readiness.state]}
            tone={readinessTone[r.readiness.state]}
          />
          <Facet
            label="Installation"
            value={installLabel[r.installState]}
            tone={installTone[r.installState]}
          />
          <Facet
            label="Evidence"
            value={evidenceLabel[r.evidence.state]}
            tone={evidenceTone[r.evidence.state]}
          />
        </dl>

        <div className="detail-actions">
          {primary}
          {r.installState === "notInstalled" &&
          r.item.installable &&
          (!primary || r.nextAction === "provideInformation") ? (
            <Button icon="download" onClick={() => setReview(installRequest)}>
              Install anyway…
            </Button>
          ) : null}
          {r.installState === "notInstalled" && !r.item.installable ? (
            <span className="action-note">
              <Icon name="warning" size={14} /> Cannot be installed: the package is incomplete or its SKILL.md
              name is not a valid folder name. Details are listed under its problems.
            </span>
          ) : null}
          {mine ? (
            <Button icon="pencil" onClick={() => navigate({ name: "skills", skillId: mine.id })}>
              Edit in My skills
            </Button>
          ) : null}
          {key && !isLocal && installedFolder && r.item.kind !== "instructions" ? (
            <Button
              icon="pencil"
              title="Copies the installed files, with this project's edits, to My skills. It stays linked to the library."
              onClick={() =>
                addSkills({ source: "project", projectId: overview.project.id, preselect: installedFolder })
              }
            >
              Edit a copy…
            </Button>
          ) : null}
          {key && !isLocal && (r.installState === "locallyModified" || r.installState === "conflict") ? (
            <Button icon="share" onClick={() => void shareImprovement()}>
              Share my edits with {r.item.sourceName}…
            </Button>
          ) : null}
          {key && r.installState !== "notInstalled" ? (
            <Button
              variant="quiet"
              icon="trash"
              onClick={() => setReview({ kind: "remove", keys: [key], title: r.item.title })}
            >
              Remove…
            </Button>
          ) : null}
        </div>
        {r.installation && r.installState === "current" ? (
          <p className="action-note">
            <Icon name="check" size={14} /> {usageHint(r)}
          </p>
        ) : null}
        {r.unmanagedCopies.length > 0 ? (
          <Notice tone="unknown" title="A copy already exists in this project">
            <span className="mono">{r.unmanagedCopies.join(", ")}</span> was not installed by Habi. Installing
            shows it as a conflict; nothing is replaced unless you choose to.
          </Notice>
        ) : null}
      </header>

      <div className="subtabs" role="tablist" aria-label="Item views">
        {panels.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`item-tab-${id}`}
            aria-selected={panel === id}
            aria-controls={`item-panel-${id}`}
            tabIndex={panel === id ? 0 : -1}
            className={`subtab${panel === id ? " is-active" : ""}`}
            onClick={() => setPanel(id)}
            onKeyDown={onPanelKey}
          >
            {label}
          </button>
        ))}
      </div>

      <div
        className="detail-body"
        role="tabpanel"
        id={`item-panel-${panel}`}
        aria-labelledby={`item-tab-${panel}`}
      >
        {panel === "why" && (
          <>
            <Section
              title={
                a.applicability === "applies"
                  ? "Why it fits"
                  : a.applicability === "undeclared"
                    ? "Matching"
                    : "What Habi found"
              }
              id="why"
            >
              <p className="why-summary">{a.reason}</p>
              {a.applicability === "undeclared" ? (
                <p className="muted">
                  {NO_RULES_PHRASE}. Habi does not guess from the title or text. You can still install it
                  deliberately{isLocal ? ", or add rules in My skills" : ""}.
                </p>
              ) : (
                <>
                  {primaryModules.map((m) => (
                    <div key={m.module} className="module-block">
                      {multiModule || a.scope === "repository" ? (
                        <h4 className="module-name">
                          {a.scope === "repository" ? "Across the repository" : m.moduleName}
                          {m.module !== "*" && m.module !== "." && m.module !== m.moduleName ? (
                            <span className="mono muted"> {m.module}</span>
                          ) : null}
                        </h4>
                      ) : null}
                      {a.applicability === "applies" && !fullRules ? (
                        <MatchedReasons match={m} overview={overview} />
                      ) : (
                        <ModuleExplanation match={m} overview={overview} />
                      )}
                    </div>
                  ))}
                  {a.applicability === "applies" ? (
                    <button
                      type="button"
                      className="link-btn rules-toggle"
                      aria-expanded={fullRules}
                      onClick={() => setFullRules((v) => !v)}
                    >
                      <Icon name={fullRules ? "chevronDown" : "chevronRight"} />
                      {fullRules ? "Show only what matched" : "Show how every rule was evaluated"}
                    </button>
                  ) : null}
                  {otherModules.length > 0 ? (
                    <div className="other-modules">
                      <button
                        type="button"
                        className="link-btn"
                        aria-expanded={showOtherModules}
                        onClick={() => setShowOtherModules((s) => !s)}
                      >
                        <Icon name={showOtherModules ? "chevronDown" : "chevronRight"} />
                        {showOtherModules ? "Hide" : "Show"} the other {otherModules.length} module
                        {otherModules.length === 1 ? "" : "s"}
                      </button>
                      {showOtherModules
                        ? otherModules.map((m) => (
                            <div key={m.module} className="module-block">
                              <h4 className="module-name">
                                {m.moduleName}{" "}
                                <Status tone={applicabilityTone[m.applicability]}>
                                  {applicabilityLabel[m.applicability]}
                                </Status>
                              </h4>
                              <ModuleExplanation match={m} overview={overview} />
                            </div>
                          ))
                        : null}
                    </div>
                  ) : null}
                </>
              )}
            </Section>

            {questions.length > 0 ? (
              <Section title="What Habi couldn't establish" id="questions">
                <p className="muted">
                  Habi will not treat missing evidence as a yes or a no. If you know, answer below — your
                  answer is stored on this machine, labelled as yours, and can be undone.
                </p>
                {sharedReason ? (
                  <p className="declare-reason">
                    <Icon name="question" size={14} /> Why Habi can't tell: {sentence(sharedReason)}
                  </p>
                ) : null}
                {questions.map(({ module, moduleName, q }) => (
                  <DeclareQuestion
                    key={`${module}-${q.kind}-${q.name}`}
                    overview={overview}
                    module={module}
                    moduleName={moduleName}
                    question={q}
                    showReason={!sharedReason}
                  />
                ))}
              </Section>
            ) : null}

            <Section title="Prerequisites" id="prereqs">
              {r.readiness.prerequisites.length === 0 ? (
                <p className="muted">None declared.</p>
              ) : (
                <ul className="prereqs">
                  {r.readiness.prerequisites.map((p) => (
                    <li key={`${p.kind}-${p.name}`} className="prereq">
                      <div className="prereq-head">
                        <span className="prereq-name">
                          {p.kind === "mcp" ? "MCP server " : ""}
                          {p.name}
                        </span>
                        <Status tone={prerequisiteTone[p.status]}>{prerequisiteLabel[p.status]}</Status>
                      </div>
                      {p.purpose ? <p className="muted">{p.purpose}</p> : null}
                      <p className="prereq-detail">{p.detail}</p>
                      {p.hint ? <p className="prereq-hint">{p.hint}</p> : null}
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section title="Evidence" id="evidence">
              {r.evidence.latestRun ? (
                <p>
                  Latest local check <strong>{r.evidence.latestRun.checkId}</strong>:{" "}
                  <Status tone={r.evidence.latestRun.status === "passed" ? "ok" : "danger"}>
                    {r.evidence.latestRun.status}
                  </Status>{" "}
                  <span className="muted">{relativeTime(r.evidence.latestRun.finishedAt)}</span>
                  {r.evidence.state === "stale" ? (
                    <span className="muted">
                      {" "}
                      — the item or project changed since, so it no longer counts.
                    </span>
                  ) : null}
                </p>
              ) : null}
              {r.evidence.declared.length === 0 && !r.evidence.latestRun ? (
                <p className="muted">No evidence recorded. That says nothing about quality either way.</p>
              ) : null}
              {r.evidence.declared.length > 0 ? (
                <>
                  <p className="muted">
                    Declared by the author. Habi shows these as written; it has not verified them.
                  </p>
                  <ul className="declared-evidence">
                    {r.evidence.declared.map((e, i) => (
                      <li key={i}>
                        <span className="mono">{e.date}</span>{" "}
                        <Status
                          tone={e.result === "passed" ? "ok" : e.result === "failed" ? "danger" : "unknown"}
                        >
                          {e.result}
                        </Status>
                        {e.environment ? <span className="muted"> · {e.environment}</span> : null}
                        {e.summary ? <p>{e.summary}</p> : null}
                        {e.by ? <p className="muted">by {e.by}</p> : null}
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </Section>

            <Section title="Source and scope" id="source">
              <dl className="meta-grid">
                <dt>Library</dt>
                <dd>
                  {r.item.sourceName}
                  {source && !isLocal ? <span className="muted"> · {freshnessText(source).text}</span> : null}
                  {isLocal ? <span className="muted"> · on this machine</span> : null}
                </dd>
                <dt>Version</dt>
                <dd className="mono">
                  {shortId(r.item.snapshot)}
                  {source?.commitSummary ? <span className="muted"> — {source.commitSummary}</span> : null}
                </dd>
                {r.installation ? (
                  <>
                    <dt>Installed</dt>
                    <dd>
                      <span className="mono">{shortId(r.installation.snapshot)}</span>{" "}
                      <span className="muted">{relativeTime(r.installation.installedAt)}</span>
                    </dd>
                  </>
                ) : null}
                <dt>Scope</dt>
                <dd>
                  {a.scope === "repository"
                    ? "Evaluated across the whole repository"
                    : "Evaluated per module"}
                </dd>
                <dt>Metadata</dt>
                <dd>
                  {r.item.metadataStatus === "declared"
                    ? "Habi metadata declared by the author"
                    : r.item.metadataStatus === "invalid"
                      ? "Habi metadata is invalid and was ignored"
                      : "Plain skill (no Habi metadata)"}
                  {r.item.diagnostics > 0 ? (
                    <span className="muted"> · {r.item.diagnostics} library notes</span>
                  ) : null}
                </dd>
                <dt>Limits</dt>
                <dd className="muted">
                  Habi read build manifests and file names. It did not run builds or read source code, and it
                  cannot see whether an agent loads or follows this content.
                </dd>
              </dl>
            </Section>
          </>
        )}
        {panel === "workflow" && (
          <WorkflowPanel
            recommendation={r}
            onRunCheck={() => setPanel("checks")}
            onInstall={
              r.installState === "notInstalled"
                ? () =>
                    setReview(
                      r.nextAction === "setUpPrerequisites"
                        ? { ...installRequest, includeMcp: true }
                        : installRequest,
                    )
                : undefined
            }
          />
        )}
        {panel === "content" && (
          <SkillReader
            sourceId={r.item.sourceId}
            itemId={r.item.id}
            file={contentFile}
            onFile={setContentFile}
            title={r.item.title}
          />
        )}
        {panel === "checks" && <ChecksPanel overview={overview} recommendation={r} />}
      </div>

      {review ? (
        <ReviewDialog projectId={overview.project.id} request={review} onClose={() => setReview(null)} />
      ) : null}
    </article>
  );
}
