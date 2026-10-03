/**
 * Whether the skill is ready, as one word with one place to look: Ready or
 * Draft in the bar, and behind it what that is made of — what still needs
 * doing (each with the way to it), what is done, and what is optional. The
 * identifier agents and install folders use lives here too: it is part of
 * being ready, rarely something to look at.
 */
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import type { SkillStanding } from "../../../bindings/SkillStanding";
import { Icon } from "../../../components/Icon";
import { Button } from "../../../components/ui";
import { plural } from "../../../lib/format";
import { useSkills } from "../../../lib/queries";
import { identifierProblem, slugify } from "../../../lib/skills";
import { type NavTarget, plainProblem, targetLabel } from "../../../lib/studioNav";
import type { SkillDraft } from "./useSkillDraft";

/** A panel under a button; outside clicks and Escape close it and focus returns. */
export function Popover({
  open,
  onClose,
  anchor,
  label,
  className,
  children,
}: {
  open: boolean;
  onClose: () => void;
  anchor: React.RefObject<HTMLElement | null>;
  label: string;
  className?: string;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() =>
      panel.current?.querySelector<HTMLElement>("button, input, [href], [tabindex]")?.focus(),
    );
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !anchor.current?.contains(t)) onClose();
    };
    window.addEventListener("pointerdown", away);
    return () => window.removeEventListener("pointerdown", away);
  }, [open, onClose, anchor]);
  if (!open) return null;
  return (
    <div
      ref={panel}
      role="dialog"
      aria-label={label}
      className={`sk-pop${className ? ` ${className}` : ""}`}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
          anchor.current?.focus();
        }
      }}
    >
      {children}
    </div>
  );
}

function Identifier({
  draft,
  standing,
  editing,
  setEditing,
}: {
  draft: SkillDraft;
  standing: SkillStanding | undefined;
  editing: boolean;
  setEditing: (on: boolean) => void;
}) {
  const { document, setDocument, title, trashed, skill } = draft;
  const [text, setText] = useState(document.name);
  const skills = useSkills();
  const input = useRef<HTMLInputElement>(null);
  const hintId = useId();
  useEffect(() => {
    if (editing) {
      setText(document.name);
      requestAnimationFrame(() => input.current?.select());
    }
  }, [editing, document.name]);

  const wanted = text.trim();
  const taken = (skills.data ?? []).some(
    (s) => s.id !== skill.summary.id && s.deletedAt === null && s.name === wanted,
  );
  const problem =
    identifierProblem(wanted) ?? (taken ? "Another of your skills uses this identifier." : null);
  const suggestion = slugify(title);
  const installed = standing?.installedIn ?? [];
  const apply = () => {
    if (problem) return;
    if (wanted !== document.name) setDocument((d) => ({ ...d, name: wanted }));
    setEditing(false);
  };

  if (!editing) {
    const nameProblem = identifierProblem(document.name);
    return (
      <span className="rd-ident">
        <code className={nameProblem ? "is-problem" : undefined}>{document.name || "not set"}</code>
        {!trashed ? (
          <button
            type="button"
            className="link-quiet"
            id="studio-identifier"
            onClick={() => setEditing(true)}
          >
            {document.name ? "Change" : "Set"}
          </button>
        ) : null}
      </span>
    );
  }
  return (
    <fieldset className="rd-ident-edit">
      <legend className="visually-hidden">Change the identifier</legend>
      <label className="visually-hidden" htmlFor="studio-identifier-input">
        name
      </label>
      <input
        ref={input}
        id="studio-identifier-input"
        className="input mono"
        value={text}
        spellCheck={false}
        autoComplete="off"
        aria-invalid={problem ? true : undefined}
        aria-describedby={hintId}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            apply();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            setEditing(false);
          }
        }}
      />
      <div className="rd-ident-actions">
        <Button size="sm" variant="primary" disabled={Boolean(problem)} onClick={apply}>
          Apply
        </Button>
        <Button size="sm" variant="quiet" onClick={() => setEditing(false)}>
          Cancel
        </Button>
      </div>
      <p id={hintId} className={problem ? "field-problem" : "field-hint"}>
        {problem ?? "Lowercase words joined by hyphens."}
        {suggestion && suggestion !== wanted ? (
          <>
            {" "}
            <button type="button" className="link-btn" onClick={() => setText(suggestion)}>
              Use <span className="mono">{suggestion}</span>
            </button>
          </>
        ) : null}
      </p>
      {installed.length > 0 && wanted !== document.name ? (
        <p className="field-hint rd-ident-warn">
          Installed in {installed.map((p) => p.projectName).join(", ")} as{" "}
          <span className="mono">{document.name}</span>. Those copies keep that name until you use it there
          again.
        </p>
      ) : null}
    </fieldset>
  );
}

