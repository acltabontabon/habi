/**
 * Bringing a library skill into a project: choose the project, then the
 * usual review (agents, every file, confirm). Projects where the library
 * already fits come first.
 */
import { useState } from "react";
import type { LibraryItem } from "../../bindings/LibraryItem";
import { Dialog } from "../../components/Dialog";
import { Button } from "../../components/ui";
import { useActions } from "../../lib/actions";
import { useRecentProjects } from "../../lib/queries";
import { ReviewDialog } from "../review/ReviewDialog";

export function AddToProjectDialog({ item, onClose }: { item: LibraryItem; onClose: () => void }) {
  const projects = useRecentProjects();
  const { openProject } = useActions();
  const available = (projects.data ?? [])
    .filter((p) => p.exists)
    .sort((a, b) => {
      const fits = (p: typeof a) => (p.summary?.sources.includes(item.sourceId) ? 0 : 1);
      return fits(a) - fits(b);
    });
  const [projectId, setProjectId] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const chosen = projectId || available[0]?.id || "";

  if (reviewing && chosen) {
    return (
      <ReviewDialog
        projectId={chosen}
        request={{
          kind: "install",
          items: [{ sourceId: item.sourceId, itemId: item.id }],
          title: item.title,
        }}
        onClose={onClose}
      />
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Add “${item.title}” to a project`}
      description="Copied into the folders your agents read. Installing does not run anything."
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!chosen} onClick={() => setReviewing(true)}>
            Choose agents and review…
          </Button>
        </>
      }
    >
      {available.length === 0 ? (
        <div className="dialog-empty">
          <p>Open the project first. Habi only reads it until you confirm a change.</p>
          <Button icon="folder" onClick={() => void openProject({ stay: true })}>
            Open a project…
          </Button>
        </div>
      ) : (
        <fieldset className="field">
          <legend className="field-label">Project</legend>
          <div className="choice-rows">
            {available.map((p) => (
              <label key={p.id} className={`choice-row${chosen === p.id ? " is-on" : ""}`}>
                <input
                  type="radio"
                  name="add-to-project"
                  checked={chosen === p.id}
                  onChange={() => setProjectId(p.id)}
                />
                <span className="choice-body">
                  <span className="choice-head">
                    <span className="choice-title">{p.name}</span>
                    {p.summary?.sources.includes(item.sourceId) ? (
                      <span className="choice-note mono">library fits here</span>
                    ) : null}
                  </span>
                  <span className="choice-detail mono">{p.path}</span>
                </span>
              </label>
            ))}
          </div>
          <Button size="sm" variant="quiet" icon="folder" onClick={() => void openProject({ stay: true })}>
            Open another project…
          </Button>
        </fieldset>
      )}
    </Dialog>
  );
}
