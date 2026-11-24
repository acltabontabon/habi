/**
 * On this machine: skills kept in the person's own folders (`~/.claude/skills`
 * and the like), and the agents and tools Habi installed there. They sit apart
 * from My skills because they are not Habi's to edit: the agents own those
 * files. A skill found here can be copied into My skills or into a project
 * through the usual reviewed install, and the original is never touched. What
 * Habi itself installed can be updated and removed, each through its review. Where a project holds a copy too, the row says which one a client
 * will use. Skills whose library has a newer version come first, with a
 * filter to see only those. As its own page it always shows; elsewhere,
 * nothing is shown when there are no such skills.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { ImportFrom } from "../../bindings/ImportFrom";
import type { LocalSkill } from "../../bindings/LocalSkill";
import { AgentReach } from "../../components/AgentReach";
import { Dialog } from "../../components/Dialog";
import { Icon } from "../../components/Icon";
import { Loom } from "../../components/Loom";
import { Menu } from "../../components/Menu";
import { Button, ErrorNotice, Status, Working } from "../../components/ui";
import { useActions } from "../../lib/actions";
import { api } from "../../lib/api";
import { clientLabel, kindLabel, plural } from "../../lib/format";
import {
  copyState,
  groupMachineSkills,
  hasUpdate,
  homeMention,
  installedClients,
  type MachineGroup,
  precedenceNote,
} from "../../lib/machine";
import { useNav } from "../../lib/nav";
import {
  invalidateSkills,
  useMachineHistory,
  useMachineInstallations,
  useMachineSkills,
} from "../../lib/queries";
import { purpose } from "../../lib/skills";
import { History } from "../project/History";
import { ReviewDialog, type ReviewRequest } from "../review/ReviewDialog";
import { UseSkillDialog } from "./UseSkillDialog";

/** What Habi says about a skill it installed here, beyond where it came from. */
const managedState: Record<string, string> = {
  updateAvailable: "update available",
  locallyModified: "edited here",
  conflict: "edited here, and the library changed",
  sourceUnavailable: "library not connected",
};

/** Which agent tools see the skill; hovering one names the folder it reads. */
function Reach({ group }: { group: MachineGroup }) {
  const managed = group.copies.some((s) => s.managed);
  const selected = managed ? installedClients(group.copies) : group.readers;
  const shared = group.readers.filter((c) => !selected.includes(c));
  return (
    <>
      <AgentReach
        lit={selected}
        label={managed ? "Installed for" : "Read by"}
        tip={(c, on) => {
          const from = group.copies.filter((s) => s.readers.includes(c)).map((s) => s.location);
          return on
            ? `${managed ? "Installed for" : "Read by"} ${clientLabel[c]} · ${from.join(" and ")}`
            : from.length > 0
              ? `Not selected for installation. ${clientLabel[c]} can also read ${from.join(" and ")}`
              : `${clientLabel[c]} does not read these folders`;
        }}
      />
      {shared.length > 0 ? (
        <p className="mach-shared">
          Shared folders also make this available to {shared.map((c) => clientLabel[c]).join(", ")}.
        </p>
      ) : null}
    </>
  );
}

