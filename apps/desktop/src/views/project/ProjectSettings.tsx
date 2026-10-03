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
import { Button, Notice } from "../../components/ui";
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
    try {
      await api.setExclusions(project.id, list);
      invalidateProjectData(client, project.id);
      toast.show("Saved. The project will be scanned again.");
      onClose();
    } catch (e) {
      toast.show(e instanceof Error ? e.message : String(e), "danger");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    try {
      await api.forgetProject(project.id);
      void client.invalidateQueries({ queryKey: keys.recent });
      onClose();
      navigate({ name: "welcome" });
      toast.show(`${project.name} removed from Habi. Nothing on disk was changed.`);
    } catch (e) {
      toast.show(`Could not remove ${project.name}: ${e instanceof Error ? e.message : String(e)}`, "danger");
    }
  };

  const retract = async (id: string) => {
    try {
      await api.retract(project.id, id);
      invalidateProjectData(client, project.id);
      toast.show("Correction removed. Recommendations use what Habi found again.");
    } catch (e) {
      toast.show(`Could not remove the correction: ${e instanceof Error ? e.message : String(e)}`, "danger");
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
                <Button size="sm" variant="quiet" onClick={() => void retract(d.id)}>
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
              <Button size="sm" variant="danger" onClick={() => void remove()}>
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
    </Dialog>
  );
}