export function readinessOf(draft: SkillDraft) {
  const errors = draft.skill.diagnostics.filter((d) => d.level === "error");
  const notes = draft.skill.diagnostics.filter((d) => d.level !== "error");
  return { errors, notes, ready: errors.length === 0 };
}

export function Readiness({
  draft,
  standing,
  identEditing,
  setIdentEditing,
  onFix,
  onWhen,
}: {
  draft: SkillDraft;
  standing: SkillStanding | undefined;
  identEditing: boolean;
  setIdentEditing: (on: boolean) => void;
  onFix: (t: NavTarget) => void;
  onWhen: () => void;
}) {
  const { skill, document, trashed } = draft;
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const { errors, notes, ready } = readinessOf(draft);
  // Asked to change the identifier from elsewhere (the palette, a problem): open here.
  useEffect(() => {
    if (identEditing) setOpen(true);
  }, [identEditing]);
  if (trashed) return <span className="rd-word is-trashed">In the trash</span>;

  const fix = (t: NavTarget) => {
    if (t.field === "identifier") return setIdentEditing(true);
    setOpen(false);
    onFix(t);
  };
  const checks: { done: boolean; label: string; detail?: ReactNode }[] = [
    { done: document.body.trim() !== "", label: "Instructions" },
    { done: document.description.trim() !== "", label: "Purpose" },
    {
      done: identifierProblem(document.name) === null,
      label: "Identifier",
      detail: (
        <Identifier draft={draft} standing={standing} editing={identEditing} setEditing={setIdentEditing} />
      ),
    },
    {
      done: ready,
      label: "A valid Agent Skills package",
      detail: <span className="rd-quiet">works without Habi</span>,
    },
  ];

  return (
    <span className="rd">
      <button
        ref={button}
        type="button"
        className={`rd-word${ready ? " is-ready" : " is-draft"}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="rd-dot" aria-hidden="true" />
        {ready ? "Ready" : "Draft"}
        {!ready ? <span className="rd-count"> · {plural(errors.length, "thing")} to finish</span> : null}
      </button>
      <Popover
        open={open}
        anchor={button}
        label={ready ? "Ready to use" : "What is left to do"}
        className="rd-pop"
        onClose={() => {
          setOpen(false);
          setIdentEditing(false);
        }}
      >
        <p className="rd-head">{ready ? "Ready to use" : "Draft"}</p>
        {errors.length > 0 ? (
          <section className="rd-group">
            <p className="rd-kicker">Needs attention</p>
            <ul className="rd-list">
              {errors.map((d, i) => {
                const p = plainProblem(d);
                return (
                  <li key={i} className="rd-item is-todo">
                    <span className="rd-mark" aria-hidden="true">
                      ○
                    </span>
                    <span>
                      {p.text}
                      {p.target ? (
                        <>
                          {" "}
                          <button
                            type="button"
                            className="link-btn"
                            onClick={() => p.target && fix(p.target)}
                          >
                            {targetLabel(p.target)}
                          </button>
                        </>
                      ) : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}
        <section className="rd-group">
          <ul className="rd-list">
            {checks.map((c) => (
              <li key={c.label} className={`rd-item${c.done ? " is-done" : " is-todo"}`}>
                <span className="rd-mark" aria-hidden="true">
                  {c.done ? <Icon name="check" size={12} /> : "○"}
                </span>
                <span className="rd-label">{c.label}</span>
                {c.detail ? <span className="rd-detail">{c.detail}</span> : null}
              </li>
            ))}
          </ul>
        </section>
        {notes.length > 0 || !skill.summary.hasApplicability ? (
          <section className="rd-group">
            <p className="rd-kicker">Optional</p>
            <ul className="rd-list">
              {!skill.summary.hasApplicability ? (
                <li className="rd-item is-optional">
                  <span className="rd-mark" aria-hidden="true">
                    ○
                  </span>
                  <span>
                    Habi won’t suggest it on its own.{" "}
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() => {
                        setOpen(false);
                        onWhen();
                      }}
                    >
                      Add signals
                    </button>
                  </span>
                </li>
              ) : null}
              {notes.map((d, i) => {
                const p = plainProblem(d);
                return (
                  <li key={i} className="rd-item is-optional">
                    <span className="rd-mark" aria-hidden="true">
                      ○
                    </span>
                    <span>
                      {p.text}
                      {p.target ? (
                        <>
                          {" "}
                          <button
                            type="button"
                            className="link-btn"
                            onClick={() => p.target && fix(p.target)}
                          >
                            {targetLabel(p.target)}
                          </button>
                        </>
                      ) : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}
      </Popover>
    </span>
  );
}