function Row({
  group,
  busy,
  onAdd,
  onOpen,
  onUse,
  onReview,
}: {
  group: MachineGroup;
  busy: boolean;
  onAdd: () => void;
  onOpen: (id: string) => void;
  onUse: () => void;
  onReview: (request: ReviewRequest) => void;
}) {
  const s = group.skill;
  const copies = group.inProjects;
  const mention = homeMention(group);
  const blocked = !s.complete;
  const managed = group.copies.find((c) => c.managed)?.managed ?? null;
  return (
    <li className="mach-item">
      <div className="mach-main">
        <span className="mach-title">
          {s.name}
          <span className="mach-tag">{managed ? "Installed by Habi" : "Global"}</span>
          {group.isLink ? <span className="mach-tag">Link</span> : null}
          {managed && managedState[managed.state] ? (
            <span className="mach-tag is-state">{managedState[managed.state]}</span>
          ) : null}
        </span>
        <span className="mys-purpose">
          {s.description ? purpose(s.description) : <span className="mys-none">No purpose yet</span>}
        </span>
        <Reach group={group} />
        <details className="mach-locations">
          <summary>
            {managed ? `From ${managed.library} · ` : ""}
            {plural(group.copies.length, "folder")}
          </summary>
          {group.copies.map((copy) => (
            <div className="mono" key={copy.id}>
              {copy.location}
            </div>
          ))}
        </details>
        {copies.map((c) => (
          <span key={`${c.projectId}:${c.path}`} className="mach-note">
            <span>
              Also in <strong>{c.projectName}</strong> <span className="mono">{c.path}</span> · {copyState(c)}
            </span>
            {precedenceNote(c) ? <span className="mach-precedence">{precedenceNote(c)}</span> : null}
          </span>
        ))}
        {mention ? (
          <span className="mach-note">
            <Status tone="warn">Mentions a home folder</Status>
            <span className="mono">{mention}</span>
          </span>
        ) : null}
        {blocked ? (
          <span className="mach-note field-problem">
            Some of its files cannot be copied, so Habi will not import it.
          </span>
        ) : null}
      </div>
      {/* One quiet control per row: the list is what is here, and what to do with it is a click away. */}
      <span className="mach-acts">
        {busy ? (
          <span className="mach-busy" role="status" aria-label={`Copying ${s.name} into My skills`}>
            <Loom />
          </span>
        ) : null}
        <Menu
          label={`More for ${s.name}`}
          items={[
            [
              group.importedAs
                ? {
                    label: "Open my copy",
                    hint: "In My skills",
                    icon: "pencil",
                    onSelect: () => onOpen(group.importedAs ?? ""),
                  }
                : {
                    label: "Add to My skills",
                    hint: blocked ? "Some files can’t be copied" : "An editable copy",
                    icon: "plus",
                    disabled: blocked,
                    onSelect: onAdd,
                  },
              {
                label: "Add to a project…",
                hint: blocked ? "Some files can’t be copied" : "Reviewed before it installs",
                icon: "download",
                disabled: blocked || busy,
                onSelect: onUse,
              },
            ],
            managed
              ? [
                  {
                    label: "Update…",
                    hint: `From ${managed.library}`,
                    icon: "refresh",
                    onSelect: () => onReview({ kind: "update", keys: [managed.key], title: s.name }),
                  },
                  {
                    label: "Remove from this machine…",
                    hint: "Only what Habi installed",
                    icon: "trash",
                    danger: true,
                    onSelect: () => onReview({ kind: "remove", keys: [managed.key], title: s.name }),
                  },
                ]
              : [],
          ]}
        />
      </span>
    </li>
  );
}

