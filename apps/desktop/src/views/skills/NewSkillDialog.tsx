/** Start a draft: a name is enough. Works offline, with or without a project. */
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { SkillTemplate } from "../../bindings/SkillTemplate";
import { Dialog } from "../../components/Dialog";
import { Button, ErrorNotice } from "../../components/ui";
import { api } from "../../lib/api";
import { useNav } from "../../lib/nav";
import { invalidateSkills } from "../../lib/queries";
import { slugify } from "../../lib/skills";

const templates: { id: SkillTemplate; label: string; detail: string }[] = [
  { id: "blank", label: "Blank", detail: "Just the title and an empty page." },
  { id: "reviewProcedure", label: "Review procedure", detail: "Before you start · Review steps · Report." },
  { id: "implementationGuide", label: "Implementation guide", detail: "Context · Steps · Done when." },
];

export function NewSkillDialog({
  projectId,
  projectName,
  initialTitle = "",
  initialTemplate = "blank",
  onClose,
}: {
  projectId?: string;
  projectName?: string;
  initialTitle?: string;
  initialTemplate?: SkillTemplate;
  onClose: () => void;
}) {
  const { navigate } = useNav();
  const client = useQueryClient();
  const [title, setTitle] = useState(initialTitle);
  const [description, setDescription] = useState("");
  const [template, setTemplate] = useState<SkillTemplate>(initialTemplate);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const skill = await api.createSkill({ title: title.trim(), description, template }, projectId ?? null);
      invalidateSkills(client);
      onClose();
      navigate({ name: "skills", skillId: skill.summary.id });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const identifier = slugify(title);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Create a skill"
      description="A draft on this machine. It is not installed or shared until you choose to."
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={busy} onClick={() => void create()}>
            Create draft
          </Button>
        </>
      }
    >
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy) void create();
        }}
      >
        {error ? <ErrorNotice error={error} title="The draft could not be created" /> : null}
        <label className="field">
          <span className="field-label">What is it called?</span>
          <input
            className="input"
            value={title}
            autoFocus
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Database migration review"
          />
          <span className="field-hint">
            {identifier ? (
              <>
                Identifier <span className="mono">{identifier}</span> — you can change it later.
              </>
            ) : (
              "You can name it later."
            )}
          </span>
        </label>
        <label className="field">
          <span className="field-label">
            What does it help with, and when should an agent use it?{" "}
            <span className="muted">(optional now)</span>
          </span>
          <textarea
            className="input"
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Reviews Liquibase changesets for locking and rollback risk. Use when a change adds or edits a changelog."
          />
        </label>
        <fieldset className="field">
          <legend className="field-label">Start with</legend>
          <div className="choice-rows">
            {templates.map((t) => (
              <label key={t.id} className={`choice-row${template === t.id ? " is-on" : ""}`}>
                <input
                  type="radio"
                  name="template"
                  checked={template === t.id}
                  onChange={() => setTemplate(t.id)}
                />
                <span>
                  <span className="choice-title">{t.label}</span>
                  <span className="choice-detail">{t.detail}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        {projectName ? (
          <p className="muted">
            Written for <strong>{projectName}</strong>: the editor will offer conditions observed in that
            project, one by one. None is added for you.
          </p>
        ) : null}
        {/* Enter in a text field submits. */}
        <button type="submit" className="visually-hidden" tabIndex={-1} aria-hidden="true">
          Create draft
        </button>
      </form>
    </Dialog>
  );
}
