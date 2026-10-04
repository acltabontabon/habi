/**
 * Review before any change: selected clients, every file that will
 * be created, modified or deleted (with diffs), conflicts that need a
 * decision, and how to undo. The final button names the exact action.
 */
import { keepPreviousData, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ChangeKind } from "../../bindings/ChangeKind";
import type { ChangeOp } from "../../bindings/ChangeOp";
import type { ClientId } from "../../bindings/ClientId";
import type { FileChange } from "../../bindings/FileChange";
import type { InstallShadow } from "../../bindings/InstallShadow";
import type { ItemRef } from "../../bindings/ItemRef";
import type { Plan } from "../../bindings/Plan";
import type { ProjectOverview } from "../../bindings/ProjectOverview";
import type { Resolution } from "../../bindings/Resolution";
import { Dialog } from "../../components/Dialog";
import { DiffStat, DiffView } from "../../components/DiffView";
import { Icon } from "../../components/Icon";
import { useToast } from "../../components/Toasts";
import { Button, ErrorNotice, Notice, Working } from "../../components/ui";
import { initialsOf, Strand, Swatch } from "../../components/Weave";
import { api, type Decisions, HabiError } from "../../lib/api";
import { useDyes } from "../../lib/dye";
import { ALL_CLIENTS, clientLabel, plural } from "../../lib/format";
import { copyState, precedenceNote } from "../../lib/machine";
import { beginOwnChange, endOwnChange, staleKey } from "../../lib/ownChanges";
import { invalidateProjectData, invalidateSkills, keys, useSources } from "../../lib/queries";

export type ReviewRequest =
  | {
      kind: "install";
      items: ItemRef[];
      title: string;
      includeMcp?: boolean;
      clients?: ClientId[];
      /** The library is not the team's own: installing on this machine carries a warning. */
      unaudited?: boolean;
    }
  | { kind: "update"; keys: string[]; title: string }
  | { kind: "remove"; keys: string[]; title: string }
  | { kind: "restore"; operationId: string; title: string };

const opLabel: Record<ChangeOp, string> = { create: "Create", modify: "Modify", delete: "Delete" };
const opGlyph: Record<ChangeOp, string> = { create: "+", modify: "~", delete: "−" };

const kindTitle: Record<ChangeKind, string> = {
  skillFile: "Skill files",
  instructionsSection: "Instructions",
  claudeBridge: "Claude Code bridge",
  geminiBridge: "Gemini CLI bridge",
  mcpConfig: "MCP configuration",
  lockFile: "Habi's record",
  restore: "Restored files",
};

type ChangeGroup = {
  key: string;
  title: string;
  /** The folder every file in the group shares. */
  dir: string;
  /** Said once, when every file in the group has the same reason. */
  why: string | null;
  /** Whether the reason is worth reading: skill files and Habi's own record explain themselves. */
  explain: boolean;
  rows: { change: FileChange; name: string }[];
};

function dirOf(path: string): string[] {
  return path.split("/").slice(0, -1);
}