export function OnThisMachine({ page = false }: { page?: boolean }) {
  const alwaysShow = page;
  const machine = useMachineSkills();
  const operations = useMachineHistory();
  // Agents and tools Habi installed: one file or a command, in no skill folder.
  const installations = useMachineInstallations();
  const others = (installations.data ?? []).filter((i) => i.kind === "agent" || i.kind === "tool");
  const [history, setHistory] = useState(false);
  const [query, setQuery] = useState("");
  const [onlyUpdates, setOnlyUpdates] = useState(false);
  const { navigate } = useNav();
  const { addSkills } = useActions();
  const client = useQueryClient();
  const [using, setUsing] = useState<LocalSkill | null>(null);
  const [warning, setWarning] = useState<MachineGroup | null>(null);
  // Each row is busy on its own; a second click on a busy row is ignored before it can import twice.
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const working = useRef(new Set<string>());
  const [review, setReview] = useState<ReviewRequest | null>(null);
  const [error, setError] = useState<unknown>(null);

  // A folder Habi cannot read is not worth a broken page: show nothing.
  const found = groupMachineSkills(machine.data ?? []);
  const updates = found.filter(hasUpdate).length;
  const q = query.trim().toLowerCase();
  const shown = found
    .filter((g) => !(onlyUpdates && updates > 0) || hasUpdate(g))
    .filter(
      (g) =>
        !q ||
        `${g.skill.name} ${g.skill.description} ${g.copies.find((s) => s.managed)?.managed?.library ?? ""}`
          .toLowerCase()
          .includes(q),
    )
    .sort((a, b) => Number(hasUpdate(b)) - Number(hasUpdate(a)));
  if (
    !alwaysShow &&
    found.length === 0 &&
    others.length === 0 &&
    !operations.data?.length &&
    !operations.isError
  )
    return null;

  /** Puts the skill in My skills if it is not there, then opens the dialog that chooses the project. */
  const bringToProject = async (group: MachineGroup) => {
    const s = group.skill;
    if (working.current.has(s.id)) return;
    working.current.add(s.id);
    setBusy(new Set(working.current));
    setWarning(null);
    setError(null);
    try {
      let id = group.importedAs;
      if (!id) {
        const from: ImportFrom = { type: "machine", id: s.id };
        const inspection = await api.inspectImport(from);
        const only = inspection.candidates[0];
        // Anything that needs a decision (an identifier already used, files that
        // cannot be copied) goes through the dialog that asks.
        if (!only || only.duplicate !== null || !only.complete || !only.files.includes("SKILL.md")) {
          addSkills({ source: "machine", id: s.id });
          return;
        }
        const outcome = await api.importSkills(from, [{ path: only.path, rename: null }]);
        invalidateSkills(client);
        id = outcome.imported[0]?.id ?? null;
        if (!id) throw new Error(outcome.skipped[0]?.reason ?? "Habi could not copy the skill.");
      }
      setUsing(await api.getSkill(id));
    } catch (e) {
      setError(e);
    } finally {
      working.current.delete(s.id);
      setBusy(new Set(working.current));
    }
  };

  const lead = `${plural(found.length, "skill")} in your own folders, available across projects. Highlighted agents are the ones chosen for Habi installations; other skills show which agents can read them.`;
  return (
    <section className={page ? "mach is-page" : "mach"} aria-labelledby="on-this-machine">
      {page ? (
        <header className="mys-head">
          <div className="mys-intro">
            <h1 className="page-title" id="on-this-machine">
              On this machine
            </h1>
            <p className="mys-lead mach-lead">
              {machine.isSuccess ? lead : "Skills in your own folders, available across projects."}
            </p>
          </div>
          <div className="mys-actions">
            <Button icon="history" onClick={() => setHistory(true)}>
              History and restore…
            </Button>
          </div>
        </header>
      ) : (
        <header className="mach-head">
          <h2 className="mach-heading" id="on-this-machine">
            On this machine
            <span className="mach-total">{found.length}</span>
          </h2>
          <Button size="sm" icon="history" onClick={() => setHistory(true)}>
            History and restore…
          </Button>
          <p className="mach-lead">{lead}</p>
        </header>
      )}
      {error ? <ErrorNotice title="The skill could not be copied" error={error} /> : null}
      {alwaysShow && machine.isPending ? <Working>Reading global skills…</Working> : null}
      {alwaysShow && machine.isError ? (
        <ErrorNotice error={machine.error} title="Could not read machine skills" />
      ) : null}
      {operations.isError ? (
        <ErrorNotice error={operations.error} title="Could not load machine history" />
      ) : null}
      {found.length > 0 ? (
        <div className="mys-tools mach-tools">
          <label className="mys-search mach-search">
            <Icon name="search" size={14} />
            <input
              id="machine-skill-search"
              type="search"
              aria-label="Find a global skill"
              placeholder="Find a global skill"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <span className="mys-kbd" aria-hidden="true">
              /
            </span>
          </label>
          {updates > 0 ? (
            <fieldset className="mys-facets">
              <legend className="visually-hidden">Show</legend>
              <button
                type="button"
                aria-pressed={!onlyUpdates}
                className={onlyUpdates ? undefined : "is-on"}
                onClick={() => setOnlyUpdates(false)}
              >
                All<span className="mys-count">{found.length}</span>
              </button>
              <button
                type="button"
                aria-pressed={onlyUpdates}
                className={onlyUpdates ? "is-on" : undefined}
                onClick={() => setOnlyUpdates(true)}
              >
                Updates<span className="mys-count">{updates}</span>
              </button>
            </fieldset>
          ) : null}
        </div>
      ) : null}
      {q && shown.length === 0 ? (
        <p className="mys-empty">
          No global skill matches “{query}”.{" "}
          <button type="button" className="link-btn" onClick={() => setQuery("")}>
            Clear search
          </button>
        </p>
      ) : null}
      <ul className="mach-rows" aria-label="Skills on this machine">
        {shown.map((g) => (
          <Row
            key={g.key}
            group={g}
            busy={busy.has(g.skill.id)}
            onAdd={() => addSkills({ source: "machine", id: g.skill.id })}
            onOpen={(id) => navigate({ name: "skills", skillId: id })}
            onUse={() => (homeMention(g) ? setWarning(g) : void bringToProject(g))}
            onReview={setReview}
          />
        ))}
      </ul>
      {others.length > 0 ? (
        <ul className="mach-rows" aria-label="Agents and tools on this machine">
          {others.map((i) => (
            <li className="mach-item" key={i.key}>
              <div className="mach-main">
                <span className={`mach-title${i.kind === "tool" ? " mono" : ""}`}>
                  {i.title}
                  <span className="mach-tag">{kindLabel[i.kind]}</span>
                  {managedState[i.state] ? (
                    <span className="mach-tag is-state">{managedState[i.state]}</span>
                  ) : null}
                </span>
                <span className="mys-purpose">
                  {i.kind === "tool"
                    ? `A command on your PATH, from ${i.sourceName}`
                    : `From ${i.sourceName}, for ${i.clients.map((c) => clientLabel[c]).join(", ")}`}
                </span>
              </div>
              <span className="mach-acts">
                <Menu
                  label={`More for ${i.title}`}
                  items={[
                    [
                      {
                        label: "Update…",
                        hint: `From ${i.sourceName}`,
                        icon: "refresh",
                        onSelect: () => setReview({ kind: "update", keys: [i.key], title: i.title }),
                      },
                      {
                        label: "Remove from this machine…",
                        hint: "Only what Habi installed",
                        icon: "trash",
                        danger: true,
                        onSelect: () => setReview({ kind: "remove", keys: [i.key], title: i.title }),
                      },
                    ],
                  ]}
                />
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {alwaysShow && found.length === 0 && others.length === 0 && !machine.isPending && !machine.isError ? (
        <p className="mys-empty">
          Nothing here yet. In a library, a skill’s <strong>Add to this machine…</strong> installs it for
          every project. Earlier changes stay in history.
        </p>
      ) : null}

      {warning ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setWarning(null);
          }}
          title={`${warning.skill.name} mentions folders on your machine`}
          description="A skill that points into your home folder works for you and breaks for a teammate."
          footer={
            <>
              <Button variant="quiet" onClick={() => setWarning(null)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={() => void bringToProject(warning)}>
                Continue anyway
              </Button>
            </>
          }
        >
          <p className="field-label">Found in</p>
          <ul className="mach-files mono">
            {warning.mentionsHome.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
          <p className="muted">
            Habi does not change the text. You can edit the copy in My skills first, and then use it.
          </p>
        </Dialog>
      ) : null}
      {review ? <ReviewDialog projectId={null} request={review} onClose={() => setReview(null)} /> : null}
      {history ? <History overview={null} onClose={() => setHistory(false)} /> : null}
      {using ? (
        <UseSkillDialog
          skill={using}
          onClose={() => setUsing(null)}
          onFix={() => {
            setUsing(null);
            navigate({ name: "skills", skillId: using.summary.id });
          }}
        />
      ) : null}
    </section>
  );
}
