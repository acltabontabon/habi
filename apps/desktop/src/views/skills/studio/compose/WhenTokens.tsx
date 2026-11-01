/**
 * What a skill is for, as tokens under its purpose: Java, Playwright, a file. Add
 * one by typing, take one out with its × or with Backspace, the way a line of tags
 * works anywhere. The rarer rules are one step further, for those who want them.
 */
import { type KeyboardEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  type Proposal,
  proposeSignals,
  type Signal,
  signalClause,
  signalToken,
} from "../../../../lib/materials";
import type { SkillDraft } from "../useSkillDraft";
import { addSignal, inferredSignal, removeSignal, signalsOf } from "../WhenToUse";

const same = (a: Signal, b: Signal) => a.kind === b.kind && a.value === b.value;

type Offer = Signal & { why: string };

export function WhenTokens({
  draft,
  onMore,
  children,
}: {
  draft: SkillDraft;
  /** Everything else: exceptions, required tools, rules by hand. */
  onMore: () => void;
  /** Where it would be suggested. */
  children?: ReactNode;
}) {
  const { form, setForm, trashed, skill } = draft;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const id = useId();

  const { applies } = signalsOf(form);
  const canEdit = form.conditionsEditable && skill.metadataStatus !== "invalid" && !trashed;
  const inferred = inferredSignal(draft);

  const offers: Offer[] = useMemo(() => {
    const proposed: Proposal[] = proposeSignals(text);
    const seed = !text.trim() && inferred ? [{ ...inferred, why: "The instructions talk about it" }] : [];
    return [...seed, ...proposed].filter((o) => !applies.some((a) => same(a, o)));
  }, [text, inferred, applies]);

  useEffect(() => {
    if (editing) input.current?.focus();
  }, [editing]);

  // Clicking away leaves the tokens as they stand.
  useEffect(() => {
    if (!editing) return;
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) {
        setEditing(false);
        setText("");
      }
    };
    window.addEventListener("pointerdown", away);
    return () => window.removeEventListener("pointerdown", away);
  }, [editing]);

  const add = (s: Signal) => {
    setForm((f) => addSignal(f, s));
    setText("");
    setAt(0);
    input.current?.focus();
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setAt((a) => Math.min(a + 1, offers.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setAt((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const offer = offers[at];
      if (offer) add(offer);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setEditing(false);
      setText("");
    } else if (e.key === "Backspace" && text === "") {
      const last = applies[applies.length - 1];
      if (last) setForm((f) => removeSignal(f, last));
    }
  };

  // Rules written by hand, or that can't be read, aren't these tokens' to change.
  if (!form.conditionsEditable || skill.metadataStatus === "invalid") {
    const invalid = skill.metadataStatus === "invalid";
    return (
      <div className="sk-when">
        <button
          type="button"
          className={`sk-when-token is-rules${invalid ? " is-bad" : ""}`}
          onClick={onMore}
        >
          {invalid ? "Rules need attention" : "Custom rules"}
        </button>
        {children}
      </div>
    );
  }

  const joiner = form.matchMode === "all" ? "and" : "or";
  return (
    <div className="sk-when" ref={root}>
      {applies.map((s, i) => (
        <span key={`${s.kind}:${s.value}`} className="sk-when-item">
          {i > 0 ? (
            <button
              type="button"
              className="sk-when-join"
              disabled={!canEdit}
              title={joiner === "and" ? "All of these must be true" : "Any of these is enough"}
              onClick={() => setForm((f) => ({ ...f, matchMode: f.matchMode === "all" ? "any" : "all" }))}
            >
              {joiner}
            </button>
          ) : null}
          <span
            className={`sk-when-token${s.kind === "tag" ? "" : " is-code"}`}
            title={`Suggested when ${signalClause(s)}`}
          >
            {signalToken(s)}
            {canEdit ? (
              <button
                type="button"
                aria-label={`Remove ${signalToken(s)}`}
                onClick={() => setForm((f) => removeSignal(f, s))}
              >
                ×
              </button>
            ) : null}
          </span>
        </span>
      ))}
      {editing ? (
        <input
          ref={input}
          className="sk-when-input"
          value={text}
          placeholder="Java, a package, a file…"
          aria-label="What this skill is for"
          role="combobox"
          aria-expanded={offers.length > 0}
          aria-controls={`${id}-offers`}
          aria-activedescendant={offers[at] ? `${id}-${at}` : undefined}
          spellCheck={false}
          autoComplete="off"
          size={Math.max(text.length + 2, 22)}
          onChange={(e) => {
            setText(e.target.value);
            setAt(0);
          }}
          onKeyDown={onKey}
        />
      ) : canEdit ? (
        <button
          type="button"
          className={`sk-when-add${applies.length === 0 ? " is-empty" : ""}`}
          aria-label={applies.length ? "Add another" : "Suggest for…"}
          onClick={() => setEditing(true)}
        >
          <span aria-hidden="true">+</span>
          {applies.length === 0 ? <span aria-hidden="true">Suggest for…</span> : null}
        </button>
      ) : null}
      {editing ? (
        <div className="sk-when-menu">
          {applies.length === 0 && !text ? (
            <p className="sk-when-lead">Optional. Projects that have this get the skill suggested.</p>
          ) : null}
          {offers.length ? (
            <div id={`${id}-offers`} role="listbox" aria-label="What that could mean">
              {offers.map((o, i) => (
                <button
                  key={`${o.kind}:${o.value}`}
                  type="button"
                  id={`${id}-${i}`}
                  role="option"
                  aria-selected={i === at}
                  tabIndex={-1}
                  className={i === at ? "is-active" : undefined}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setAt(i)}
                  onClick={() => add(o)}
                >
                  <span>{signalToken(o)}</span>
                  <em>{o.why}</em>
                </button>
              ))}
            </div>
          ) : null}
          <button
            type="button"
            className="sk-when-advanced"
            onMouseDown={(e) => e.preventDefault()}
            onClick={onMore}
          >
            Exceptions and other rules
          </button>
        </div>
      ) : null}
      {children}
    </div>
  );
}
