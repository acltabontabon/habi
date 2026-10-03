/**
 * On this machine: skills kept in the person's own folders (`~/.claude/skills`
 * and the like). They sit apart from My skills because they are not Habi's:
 * the agents own those files and Habi only reads them, so nothing here can be
 * edited or removed. The two ways out are copies — into My skills, or into a
 * project through the usual reviewed install — and the original is never
 * touched. Where a project holds a copy too, the row says which one a client
 * will use. Nothing is shown when there are no such skills.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { ImportFrom } from "../../bindings/ImportFrom";
import type { LocalSkill } from "../../bindings/LocalSkill";
import { AgentReach } from "../../components/AgentReach";
import { Dialog } from "../../components/Dialog";
import { Loom } from "../../components/Loom";
import { Menu } from "../../components/Menu";
import { Button, ErrorNotice, Status } from "../../components/ui";
import { useActions } from "../../lib/actions";
import { api } from "../../lib/api";
import { clientLabel, plural } from "../../lib/format";
import {
  copyState,
  groupMachineSkills,
  homeMention,
  type MachineGroup,
  precedenceNote,
} from "../../lib/machine";
import { useNav } from "../../lib/nav";
import { invalidateSkills, useMachineSkills } from "../../lib/queries";
import { purpose } from "../../lib/skills";
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
  return (
    <AgentReach
      lit={group.readers}
      tip={(c, on) => {
        const from = group.copies.filter((s) => s.readers.includes(c)).map((s) => s.location);
        return on
          ? `${clientLabel[c]} reads ${from.join(" and ")}`
          : `${clientLabel[c]} does not read these folders`;
      }}
    />
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
      <span className="mach-main">
        <span className="mach-title">
          {s.name}
          <span className="mach-tag">Global</span>
          {group.isLink ? <span className="mach-tag">Link</span> : null}
          {managed && managedState[managed.state] ? (
            <span className="mach-tag is-state">{managedState[managed.state]}</span>
          ) : null}
        </span>
        <span className="mys-purpose">
          {s.description ? purpose(s.description) : <span className="mys-none">No purpose yet</span>}
        </span>
        <Reach group={group} />
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
            Some of its files cannot be copied (links or oversized files), so Habi will not import it.
          </span>
        ) : null}
      </span>
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
                label: "Use in a project…",
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

export function OnThisMachine() {
  const machine = useMachineSkills();
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
  if (found.length === 0) return null;

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

  return (
    <section className="mach" aria-labelledby="on-this-machine">
      <header className="mach-head">
        <p className="kicker" id="on-this-machine">
          On this machine
        </p>
        <p className="mach-lead">
          {plural(found.length, "skill")} in your own folders. Habi only reads them: copy one to keep it here,
          or to put it in a project your team shares.
        </p>
      </header>
      {error ? <ErrorNotice error={error} /> : null}
      <ul className="mach-rows" aria-label="Skills on this machine">
        {found.map((g) => (
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