/** Files that share a reason sit under one folder heading, so the folder and the reason are said once. */
export function groupChanges(changes: FileChange[]): ChangeGroup[] {
  const groups = new Map<string, FileChange[]>();
  for (const c of changes) {
    const key = `${c.kind}|${c.clients.join(",")}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  return [...groups.entries()].map(([key, list]) => {
    const [first, ...rest] = list.map((c) => dirOf(c.path)) as [string[], ...string[][]];
    let common = first;
    for (const d of rest) {
      let n = 0;
      while (n < common.length && n < d.length && common[n] === d[n]) n++;
      common = common.slice(0, n);
    }
    const head = list[0] as FileChange;
    const whys = new Set(list.map((c) => c.explanation).filter(Boolean));
    const rows = list
      .map((change) => ({ change, name: change.path.split("/").slice(common.length).join("/") }))
      // The skill's own file first, then whatever sits beside it.
      .sort((a, b) => Number(b.name === "SKILL.md") - Number(a.name === "SKILL.md"));
    return {
      key,
      title:
        head.kind === "skillFile" && head.clients.length > 0
          ? head.clients.map((c) => clientLabel[c]).join(", ")
          : kindTitle[head.kind],
      dir: common.length > 0 ? `${common.join("/")}/` : "",
      why: whys.size === 1 ? ([...whys][0] ?? null) : null,
      explain: head.kind !== "skillFile" && head.kind !== "lockFile",
      rows,
    };
  });
}

/** What a part of a skill is for, said for the tooltip; `null` when there is nothing useful to add. */
function folderPurpose(dir: string): string | null {
  const first = dir.replace(/\/$/, "").split("/")[0];
  switch (first) {
    case "references":
      return "Extra notes the skill loads only when it needs them.";
    case "agents":
      return "Settings for particular agents, shipped with the skill.";
    case "scripts":
      return "Helpers that ship with the skill. Habi copies them; it does not run them.";
    case "assets":
      return "Files the skill uses, such as templates.";
    default:
      return null;
  }
}

function filePurpose(change: FileChange, name: string): string | null {
  if (change.kind !== "skillFile") return change.explanation || null;
  if (name === "SKILL.md") return "The skill itself: what the agent reads and follows.";
  if (name === "habi.yaml") return "Habi's notes on the skill: when it applies and what it needs.";
  const inFolder = change.path.split("/").slice(-2, -1)[0];
  return (inFolder ? folderPurpose(inFolder) : null) ?? change.explanation ?? null;
}

function ChangeRow({
  change,
  name,
  why,
  nested = false,
}: {
  change: FileChange;
  name: string;
  why: boolean;
  nested?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li className={`change change-${change.op}${nested ? " is-nested" : ""}`}>
      <button
        type="button"
        className="change-head"
        aria-expanded={open}
        title={filePurpose(change, name) ? `${name} — ${filePurpose(change, name)}` : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={`change-op op-${change.op}`} title={opLabel[change.op]}>
          <span aria-hidden="true">{opGlyph[change.op]}</span>
          <span className="visually-hidden">{opLabel[change.op]}</span>
        </span>
        <span className="change-path mono">{name}</span>
        <DiffStat diff={change.diff} />
        <Icon name={open ? "chevronDown" : "chevronRight"} size={14} />
      </button>
      {why && change.explanation ? <p className="change-why">{change.explanation}</p> : null}
      {open ? <DiffView diff={change.diff} label={`Changes to ${change.path}`} /> : null}
    </li>
  );
}

/** A group longer than this shows only its first few files until asked for the rest. */
const COLLAPSE_OVER = 8;
const COLLAPSED_SHOWS = 5;

function folderTip(dir: string): string | undefined {
  const purpose = folderPurpose(dir);
  return purpose ? `${dir} — ${purpose}` : undefined;
}

type TreeEntry =
  | { kind: "dir"; dir: string }
  | { kind: "file"; change: FileChange; name: string; nested: boolean };

/**
 * The group's files in reading order: those beside the group's folder first,
 * then each subfolder named once above its files, so "references/" is not
 * repeated on every row.
 */
function treeEntries(rows: ChangeGroup["rows"]): TreeEntry[] {
  const split = rows.map((r) => {
    const parts = r.name.split("/");
    return { change: r.change, file: parts.pop() ?? r.name, dir: parts.join("/") };
  });
  const dirs = [...new Set(split.map((r) => r.dir).filter(Boolean))];
  return [
    ...split
      .filter((r) => !r.dir)
      .map((r): TreeEntry => ({ kind: "file", change: r.change, name: r.file, nested: false })),
    ...dirs.flatMap((dir): TreeEntry[] => [
      { kind: "dir", dir: `${dir}/` },
      ...split
        .filter((r) => r.dir === dir)
        .map((r): TreeEntry => ({ kind: "file", change: r.change, name: r.file, nested: true })),
    ]),
  ];
}

function ChangeGroupView({ group: g }: { group: ChangeGroup }) {
  const [all, setAll] = useState(false);
  const long = g.rows.length > COLLAPSE_OVER;
  const entries = treeEntries(g.rows);
  // Collapsed, count files only; a folder name stays only above a file that is still shown.
  let shown = 0;
  const visible =
    long && !all
      ? entries.filter((e, i) => {
          if (e.kind === "file") return ++shown <= COLLAPSED_SHOWS;
          return shown < COLLAPSED_SHOWS && entries[i + 1]?.kind === "file";
        })
      : entries;
  return (
    <section className="change-group" aria-label={g.title}>
      <header className="change-group-head" title={g.why ? `${g.title} — ${g.why}` : undefined}>
        <h4 className="change-group-title">{g.title}</h4>
        {g.dir ? <span className="change-group-dir mono">{g.dir}</span> : null}
      </header>
      {g.why && g.explain ? <p className="change-group-why">{g.why}</p> : null}
      <ul className="changes">
        {visible.map((e) =>
          e.kind === "dir" ? (
            <li key={`dir:${e.dir}`} className="change-dir mono" title={folderTip(e.dir)}>
              {e.dir}
            </li>
          ) : (
            <ChangeRow
              key={e.change.path}
              change={e.change}
              name={e.name}
              nested={e.nested}
              why={g.why === null}
            />
          ),
        )}
        {long ? (
          <li className="change change-more">
            <button
              type="button"
              className="change-more-btn"
              aria-expanded={all}
              onClick={() => setAll(!all)}
            >
              <Icon name={all ? "chevronDown" : "chevronRight"} size={14} />
              {all ? "Show fewer" : `Show ${g.rows.length - COLLAPSED_SHOWS} more files`}
            </button>
          </li>
        ) : null}
      </ul>
    </section>
  );
}

export function ChangeTree({ changes }: { changes: FileChange[] }) {
  return (
    <div className="change-tree">
      {groupChanges(changes).map((g) => (
        <ChangeGroupView key={g.key} group={g} />
      ))}
    </div>
  );
}

/** Projects that already hold the skill, and which copy each agent would use. */
function ShadowNotice({ shadows }: { shadows: InstallShadow[] }) {
  const copies = shadows.flatMap((s) => s.copies.map((c) => ({ skill: s, copy: c })));
  if (copies.length === 0) return null;
  return (
    <Notice tone="warn" title="Projects that already have this skill">
      <ul className="review-notes">
        {copies.map(({ skill, copy }) => (
          <li key={`${skill.name}:${copy.projectId}:${copy.path}`}>
            <strong>{copy.projectName}</strong> <span className="mono">{copy.path}</span> · {copyState(copy)}.{" "}
            {precedenceNote(copy) ?? "No agent reads both, so neither hides the other."}
          </li>
        ))}
      </ul>
    </Notice>
  );
}

/**
 * A library that is not the team's own is stitched, not solid. On this machine
 * its skill is read in every project, so it says so; it does not stop the install,
 * because the files it would write are on screen to be read.
 */
function AuditWarning() {
  return (
    <p className="audit-warning">
      <Icon name="warning" size={16} />
      <span>
        <strong>Not audited.</strong> Every project's agents will read it.
      </span>
    </p>
  );
}

export function ReviewDialog({
  projectId,
  request,
  onClose,
}: {
  /** The project to change, or `null` for the person's own skill folders ("this machine"). */
  projectId: string | null;
  request: ReviewRequest;
  onClose: () => void;
}) {
  const machine = projectId === null;
  const sources = useSources();
  const dyeOf = useDyes();
  const client = useQueryClient();
  const toast = useToast();
  const [clients, setClients] = useState<ClientId[] | null>(
    request.kind === "install" ? (request.clients ?? null) : null,
  );
  const [includeMcp, setIncludeMcp] = useState(
    request.kind === "install" ? (request.includeMcp ?? false) : false,
  );
  // An update does not add MCP servers an item suggests only now, unless asked.
  const [addMcp, setAddMcp] = useState(false);
  const [decisions, setDecisions] = useState<Decisions>({});
  const [applyError, setApplyError] = useState<unknown>(null);
  const [applying, setApplying] = useState(false);
  // At least one agent is always picked: the last one cannot be unticked, so there is never an empty preview.
  // Preselected: the agents the project (or this machine) already shows signs of using.
  const detected = useQuery({
    queryKey: ["detectedClients", projectId],
    queryFn: () => api.detectedClients(projectId),
    retry: false,
  });
  const detecting = clients === null && detected.isPending;
  const found = detected.data ?? [];
  const chosen: ClientId[] = clients ?? (found.length > 0 ? found : ["claude-code"]);
  const unaudited = machine && request.kind === "install" && request.unaudited === true;

  // What a machine install would sit next to: projects that already hold the skill.
  const shadows = useQuery({
    queryKey: ["machineShadows", request.kind === "install" ? request.items : null, chosen],
    enabled: machine && request.kind === "install" && chosen.length > 0 && !detecting,
    retry: false,
    queryFn: () => api.machineInstallPreview(request.kind === "install" ? request.items : [], chosen),
  });

  // The MCP option only does something for a skill that names a server it needs.
  const wanted = request.kind === "install" && !machine ? request.items : [];
  const overview = useQuery<ProjectOverview>({
    queryKey: keys.overview(projectId ?? ""),
    queryFn: () => api.projectOverview(projectId ?? "", false),
    enabled: wanted.length > 0,
    staleTime: 60_000,
    retry: false,
  });
  const readinessWarnings = wanted.flatMap((ref) => {
    const r = overview.data?.recommendations.find(
      (r) => r.item.sourceId === ref.sourceId && r.item.id === ref.itemId,
    );
    return chosen.flatMap((agent) => {
      const readiness = r?.readiness.byClient?.find((c) => c.client === agent);
      if (!readiness) return [];
      const missing = readiness.prerequisites.filter(
        (p) =>
          p.status === "missing" ||
          p.status === "unknown" ||
          (p.status === "notConfigured" && !(includeMcp && p.hint)),
      );
      return missing.length > 0
        ? [
            {
              key: `${ref.sourceId}/${ref.itemId}/${agent}`,
              title: `${r?.item.title} for ${clientLabel[agent]}`,
              detail: missing.map((p) => `${p.name}: ${p.detail}`).join(" "),
            },
          ]
        : [];
    });
  });
  const libraries = useQueries({
    queries: [...new Set(wanted.map((r) => r.sourceId))].map((sourceId) => ({
      queryKey: keys.library(sourceId),
      queryFn: () => api.library(sourceId),
    })),
  });
  const asksMcp = wanted.some((ref) =>
    libraries.some(
      (l) =>
        l.data?.sourceId === ref.sourceId &&
        l.data.items.some((i) => i.id === ref.itemId && i.mcp.length > 0),
    ),
  );

  const plan = useQuery<Plan>({
    queryKey: ["plan", projectId, request, chosen, includeMcp, addMcp, decisions],
    enabled: request.kind !== "install" || (chosen.length > 0 && !detecting),
    retry: false,
    gcTime: 0,
    // Choosing a conflict option or a client re-plans; keep showing the
    // current preview (and the focused radio) until the new one arrives.
    placeholderData: keepPreviousData,
    queryFn: () => {
      switch (request.kind) {
        case "install":
          return projectId === null
            ? api.planInstallMachine(request.items, chosen, decisions)
            : api.planInstall(projectId, request.items, chosen, includeMcp, decisions);
        case "update":
          return projectId === null
            ? api.planUpdateMachine(request.keys, decisions)
            : api.planUpdate(projectId, request.keys, addMcp, decisions);
        case "remove":
          return projectId === null
            ? api.planRemoveMachine(request.keys, decisions)
            : api.planRemove(projectId, request.keys, decisions);
        case "restore":
          return projectId === null
            ? api.planRestoreMachine(request.operationId, decisions)
            : api.planRestore(projectId, request.operationId, decisions);
      }
    },
  });

  const toggleClient = (c: ClientId) => {
    const next = chosen.includes(c) ? chosen.filter((x) => x !== c) : [...chosen, c];
    setClients(ALL_CLIENTS.filter((x) => next.includes(x)));
  };

  const decide = (path: string, resolution: Resolution) =>
    setDecisions((d) => ({ ...d, [path]: resolution }));

  const apply = async (p: Plan) => {
    setApplying(true);
    setApplyError(null);
    if (projectId !== null) beginOwnChange(projectId);
    try {
      const op = await api.applyPlan(p.id);
      if (projectId !== null) {
        // These are Habi's own writes, not outside changes to warn about.
        client.setQueryData(staleKey(projectId), null);
        invalidateProjectData(client, projectId);
        toast.show(
          `${p.title}: done (${plural(op.files.length, "file")}). You can restore it from Installed & history.`,
        );
      } else {
        // A skill on this machine can change what any project's agents read.
        invalidateSkills(client);
        invalidateProjectData(client);
        toast.show(
          `${p.title}: done (${plural(op.files.length, "file")}). Restore it from On this machine → History and restore.`,
        );
      }
      onClose();
    } catch (e) {
      setApplyError(e);
      // A stale or used plan cannot be retried; fetch a fresh preview.
      void plan.refetch();
    } finally {
      if (projectId !== null) endOwnChange(projectId);
      setApplying(false);
    }
  };

  const p = plan.data;
  const unresolved = p ? p.conflicts.filter((c) => c.options.length > 0 && !decisions[c.path]).length : 0;
  const keepLabel =
    request.kind === "remove"
      ? "Keep my file"
      : request.kind === "restore"
        ? "Keep the current file"
        : "Keep mine";
  const overwriteLabel =
    request.kind === "remove"
      ? "Delete it anyway"
      : request.kind === "restore"
        ? "Restore over it"
        : p?.items.every((i) => i.source === "My skills")
          ? "Use the version from My skills"
          : "Use the team version";

  // The agents are ticked beside the button and the project is the page it came from, so an install
  // says only what is not obvious; the full wording stays as the hover title.
  const confirmLabel = (plan: Plan) =>
    request.kind === "install" ? (machine ? "Install on this machine" : "Install") : plan.title;

  const titles: Record<ReviewRequest["kind"], string> = {
    install: `Install ${request.title}`,
    update: `Update ${request.title}`,
    remove: `Remove ${request.title}`,
    restore: `Restore: ${request.title}`,
  };

  const installing = request.kind === "install";
  const only = p && p.items.length === 1 ? p.items[0] : undefined;
  // The skill's own cloth, known before the preview arrives: its library's dye, its initials.
  const mark =
    installing && request.items.length === 1 ? (
      <Swatch
        dyes={[dyeOf((request.items[0] as ItemRef).sourceId)]}
        seed={(request.items[0] as ItemRef).itemId}
        size={44}
        initials={initialsOf(request.title)}
      />
    ) : undefined;
  const sourceDye = (name: string) => {
    const source = sources.data?.find((x) => x.name === name);
    return dyeOf(source?.id ?? "local");
  };

  const setup = installing ? (
    <aside className="review-setup">
      <fieldset className="clients">
        <legend className="review-heading">Install for</legend>
        <div className="agent-list">
          {ALL_CLIENTS.map((c) => (
            <label key={c} className="agent-pick">
              <input
                type="checkbox"
                checked={chosen.includes(c)}
                disabled={chosen.length === 1 && chosen.includes(c)}
                title={chosen.length === 1 && chosen.includes(c) ? "At least one agent" : undefined}
                onChange={() => toggleClient(c)}
              />
              <span className="agent-face">
                <span className="agent-tick" aria-hidden="true">
                  <Icon name="check" size={12} />
                </span>
                <strong>{clientLabel[c]}</strong>
              </span>
            </label>
          ))}
        </div>
        {asksMcp ? (
          <label className="check mcp-option" title="Only servers the item needs; no secrets are written.">
            <input type="checkbox" checked={includeMcp} onChange={(e) => setIncludeMcp(e.target.checked)} />
            <span>
              <strong>Add suggested MCP configuration</strong>
            </span>
          </label>
        ) : null}
      </fieldset>

      {readinessWarnings.map((w) => (
        <Notice key={w.key} tone="warn" title={w.title}>
          {w.detail} Installing still works, but the agent may not be able to follow every step.
        </Notice>
      ))}

      {unaudited ? <AuditWarning /> : null}
    </aside>
  ) : null;

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        // A plan being applied finishes first; closing would hide its outcome.
        if (!o && !applying) onClose();
      }}
      title={titles[request.kind]}
      mark={mark}
      description={
        only ? (
          <>
            from {only.source} · <span className="mono">{only.version}</span>
          </>
        ) : undefined
      }
      wide
      steady={installing}
      footer={
        <>
          <Button variant="quiet" onClick={onClose} disabled={applying}>
            Cancel
          </Button>
          {p && p.changes.length > 0 ? (
            <Button
              variant={request.kind === "remove" ? "danger" : "primary"}
              title={p.title}
              // While the preview for new choices loads, the shown plan is the old one: the button is
              // busy until the matching preview arrives, so a click never applies other choices.
              busy={applying || plan.isPlaceholderData}
              disabled={unresolved > 0 || p.conflicts.some((c) => c.options.length === 0)}
              onClick={() => {
                if (!plan.isPlaceholderData) void apply(p);
              }}
            >
              {confirmLabel(p)}
            </Button>
          ) : null}
        </>
      }
    >
      <div className="review-frame">
        <div className={`review-layout${setup ? " has-setup" : ""}`}>
          {setup}
          <div className={`review-main${plan.isFetching && !plan.isPending ? " is-updating" : ""}`}>
            {machine && installing ? <ShadowNotice shadows={shadows.data ?? []} /> : null}

            {plan.isPending ? <Working>Preparing the preview…</Working> : null}
            {plan.isError ? (
              <ErrorNotice error={plan.error} title="Habi could not prepare this change" />
            ) : null}
            {applyError ? (
              <ErrorNotice
                error={applyError}
                title={
                  applyError instanceof HabiError && applyError.code === "stalePlan"
                    ? machine
                      ? "Your skill folders changed"
                      : "The project changed"
                    : "Not applied"
                }
              />
            ) : null}

            {p ? (
              <div className="review">
                {p.items.length > 1 ? (
                  <ul className="review-items">
                    {p.items.map((i) => (
                      <li key={i.key}>
                        <Strand dye={sourceDye(i.source)} size={14} />
                        <strong>{i.title}</strong>
                        <span className="muted">
                          from {i.source} · <span className="mono">{i.version}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}

                {p.conflicts.length > 0 ? (
                  <section className="review-conflicts" aria-labelledby="conflicts-title">
                    <h3 id="conflicts-title" className="review-heading">
                      {plural(p.conflicts.length, "decision")} needed
                    </h3>
                    {p.conflicts.map((c) => (
                      <div key={`${c.path}-${c.kind}`} className="conflict">
                        <p>
                          <span className="mono">{c.path}</span> — {c.message}
                        </p>
                        {c.options.length > 0 ? (
                          <div
                            className="conflict-options"
                            role="radiogroup"
                            aria-label={`Decision for ${c.path}`}
                          >
                            {c.options.map((o) => (
                              <label key={o} className="radio">
                                <input
                                  type="radio"
                                  name={`conflict-${c.path}`}
                                  checked={decisions[c.path] === o}
                                  onChange={() => decide(c.path, o)}
                                />
                                {o === "keep" ? keepLabel : overwriteLabel}
                              </label>
                            ))}
                          </div>
                        ) : (
                          <p className="muted">Fix this by hand, then reopen this preview.</p>
                        )}
                        {c.diff ? (
                          <details>
                            <summary>Compare with what is on disk</summary>
                            <DiffView diff={c.diff} label={`Difference for ${c.path}`} />
                          </details>
                        ) : null}
                      </div>
                    ))}
                  </section>
                ) : null}

                {p.changes.length === 0 && p.conflicts.length === 0 ? (
                  <Notice tone="ok" title="Nothing to change">
                    {machine
                      ? "Your skill folders already match. Installing again would not modify any file."
                      : "The project already matches. Installing again would not modify any file."}
                  </Notice>
                ) : null}

                {p.mcpSuggestions.length > 0 ? (
                  <section aria-labelledby="mcp-title">
                    <h3 id="mcp-title" className="review-heading">
                      New MCP {p.mcpSuggestions.length === 1 ? "server" : "servers"}
                    </h3>
                    <label
                      className="check mcp-option"
                      title="Only the servers listed here; no secrets are written."
                    >
                      <input type="checkbox" checked={addMcp} onChange={(e) => setAddMcp(e.target.checked)} />
                      <span>
                        <strong>Add the suggested MCP configuration</strong>
                        <ul className="review-notes">
                          {p.mcpSuggestions.map((s) => (
                            <li key={`${s.item}-${s.server}`}>
                              <span className="mono">{s.server}</span>
                              <span className="muted"> · suggested by {s.item} since you installed it</span>
                            </li>
                          ))}
                        </ul>
                      </span>
                    </label>
                  </section>
                ) : null}

                {p.changes.length > 0 ? (
                  <section aria-labelledby="changes-title">
                    <h3 id="changes-title" className="review-heading">
                      {plural(p.changes.length, "file")} will change
                    </h3>
                    <ChangeTree changes={p.changes} />
                  </section>
                ) : null}

                {p.notes.length > 0 ? (
                  <section aria-labelledby="notes-title">
                    <h3 id="notes-title" className="review-heading">
                      Notes
                    </h3>
                    <ul className="review-notes">
                      {p.notes.map((n) => (
                        <li key={n}>{n}</li>
                      ))}
                    </ul>
                  </section>
                ) : null}

                {/* Only when something is replaced or deleted: a plain install has nothing to get back. */}
                {p.changes.some((c) => c.op !== "create") ? (
                  <p className="recovery">
                    <Icon name="history" size={14} /> {p.recovery}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </Dialog>
  );
}
