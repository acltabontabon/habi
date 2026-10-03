/**
 * Review before any change: selected clients and scope, every file that will
 * be created, modified or deleted (with diffs), conflicts that need a
 * decision, and how to undo. The final button names the exact action.
 */
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ChangeOp } from "../../bindings/ChangeOp";
import type { ClientId } from "../../bindings/ClientId";
import type { FileChange } from "../../bindings/FileChange";
import type { InstallShadow } from "../../bindings/InstallShadow";
import type { ItemRef } from "../../bindings/ItemRef";
import type { Plan } from "../../bindings/Plan";
import type { Resolution } from "../../bindings/Resolution";
import { Dialog } from "../../components/Dialog";
import { DiffStat, DiffView } from "../../components/DiffView";
import { Icon } from "../../components/Icon";
import { useToast } from "../../components/Toasts";
import { Button, ErrorNotice, Notice, Working } from "../../components/ui";
import { api, type Decisions, HabiError } from "../../lib/api";
import { ALL_CLIENTS, clientLabel, plural } from "../../lib/format";
import { copyState, precedenceNote } from "../../lib/machine";
import { beginOwnChange, endOwnChange, staleKey } from "../../lib/ownChanges";
import { invalidateProjectData, invalidateSkills, useSettings } from "../../lib/queries";

export type ReviewRequest =
  | {
      kind: "install";
      items: ItemRef[];
      title: string;
      includeMcp?: boolean;
      /** The library is not the team's own: installing on this machine needs a tick. */
      unaudited?: boolean;
    }
  | { kind: "update"; keys: string[]; title: string }
  | { kind: "remove"; keys: string[]; title: string }
  | { kind: "restore"; operationId: string; title: string };

const clientWhere: Record<ClientId, string> = {
  "claude-code": "reads .claude/skills and CLAUDE.md",
  cursor: "reads .agents/skills (or .claude/skills) and AGENTS.md",
  codex: "reads .agents/skills and AGENTS.md",
};

/** On this machine only skills are written, so only the skill folders are named. */
const clientWhereOnMachine: Record<ClientId, string> = {
  "claude-code": "reads ~/.claude/skills",
  cursor: "reads ~/.agents/skills (or ~/.claude/skills)",
  codex: "reads ~/.agents/skills",
};

const opLabel: Record<ChangeOp, string> = { create: "Create", modify: "Modify", delete: "Delete" };

function ChangeRow({ change }: { change: FileChange }) {
  const [open, setOpen] = useState(false);
  return (
    <li className={`change change-${change.op}`}>
      <button type="button" className="change-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name={open ? "chevronDown" : "chevronRight"} />
        <span className={`change-op op-${change.op}`}>{opLabel[change.op]}</span>
        <span className="change-path mono">{change.path}</span>
        <DiffStat diff={change.diff} />
      </button>
      {change.explanation ? <p className="change-why">{change.explanation}</p> : null}
      {open ? <DiffView diff={change.diff} label={`Changes to ${change.path}`} /> : null}
    </li>
  );
}

/**
 * What a global install changes that a project install does not: it is read in
 * every project, it can outrank a project's own copy, and a library that is not
 * the team's own needs an explicit tick.
 */
