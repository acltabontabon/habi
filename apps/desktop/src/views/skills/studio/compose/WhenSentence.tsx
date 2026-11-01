/**
 * When a skill gets used, as a sentence you edit where it stands. Click it and
 * type a technology, a package or a file: Habi offers what that could mean, and
 * the choice becomes part of the sentence. Backspace takes the last one out, the
 * way it would in any line of text. The rarer rules are one step further, for
 * those who want them.
 */
import { type KeyboardEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { type Proposal, proposeSignals, type Signal, signalClause } from "../../../../lib/materials";
import type { SkillDraft } from "../useSkillDraft";
import { addSignal, inferredSignal, removeSignal, signalsOf } from "../WhenToUse";

const same = (a: Signal, b: Signal) => a.kind === b.kind && a.value === b.value;

type Offer = Signal & { why: string };

export function WhenSentence({
  draft,
  onMore,
  children,
}: {
  draft: SkillDraft;
  /** Everything else: exceptions, required tools, rules by hand. */
  onMore: () => void;
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

  // Clicking away leaves the sentence as it stands.
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

  // Rules written by hand, or that can't be read, aren't this sentence's to change.
  if (!form.conditionsEditable || skill.metadataStatus === "invalid") {
    return (
      <div className="sk-when">
        <p>
          <button type="button" className="sk-when-open" onClick={onMore}>
            {skill.metadataStatus === "invalid"
              ? "Its rules for when to suggest it need attention"
              : "Habi suggests it by rules written by hand"}
          </button>
          .
        </p>
        {children}
      </div>
    );
  }

  const joiner = form.matchMode === "all" ? "and" : "or";
  return (
    <div className="sk-when" ref={root}>
      <p>
        {applies.length === 0 && !editing ? (
          <button type="button" className="sk-when-open" disabled={!canEdit} onClick={() => setEditing(true)}>
            You bring this in when you want it
          </button>
        ) : (
          <>
            <span>Habi suggests it when </span>
            {applies.map((s, i) => (
              <span key={`${s.kind}:${s.value}`}>
                {i > 0 ? (
                  <button
                    type="button"
                    className="sk-when-join"
                    disabled={!canEdit}
                    title={joiner === "and" ? "All of these must be true" : "Any of these is enough"}
                    onClick={() =>
                      setForm((f) => ({ ...f, matchMode: f.matchMode === "all" ? "any" : "all" }))
                    }
                  >
                    {joiner}
                  </button>
                ) : null}
                <span className="sk-when-token">
                  {signalClause(s)}
                  {canEdit ? (
                    <button
                      type="button"
                      aria-label={`Remove: ${signalClause(s)}`}
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
                placeholder={applies.length ? "and…" : "a tool, a package or a file is there"}
                aria-label="When Habi should suggest this skill"
                role="combobox"
                aria-expanded={offers.length > 0}
                aria-controls={`${id}-offers`}
                aria-activedescendant={offers[at] ? `${id}-${at}` : undefined}
                spellCheck={false}
                autoComplete="off"
                size={Math.max(text.length + 2, applies.length ? 6 : 30)}
                onChange={(e) => {
                  setText(e.target.value);
                  setAt(0);
                }}
                onKeyDown={onKey}
              />
            ) : canEdit ? (
              <>
                .
                <button
                  type="button"
                  className="sk-when-more"
                  aria-label="Add another"
                  onClick={() => setEditing(true)}
                >
                  +
                </button>
              </>
            ) : (
              "."
            )}
          </>
        )}
        {applies.length === 0 && !editing ? "." : ""}
      </p>
      {editing ? (
        <div className="sk-when-menu">
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
                  <span>{signalClause(o)}</span>
                  <em>{o.why}</em>
                </button>
              ))}
            </div>
          ) : (
            <p className="sk-when-hint">Type a tool like Playwright, a package, or a file pattern.</p>
          )}
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
