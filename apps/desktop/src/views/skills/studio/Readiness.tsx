/**
 * Where the skill stands, as one word with one place to look. Behind it are three
 * separate questions: is it a valid package, could the words be better, and can the
 * other skills it links to be found. Ready means the first and the last are fine;
 * suggestions never take that away. The identifier agents and install folders use
 * lives here too: it is part of being valid, rarely something to look at.
 */
import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Diagnostic } from "../../../bindings/Diagnostic";
import type { SkillStanding } from "../../../bindings/SkillStanding";
import { Icon } from "../../../components/Icon";
import { Button } from "../../../components/ui";
import type { Refinement } from "../../../lib/coach";
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
  // Held in a ref: callers pass a fresh onClose each render, and re-running
  // the effect would pull focus back to the first control while typing.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per opening.
  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() =>
      panel.current?.querySelector<HTMLElement>("button, input, [href], [tabindex]")?.focus(),
    );
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !anchor.current?.contains(t)) closeRef.current();
    };
    window.addEventListener("pointerdown", away);
    return () => window.removeEventListener("pointerdown", away);
  }, [open]);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const trigger = anchor.current;
      const popup = panel.current;
      if (!trigger || !popup) return;
      const rect = trigger.getBoundingClientRect();
      const gap = 12;
      const width = Math.min(390, window.innerWidth - gap * 2);
      popup.style.width = `${width}px`;
      popup.style.maxHeight = `${Math.max(100, window.innerHeight - gap * 2)}px`;
      const height = popup.getBoundingClientRect().height;
      popup.style.left = `${Math.max(gap, Math.min(rect.left, window.innerWidth - width - gap))}px`;
      const below = rect.bottom + 8;
      popup.style.top = `${Math.max(gap, Math.min(below + height <= window.innerHeight - gap ? below : rect.top - height - 8, window.innerHeight - height - gap))}px`;
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(place) : null;
    if (panel.current) observer?.observe(panel.current);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, anchor]);
  if (!open) return null;
  return createPortal(
    <div
      ref={panel}
      style={{ position: "fixed", right: "auto", overflowY: "auto", boxSizing: "border-box", zIndex: 100 }}
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
    </div>,
    window.document.body,
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
    // Without a name yet, one thing to say: where it will come from, or how to give it one.
    if (!document.name) {
      if (trashed) return <span className="rd-quiet">none</span>;
      if (!title.trim()) return <span className="rd-quiet">follows the title</span>;
      return (
        <span className="rd-ident">
          <button
            type="button"
            className="link-quiet"
            id="studio-identifier"
            onClick={() => setEditing(true)}
          >
            Set
          </button>
        </span>
      );
    }
    const nameProblem = identifierProblem(document.name);
    return (
      <span className="rd-ident">
        <code className={nameProblem ? "is-problem" : undefined}>{document.name}</code>
        {!trashed ? (
          <button
            type="button"
            className="link-quiet"
            id="studio-identifier"
            onClick={() => setEditing(true)}
          >
            Change
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

/**
 * A problem as the author would put it. A draft without a name is asked for
 * a title (its identifier follows), never told its frontmatter lacks `name`.
 */
function needWords(
  d: Diagnostic,
  draft: SkillDraft,
): { text: string; target: NavTarget | null; label?: string } {
  const p = plainProblem(d);
  if (p.target?.field === "description" && !draft.document.description.trim())
    return { ...p, text: "Describe what this skill helps with and when to use it." };
  if (p.target?.field === "identifier" && !draft.document.name) {
    return draft.title.trim()
      ? { text: "It needs an identifier.", target: { field: "identifier" }, label: "Set the identifier" }
      : {
          text: "Give this skill a title.",
          target: { field: "title" },
          label: "Give it a title",
        };
  }
  return p;
}

export type OtherSkill = { name: string; title: string; status: "found" | "unsure" | "missing" };

export function readinessOf(draft: SkillDraft) {
  const errors = draft.skill.diagnostics.filter((d) => d.level === "error");
  const notes = draft.skill.diagnostics.filter((d) => d.level !== "error");
  return { errors, notes, ready: errors.length === 0 };
}

/**
 * While a skill is not ready, the one thing to do next, in the words of the
 * fix: name it, then say what it is for, then whatever else is left. A skill
 * without a title is named by its title (the identifier follows it), not by
 * its identifier.
 */
export function nextStep(draft: SkillDraft): { label: string; target: NavTarget } | null {
  const { errors } = readinessOf(draft);
  if (errors.length === 0) return null;
  const problems = errors.map((d) => ({ d, p: plainProblem(d) }));
  const naming = problems.find((x) => x.p.target?.field === "identifier");
  if (naming && !draft.title.trim()) return { label: "Give it a title", target: { field: "title" } };
  if (naming) {
    return {
      label: draft.document.name ? "Fix the identifier" : "Set the identifier",
      target: { field: "identifier" },
    };
  }
  const purpose = problems.find((x) => x.p.target?.field === "description");
  if (purpose) {
    return {
      label: draft.document.description.trim() ? "Shorten the purpose" : "Add a purpose",
      target: { field: "description" },
    };
  }
  const first = problems.find((x) => x.p.target);
  return first?.p.target ? { label: targetLabel(first.p.target), target: first.p.target } : null;
}

export function Readiness({
  draft,
  standing,
  identEditing,
  setIdentEditing,
  onFix,
  better,
  onRefine,
  others,
  onOpenOther,
}: {
  draft: SkillDraft;
  standing: SkillStanding | undefined;
  identEditing: boolean;
  setIdentEditing: (on: boolean) => void;
  onFix: (t: NavTarget) => void;
  /** What would make it better beyond being valid, most useful first. */
  better: Refinement[];
  onRefine: (r: Refinement) => void;
  /** The skills this one links to, and whether they can be found. */
  others: OtherSkill[];
  onOpenOther: (name: string) => void;
}) {
  const { trashed } = draft;
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const { errors, notes, ready } = readinessOf(draft);
  const missing = others.filter((o) => o.status === "missing").length;
  // Asked to change the identifier from elsewhere (the palette, a problem): open here.
  useEffect(() => {
    if (identEditing) setOpen(false);
  }, [identEditing]);
  if (trashed) return <span className="rd-word is-trashed">In the trash</span>;

  const fix = (t: NavTarget) => {
    setOpen(false);
    if (t.field === "identifier") return setIdentEditing(true);
    onFix(t);
  };
  const headline = errors.length ? "Things to finish" : "Improve this skill";
  const improve = better.length + notes.length;

  return (
    <span className="rd">
      <button
        ref={button}
        type="button"
        className={`rd-word${!ready ? " is-draft" : missing > 0 ? " is-check" : " is-ready"}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
      >
        {!ready
          ? `${plural(errors.length, "thing")} to finish`
          : missing > 0
            ? `${plural(missing, "skill")} not found`
            : improve > 0
              ? `${improve} to improve`
              : "Skill details"}
      </button>
      <Popover
        open={open}
        anchor={button}
        label={headline}
        className="rd-pop studio-improvements"
        onClose={() => {
          setOpen(false);
          setIdentEditing(false);
        }}
      >
        <header className="studio-improvements-head">
          <h2>{headline}</h2>
          <button
            type="button"
            aria-label="Close improvements"
            onClick={() => {
              setOpen(false);
              setIdentEditing(false);
              button.current?.focus();
            }}
          >
            <Icon name="close" size={14} />
          </button>
        </header>
        <ul className="studio-improvement-list">
          {[...errors, ...notes].map((d, i) => {
            const p = needWords(d, draft);
            return (
              <li key={`diagnostic-${i}`}>
                {p.target ? (
                  <button
                    type="button"
                    className="studio-improvement-action"
                    aria-label={p.label ?? targetLabel(p.target)}
                    onClick={() => p.target && fix(p.target)}
                  >
                    <span>
                      <strong>{p.label ?? targetLabel(p.target)}</strong>
                      <small>{p.text}</small>
                    </span>
                    <Icon name="chevronRight" size={14} />
                  </button>
                ) : (
                  <p className="studio-improvement-note">{p.text}</p>
                )}
              </li>
            );
          })}
          {better.map((r) => {
            const action = r.kind === "unfinished" ? "Finish the placeholders" : r.action;
            const text = r.text;
            return (
              <li key={r.kind}>
                <button
                  type="button"
                  className="studio-improvement-action"
                  aria-label={action}
                  onClick={() => {
                    setOpen(false);
                    onRefine(r);
                  }}
                >
                  <span>
                    <strong>{action}</strong>
                    <small>{text}</small>
                  </span>
                  <Icon name="chevronRight" size={14} />
                </button>
              </li>
            );
          })}
          {others
            .filter((o) => o.status !== "found")
            .map((o) => (
              <li key={o.name}>
                <button
                  type="button"
                  className="studio-improvement-action"
                  onClick={() => {
                    setOpen(false);
                    onOpenOther(o.name);
                  }}
                >
                  <span>
                    <strong>Check {o.title}</strong>
                    <small>
                      {o.status === "missing"
                        ? "This linked skill could not be found."
                        : "Check that this linked skill is available."}
                    </small>
                  </span>
                  <Icon name="chevronRight" size={14} />
                </button>
              </li>
            ))}
        </ul>
        {errors.length === 0 && improve === 0 && others.every((o) => o.status === "found") ? (
          <p className="studio-improvement-note">No improvements to suggest right now.</p>
        ) : null}
      </Popover>
      <Popover
        open={identEditing}
        anchor={button}
        label="Fix the skill identifier"
        className="rd-pop studio-improvements"
        onClose={() => setIdentEditing(false)}
      >
        <header className="studio-improvements-head">
          <h2>Fix the skill identifier</h2>
          <button
            type="button"
            aria-label="Close identifier editor"
            onClick={() => {
              setIdentEditing(false);
              button.current?.focus();
            }}
          >
            <Icon name="close" size={14} />
          </button>
        </header>
        <Identifier draft={draft} standing={standing} editing={identEditing} setEditing={setIdentEditing} />
      </Popover>
    </span>
  );
}