function MachineWarnings({
  shadows,
  unaudited,
  understood,
  onUnderstood,
}: {
  shadows: InstallShadow[];
  unaudited: boolean;
  understood: boolean;
  onUnderstood: (understood: boolean) => void;
}) {
  const copies = shadows.flatMap((s) => s.copies.map((c) => ({ skill: s, copy: c })));
  return (
    <div className="machine-warnings">
      {copies.length > 0 ? (
        <Notice tone="warn" title="Projects that already have this skill">
          <ul className="review-notes">
            {copies.map(({ skill, copy }) => (
              <li key={`${skill.name}:${copy.projectId}:${copy.path}`}>
                <strong>{copy.projectName}</strong> <span className="mono">{copy.path}</span> ·{" "}
                {copyState(copy)}.{" "}
                {precedenceNote(copy) ?? "No agent reads both, so neither hides the other."}
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}
      {unaudited ? (
        <label className="check machine-tick">
          <input type="checkbox" checked={understood} onChange={(e) => onUnderstood(e.target.checked)} />
          <span>
            <strong>This library is not audited.</strong>{" "}
            <span className="muted">
              I understand the skill will be read by my agents in every project, and that I have not reviewed
              it.
            </span>
          </span>
        </label>
      ) : null}
    </div>
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
  const settings = useSettings();
  const client = useQueryClient();
  const toast = useToast();
  const [clients, setClients] = useState<ClientId[] | null>(null);
  const [includeMcp, setIncludeMcp] = useState(
    request.kind === "install" ? (request.includeMcp ?? false) : false,
  );
  const [decisions, setDecisions] = useState<Decisions>({});
  const [applyError, setApplyError] = useState<unknown>(null);
  const [applying, setApplying] = useState(false);
  const [understood, setUnderstood] = useState(false);
  const chosen = clients ?? settings.data?.defaultClients ?? ["claude-code"];
  const needsTick = machine && request.kind === "install" && request.unaudited === true;

  // What a machine install would sit next to: projects that already hold the skill.
  const shadows = useQuery({
    queryKey: ["machineShadows", request.kind === "install" ? request.items : null, chosen],
    enabled: machine && request.kind === "install" && chosen.length > 0,
    retry: false,
    queryFn: () => api.machineInstallPreview(request.kind === "install" ? request.items : [], chosen),
  });

  const plan = useQuery<Plan>({
    queryKey: ["plan", projectId, request, chosen, includeMcp, decisions],
    enabled: request.kind !== "install" || chosen.length > 0,
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
            : api.planUpdate(projectId, request.keys, decisions);
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
        toast.show(`${p.title}: done (${plural(op.files.length, "file")}).`);
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

  const titles: Record<ReviewRequest["kind"], string> = {
    install: `Install ${request.title}`,
    update: `Update ${request.title}`,
    remove: `Remove ${request.title}`,
    restore: `Restore: ${request.title}`,
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        // A plan being applied finishes first; closing would hide its outcome.
        if (!o && !applying) onClose();
      }}
      title={titles[request.kind]}
      description="Nothing changes until you confirm below."
      wide
      footer={
        <>
          <Button variant="quiet" onClick={onClose} disabled={applying}>
            Cancel
          </Button>
          {p && p.changes.length > 0 ? (
            <Button
              variant={request.kind === "remove" ? "danger" : "primary"}
              busy={applying}
              disabled={
                unresolved > 0 ||
                p.conflicts.some((c) => c.options.length === 0) ||
                plan.isFetching ||
                (needsTick && !understood)
              }
              onClick={() => void apply(p)}
            >
              {p.title}
            </Button>
          ) : null}
        </>
      }
    >
      {request.kind === "install" ? (
        <fieldset className="clients">
          <legend className="field-label">Install for</legend>
          {ALL_CLIENTS.map((c) => (
            <label key={c} className="check">
              <input type="checkbox" checked={chosen.includes(c)} onChange={() => toggleClient(c)} />
              <span>
                <strong>{clientLabel[c]}</strong>{" "}
                <span className="muted">— {(machine ? clientWhereOnMachine : clientWhere)[c]}</span>
              </span>
            </label>
          ))}
          {machine ? null : (
            <label className="check">
              <input type="checkbox" checked={includeMcp} onChange={(e) => setIncludeMcp(e.target.checked)} />
              <span>
                <strong>Add suggested MCP configuration</strong>{" "}
                <span className="muted">
                  — only for servers the item requires and your project lacks; no secrets are written
                </span>
              </span>
            </label>
          )}
          <p className="muted scope-note">
            <Icon name="folder" size={14} />{" "}
            {machine
              ? "Scope: every project on this machine. The skill goes in your own agent folders, and Habi changes no agent settings."
              : "Scope: this project only. Habi does not change your global agent settings."}
          </p>
        </fieldset>
      ) : null}

      {machine && request.kind === "install" ? (
        <MachineWarnings
          shadows={shadows.data ?? []}
          unaudited={needsTick}
          understood={understood}
          onUnderstood={setUnderstood}
        />
      ) : null}

      {plan.isPending && chosen.length > 0 ? <Working>Preparing the preview…</Working> : null}
      {plan.isPlaceholderData && plan.isFetching ? <Working>Updating the preview…</Working> : null}
      {request.kind === "install" && chosen.length === 0 ? (
        <Notice tone="unknown">Choose at least one client.</Notice>
      ) : null}
      {plan.isError ? <ErrorNotice error={plan.error} title="Habi could not prepare this change" /> : null}
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
          <p className="review-project">
            <Icon name="folder" size={14} /> {machine ? <span>This machine · </span> : null}
            <span className="mono">{p.project}</span>
          </p>
          {p.items.length > 0 ? (
            <ul className="review-items">
              {p.items.map((i) => (
                <li key={i.key}>
                  <strong>{i.title}</strong>{" "}
                  <span className="muted">
                    from {i.source} · {i.version}
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
                    <div className="conflict-options" role="radiogroup" aria-label={`Decision for ${c.path}`}>
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

          {p.changes.length > 0 ? (
            <section aria-labelledby="changes-title">
              <h3 id="changes-title" className="review-heading">
                {plural(p.changes.length, "file")} will change
              </h3>
              <ul className="changes">
                {p.changes.map((c) => (
                  <ChangeRow key={c.path} change={c} />
                ))}
              </ul>
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

          {p.changes.length > 0 ? (
            <p className="recovery">
              <Icon name="history" size={14} /> {p.recovery}
            </p>
          ) : null}
        </div>
      ) : null}
    </Dialog>
  );
}
