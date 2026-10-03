/**
 * A project's settings: paths to leave out, the corrections the person
 * made, what Habi could not read, and letting the project go. The facts
 * themselves show where they matter — beside each recommendation.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ProjectOverview } from "../../bindings/ProjectOverview";
import { Dialog } from "../../components/Dialog";
import { useToast } from "../../components/Toasts";
import { Button, ErrorNotice, Notice } from "../../components/ui";
import { api } from "../../lib/api";
import { plural } from "../../lib/format";
import { useNav } from "../../lib/nav";
import { invalidateProjectData, keys } from "../../lib/queries";
import { tagLabel } from "./ProjectView";

export function ProjectSettings({ overview, onClose }: { overview: ProjectOverview; onClose: () => void }) {
  const { inspection, project } = overview;
  const client = useQueryClient();
  const toast = useToast();
  const [exclusions, setExclusions] = useState(project.exclusions.join("\n"));
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  /** "remove", or the correction being undone. */
  const [busy, setBusy] = useState<string | null>(null);
  // A toast would sit behind this dialog, out of reach: failures show here instead.
  const [failure, setFailure] = useState<{ title: string; error: unknown } | null>(null);
  const { navigate } = useNav();
  const list = exclusions
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const changed = list.join("\n") !== project.exclusions.join("\n");
  const gaps = inspection.coverage.filter((c) => c.status !== "complete");
  const skipped = inspection.scan.directoriesSkipped;

  const save = async () => {
    setSaving(true);
    setFailure(null);
    try {
      await api.setExclusions(project.id, list);
      invalidateProjectData(client, project.id);
      toast.show("Saved. The project will be scanned again.");
      onClose();
    } catch (e) {
      setFailure({ title: "Not saved", error: e });
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (busy) return;
    setBusy("remove");
    setFailure(null);
    try {
      await api.forgetProject(project.id);
    } catch (e) {
      setFailure({ title: `Could not remove ${project.name}`, error: e });
      setBusy(null);
      return;
    }
    void client.invalidateQueries({ queryKey: keys.recent });
    onClose();
    navigate({ name: "welcome" });
    toast.show(`${project.name} removed from Habi. Nothing on disk was changed.`);
  };

  const retract = async (id: string) => {
    if (busy) return;
    setBusy(id);
    setFailure(null);
    try {
      await api.retract(project.id, id);
      invalidateProjectData(client, project.id);
      toast.show("Correction removed. Recommendations use what Habi found again.");
    } catch (e) {
      setFailure({ title: "Could not remove the correction", error: e });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Project settings"
      description={`${plural(inspection.scan.filesSeen, "file name")} read in ${inspection.scan.elapsedMs} ms. Nothing is built or run.`}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Close
          </Button>
          <Button variant="primary" disabled={!changed} busy={saving} onClick={() => void save()}>
            Save and rescan
          </Button>
        </>
      }
    >
      <label className="field">
        <span className="field-label">Leave out</span>
        <textarea
          className="input mono"
          rows={4}
          value={exclusions}
          onChange={(e) => setExclusions(e.target.value)}
          placeholder={"legacy/**\nfixtures/big-repo/**"}
          spellCheck={false}
        />
        <span className="field-hint">
          One glob per line, relative to the project.
          {skipped.length > 0 ? ` Already skipped: ${skipped.join(", ")}.` : ""} Files that may hold secrets
          are never read.
        </span>
      </label>

      {overview.declarations.length > 0 ? (
        <section className="scan-section" aria-labelledby="scan-corrections">
          <h3 id="scan-corrections" className="field-label">
            Your corrections
          </h3>
          <ul className="scan-corrections">
            {overview.declarations.map((d) => (
              <li key={d.id}>
                <span>
                  {d.subject.type === "tag" ? tagLabel(d.subject.tag) : d.subject.name}{" "}
                  <strong>{d.present ? "present" : "absent"}</strong>
                  <span className="muted"> · {d.module === "*" ? "whole repository" : d.module}</span>
                  {d.note ? <span className="muted"> — “{d.note}”</span> : null}
                </span>
                <Button size="sm" variant="quiet" busy={busy === d.id} onClick={() => void retract(d.id)}>
                  Undo
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {inspection.scan.unreadable.length > 0 ? (
        <Notice tone="warn" title="Some paths could not be read">
          <span className="mono">{inspection.scan.unreadable.slice(0, 5).join(", ")}</span>
        </Notice>
      ) : null}
      {gaps.map((g) => (
        <Notice
          key={`${g.module}:${g.area}`}
          tone={g.status === "failed" ? "danger" : "unknown"}
          title={`${g.area} is ${g.status}${g.module === "." ? "" : ` in ${g.module}`}`}
        >
          {g.notes.map((n) => (
            <p key={n}>{n}</p>
          ))}
        </Notice>
      ))}

      <section className="settings-leave" aria-labelledby="settings-leave">
        <h3 id="settings-leave" className="field-label">
          Remove from Habi
        </h3>
        {removing ? (
          <div className="settings-leave-confirm">
            <p>Remove {project.name} from Habi? Its folder and files stay exactly as they are.</p>
            <div className="settings-leave-actions">
              <Button size="sm" variant="quiet" onClick={() => setRemoving(false)}>
                Keep it
              </Button>
              <Button size="sm" variant="danger" busy={busy === "remove"} onClick={() => void remove()}>
                Remove
              </Button>
            </div>
          </div>
        ) : (
          <div className="settings-leave-confirm">
            <p className="muted">
              It leaves the list. Nothing on disk changes, and you can open it again anytime.
            </p>
            <Button size="sm" variant="quiet" onClick={() => setRemoving(true)}>
              Remove…
            </Button>
          </div>
        )}
      </section>
      {failure ? <ErrorNotice error={failure.error} title={failure.title} /> : null}
    </Dialog>
  );
}
